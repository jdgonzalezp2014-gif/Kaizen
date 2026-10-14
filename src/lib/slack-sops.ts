/**
 * SOPs from Slack (owner, 2026-10-14) — pure: the form, the library's sections, a section's
 * list, one SOP to read, and what the model is asked when ✨ Suggest turns a thread into a
 * draft. Saved through /api/sops like Kaizen's own editor, in the §151 format: the fields,
 * then "## Rules" (if → then) as the body's last header.
 */
import { esc } from './slack.ts';

type Block = Record<string, unknown>;
const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75), emoji: true });
const mrk = (text: string) => ({ type: 'mrkdwn', text: text.slice(0, 3000) });
const section = (text: string, accessory?: Block): Block => ({ type: 'section', text: mrk(text), ...(accessory ? { accessory } : {}) });
const context = (text: string): Block => ({ type: 'context', elements: [mrk(text)] });
const button = (text: string, action_id: string, value: string, style?: 'primary'): Block =>
  ({ type: 'button', text: plain(text), action_id, value, ...(style ? { style } : {}) });

export interface SopSectionLite { key: string; label: string; parentKey?: string | null }
export interface SopDraft { title: string; sectionKey: string; purpose: string; trigger: string; owner: string; steps: string[]; doneWhen: string; rules: string[] }
export interface SopSource { channel: string; ts: string; link?: string | null }

const EMPTY: SopDraft = { title: '', sectionKey: '', purpose: '', trigger: '', owner: '', steps: [], doneWhen: '', rules: [] };

/** Lines into steps or rules: bullets and "1." / "2)" numbering dropped, blanks out. */
export function linesOf(text: string, max = 60): string[] {
  return text.split('\n').map(l => l.replace(/^\s*(?:[-*•·]\s+|\d{1,2}[.)]\s*)/, '').trim()).filter(Boolean).map(l => l.slice(0, 600)).slice(0, max);
}

/** Phones and emails out before a thread leaves for a model (guests are named in threads). */
export function redact(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
             .replace(/\+?\d(?:[\s().-]{0,2}\d){6,}/g, '[phone]');
}

/** Slack's markup into plain words: <@U…> → @someone, <url|label> → label. */
export const slackText = (t: string) => t.replace(/<@[A-Z0-9]+>/g, '@someone').replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/<([^>]+)>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The thread as it was said — the form's starting point, before any model. */
export function draftFromThread(messages: { who: string; text: string }[]): SopDraft {
  const clean = messages.map(m => ({ who: m.who, text: slackText(m.text).trim() })).filter(m => m.text);
  // The title: the first line with words, mentions left out (a message opening "@Derek" gave "@someone", 2026-10-14).
  const first = messages.flatMap(m => m.text.replace(/<@[A-Z0-9]+>/g, '').split('\n')).map(l => slackText(l).replace(/[*_~`]/g, '').trim())
    .find(l => /[a-z]{3}/i.test(l)) ?? '';
  return { ...EMPTY, title: first.slice(0, 80), steps: clean.flatMap(m => linesOf(m.text, 60)).slice(0, 60) };
}

/**
 * What the model is asked: the conversation, the sections, and what the person already wrote — nothing
 * invented. It also grades how complete the SOP is and asks, politely, for what is missing (owner,
 * 2026-10-14: "shorten with no refund" said nothing about what to tell the guest or what if they say yes —
 * an assistant reading it later would be as lost). Tapping ✨ again re-grades what was added.
 */
export function sopPrompt(sections: SopSectionLite[], messages: { who: string; text: string }[], current?: Partial<SopDraft> | null) {
  const system = [
    'You turn a team conversation from a short-term-rental company into a Standard Operating Procedure.',
    'How to read the conversation: someone usually ASKS (a case, a question) and someone with authority DECIDES (admin or',
    'manager, shown after the name). The SOP is the DECISION turned into a general rule — not the question, not one guest\'s case.',
    'Write the decision in plain words with its consequence for each party, not in the team\'s shorthand: e.g. never "no change in',
    'payout" in a step or rule — write "the guest is not refunded for the nights they no longer use".',
    'Glossary (short-term rentals): payout = what the company receives for the booking. "No change in payout" / "keep the payout" =',
    'the guest is NOT refunded for nights they do not use. Shorten = move the checkout earlier in Hostaway; the freed nights can be',
    'booked again. Early check-in / late checkout = arriving before / leaving after the standard time. Turnover = the clean between',
    'guests. Hostaway = the reservations system (it syncs Airbnb, Vrbo, Booking). Kaizen = the operations app.',
    'Answer ONLY with JSON: {"title": string, "sectionKey": string, "purpose": string, "trigger": string, "owner": string,',
    '"steps": string[], "doneWhen": string, "rules": string[], "score": number, "gaps": string[]}.',
    'title: short, a name for the procedure. sectionKey: one of the given keys. purpose: why it exists, one or two sentences.',
    'trigger: when it applies. owner: a ROLE (e.g. "Guest communications", "Operations manager") — never a person\'s name; "" if unknown.',
    'steps: in order, imperative, one action each, naming the system where it happens (Hostaway, Airbnb, Kaizen) when known.',
    'doneWhen: how to know it is finished. rules: "If … → …" decisions stated in the conversation.',
    'Use only what the conversation and the current draft say (and the glossary, to understand them). Do not invent policies,',
    'amounts or names; leave a field "" or [] when it is not there.',
    'If a current draft is given, keep what the person wrote and only tidy it or add what the conversation says.',
    'score: be strict. Start at 0 and add 1 for each of these that the SOP really covers (a vague mention does not count):',
    '(a) when it applies and who does it; (b) every step, in order, with the system where it is done; (c) what to tell the guest or the',
    'other party — the words or the key points — in a polite tone that protects reviews; (d) what to do for each likely answer or',
    'exception (they accept, they refuse, they insist, they threaten a bad review); (e) how it is closed and recorded (Hostaway, the',
    'calendar, payouts, Kaizen). Minimum 1. A two-step SOP that never says what to tell the guest is a 1 or a 2.',
    'gaps: up to 5 short, friendly, specific questions to the author, one per missing point above, about THIS procedure.',
    'Never question a decision the conversation already made (if it says "no change in payout", do not ask whether to refund);',
    'ask how to carry it out. Example: "What do we tell the guest when we shorten the stay but cannot adjust the payout, so it does',
    'not turn into a bad review?". [] when nothing is missing.',
    'Write in English.'
  ].join('\n');
  const has = current && Object.values(current).some(v => Array.isArray(v) ? v.length : v);
  const user = `Sections (key: label):\n${sections.map(s => `${s.key}: ${s.label}`).join('\n')}\n\nConversation:\n` +
    messages.map(m => `${m.who}: ${redact(slackText(m.text))}`).join('\n').slice(0, 12000) +
    (has ? `\n\nCurrent draft (written by the person — keep it):\n${redact(JSON.stringify(current)).slice(0, 8000)}` : '');
  return { system, user };
}

/** A model's answer, checked: strings trimmed, lists of strings, a section that exists. */
export function draftFromAi(j: Record<string, unknown>, sections: SopSectionLite[]): SopDraft {
  const str = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const list = (v: unknown) => Array.isArray(v) ? v.map(x => str(x, 600)).filter(Boolean).slice(0, 60) : typeof v === 'string' ? linesOf(v) : [];
  const key = str(j.sectionKey, 80);
  return { title: str(j.title, 160), sectionKey: sections.some(s => s.key === key) ? key : '', purpose: str(j.purpose, 2000), trigger: str(j.trigger, 1000),
           owner: str(j.owner, 120), steps: list(j.steps), doneWhen: str(j.doneWhen, 1000), rules: list(j.rules) };
}

/** The model's grade: 1–5 and the questions to ask, or nothing when it gave none. */
export function reviewFromAi(j: Record<string, unknown>): { score: number | null; gaps: string[] } {
  const n = Math.round(Number(j.score));
  return { score: n >= 1 && n <= 5 ? n : null,
           gaps: Array.isArray(j.gaps) ? j.gaps.map(g => typeof g === 'string' ? g.trim().slice(0, 300) : '').filter(Boolean).slice(0, 5) : [] };
}

/** The grade as the form shows it: polite, and pointing at where to add it. */
export function reviewNote(by: string, r: { score: number | null; gaps: string[] }): string {
  const head = `✨ Suggested by ${by} — check every field before saving.`;
  if (r.score === null && !r.gaps.length) return head;
  const grade = r.score !== null ? `*Completeness: ${r.score}/5*${r.score >= 5 ? ' — anyone could follow this. 🙌' : ' — to make it something anyone (or an assistant) can follow without asking:'}` : '*To make it complete:*';
  return [head, grade, ...r.gaps.map(g => `• ${g}`),
          ...(r.gaps.length ? ['_Add the answers in Steps or Rules, then tap ✨ again to re-check._'] : [])].join('\n');
}

/** What is typed in the form so far, unchecked — for ✨ to keep and build on. */
export function partialSopForm(values: Record<string, Record<string, Record<string, unknown>>>): Partial<SopDraft> {
  const s = (name: string) => String(fieldOf(values, name)?.value ?? '').trim();
  return { title: s('title'), sectionKey: String((fieldOf(values, 'section')?.selected_option as { value?: string } | undefined)?.value ?? ''),
           purpose: s('purpose'), trigger: s('trigger'), owner: s('owner'), steps: linesOf(s('steps')), doneWhen: s('done'), rules: linesOf(s('rules')) };
}

/** §151: rules go in the body under "## Rules" — its last header, so an assistant finds them by name. */
export const sopBody = (rules: string[]) => rules.length ? `## Rules\n${rules.map(r => `- ${r}`).join('\n')}` : null;

/**
 * The form. Block ids carry a version: Slack keeps what was typed in a block it already
 * shows, so a suggestion lands only in new blocks. `fieldOf` reads them back.
 */
export function sopModal(sections: SopSectionLite[], d: Partial<SopDraft>, o: { canPublish: boolean; source?: SopSource | null; note?: string; v?: number } = { canPublish: false }): Block {
  const v = o.v ?? 0;
  const x = { ...EMPTY, ...d };
  const text = (block: string, label: string, initial: string, opts: { multiline?: boolean; optional?: boolean; hint?: string } = {}): Block => ({
    type: 'input', block_id: `${block}_${v}`, label: plain(label), optional: opts.optional ?? true,
    element: { type: 'plain_text_input', action_id: 'v', multiline: !!opts.multiline, ...(initial ? { initial_value: initial.slice(0, 3000) } : {}) },
    ...(opts.hint ? { hint: plain(opts.hint) } : {})
  });
  const opts = sections.slice(0, 100).map(s => ({ text: plain(s.parentKey ? `— ${s.label}` : s.label), value: s.key }));
  const init = opts.find(op => op.value === x.sectionKey);
  return {
    type: 'modal', callback_id: 'sop_save', title: plain('New SOP'), submit: plain('Save'), close: plain('Cancel'),
    private_metadata: JSON.stringify({ source: o.source ?? null, v }),
    blocks: [
      ...(o.note ? [context(o.note)] : []),
      ...(o.source ? [{ type: 'actions', block_id: 'sop_ai', elements: [button('✨ Suggest with AI', 'sop_suggest', 'go', 'primary')] },
                      context(`From ${o.source.link ? `<${o.source.link}|this thread>` : 'this thread'} — ✨ reads it and fills the form; you check it before saving.`)] : []),
      text('title', 'Title', x.title, { optional: false }),
      { type: 'input', block_id: `section_${v}`, label: plain('Section'), optional: false,
        element: { type: 'static_select', action_id: 'v', options: opts, ...(init ? { initial_option: init } : {}) } },
      text('purpose', 'Purpose — why it exists', x.purpose, { multiline: true }),
      text('trigger', 'When it applies', x.trigger),
      text('owner', 'Owner (role)', x.owner),
      text('steps', 'Steps — one per line', x.steps.join('\n'), { multiline: true, optional: false }),
      text('done', 'Done when', x.doneWhen),
      text('rules', 'Rules — one per line (If … → …)', x.rules.join('\n'), { multiline: true }),
      ...(o.canPublish ? [{ type: 'input', block_id: `publish_${v}`, optional: true, label: plain('Publish'),
        element: { type: 'checkboxes', action_id: 'v', options: [{ text: plain('Publish now (else a draft for an editor to review)'), value: 'yes' }] } }]
        : [context('Saved as a *draft*: someone who edits SOPs publishes it in Kaizen.')])
    ]
  };
}

/** A field of the form, whatever version of its blocks is on screen. */
export function fieldOf(values: Record<string, Record<string, Record<string, unknown>>>, name: string): Record<string, unknown> | undefined {
  const k = Object.keys(values).find(b => b.startsWith(`${name}_`));
  return k ? values[k]?.v : undefined;
}

/** The form back into a draft — or the field to fix. */
export function readSopForm(values: Record<string, Record<string, Record<string, unknown>>>):
  { draft: SopDraft; publish: boolean } | { error: { block: string; message: string } } {
  const s = (name: string) => String(fieldOf(values, name)?.value ?? '').trim();
  const block = (name: string) => Object.keys(values).find(b => b.startsWith(`${name}_`)) ?? name;
  const draft: SopDraft = { title: s('title').slice(0, 160), sectionKey: String((fieldOf(values, 'section')?.selected_option as { value?: string } | undefined)?.value ?? ''),
    purpose: s('purpose'), trigger: s('trigger'), owner: s('owner').slice(0, 120), steps: linesOf(s('steps')), doneWhen: s('done'), rules: linesOf(s('rules')) };
  if (!draft.title) return { error: { block: block('title'), message: 'A title, please.' } };
  if (!draft.sectionKey) return { error: { block: block('section'), message: 'Pick a section.' } };
  if (!draft.steps.length) return { error: { block: block('steps'), message: 'At least one step.' } };
  const publish = ((fieldOf(values, 'publish')?.selected_options as unknown[] | undefined) ?? []).length > 0;
  return { draft, publish };
}

/** @Kaizen sops — the library: a button per section that has SOPs, and the way to Kaizen. */
export function sopsBlocks(sections: (SopSectionLite & { n: number })[], appUrl?: string): Block[] {
  const shown = sections.filter(s => s.n > 0 && !s.parentKey);
  const total = shown.reduce((a, s) => a + s.n, 0);
  const buttons = shown.slice(0, 25).map(s => button(`${s.label} · ${s.n}`, 'sops_section', s.key));
  return [
    section(`📚 *SOPs* — ${total} to read${appUrl ? ` · <${appUrl}/?tab=sops|Open the library in Kaizen>` : ''}`),
    ...(buttons.length ? [{ type: 'actions', elements: buttons }] : [section('_Nothing published yet._')]),
    context('*@Kaizen newsop* _title_ — write one · ⋯ on a message → *Make SOP from this*')
  ];
}

/** One section's SOPs, each to open. */
export function sopListModal(label: string, sops: { id: string; title: string; purpose?: string | null; status: string }[]): Block {
  return {
    type: 'modal', callback_id: 'sops_list', title: plain(label.slice(0, 24)), close: plain('Close'),
    blocks: sops.length ? sops.slice(0, 50).map(s => section(`*${esc(s.title)}*${s.status === 'draft' ? ' · _draft_' : ''}${s.purpose ? `\n${esc(s.purpose).slice(0, 200)}` : ''}`,
      button('Read', 'sop_view', s.id))) : [section('_Nothing here yet._')]
  };
}

/** One SOP, to read in Slack. */
export function sopViewModal(s: { id: string; title: string; status: string; purpose?: string | null; trigger?: string | null; owner?: string | null;
                                  doneWhen?: string | null; steps: { text: string; who?: string }[]; body?: string | null }, appUrl?: string): Block {
  const facts = [s.trigger ? `*When:* ${esc(s.trigger)}` : '', s.owner ? `*Owner:* ${esc(s.owner)}` : '', s.doneWhen ? `*Done when:* ${esc(s.doneWhen)}` : ''].filter(Boolean);
  return {
    type: 'modal', callback_id: 'sop_read', title: plain('SOP'), close: plain('Close'),
    blocks: [
      section(`*${esc(s.title)}*${s.status === 'draft' ? ' · _draft_' : ''}${s.purpose ? `\n${esc(s.purpose)}` : ''}`),
      ...(facts.length ? [context(facts.join(' · '))] : []),
      ...(s.steps.length ? [{ type: 'divider' }, section(s.steps.map((x, i) => `${i + 1}. ${esc(x.text)}${x.who ? ` _(${esc(x.who)})_` : ''}`).join('\n'))] : []),
      ...(s.body ? [{ type: 'divider' }, section(esc(s.body).replace(/^## (.+)$/gm, '*$1*').slice(0, 2900))] : []),
      ...(appUrl ? [context(`<${appUrl}/?sop=${encodeURIComponent(s.id)}|Open in Kaizen>`)] : [])
    ]
  };
}

/* ── @Kaizen help <question> (owner, 2026-10-14): the SOPs answer, or the thread is asked to write one ── */

export interface SopDoc { id: string; title: string; purpose?: string | null; trigger?: string | null; steps: { text: string }[]; body?: string | null; section?: string }

const words = (t: string) => [...new Set((t.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter(w => w.length >= 3))];

/** The SOPs most likely to answer, by words — so the model reads a few, not the whole library. */
export function rankSops(question: string, sops: SopDoc[], max = 8): SopDoc[] {
  const q = words(question);
  return sops.map(s => {
    const title = words(s.title), rest = words([s.purpose, s.trigger, s.section, ...s.steps.map(x => x.text), s.body].filter(Boolean).join(' '));
    let n = 0;
    for (const w of q) n += title.some(x => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) ? 3 : rest.includes(w) ? 1 : 0;
    return { s, n };
  }).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, max).map(x => x.s);
}

/** What the model is asked: only these SOPs; which answer the question, and a short answer from them. */
export function helpPrompt(question: string, sops: SopDoc[]) {
  const system = [
    'You answer a team member\'s question from the company\'s SOPs (short-term rentals). Use ONLY the SOPs given; never invent.',
    'Answer ONLY with JSON: {"ids": string[], "answer": string, "covers": "full" | "partial" | "none", "missing": string}.',
    'ids: the ids of the SOPs that ANSWER THIS QUESTION, best first (at most 3). Be strict: an SOP about a nearby topic does',
    'not count (a question about refunding an early checkout is not answered by an SOP about logging claims, nor by one about the',
    'clean after an early departure). If no SOP says what to do about exactly this, return [] — the team will write one.',
    'answer: 1–4 short sentences that answer it from those SOPs, in the language of the question; "" when ids is [].',
    'covers: "full" if the SOPs say what to do about exactly this; "partial" if they cover only part (e.g. how to log a refund',
    'request, but not whether we refund this case); "none" if nothing. missing: what the SOPs do not say, as a short phrase',
    '(e.g. "whether we refund the nights of an early checkout"); "" when covers is "full".'
  ].join('\n');
  const user = `Question: ${redact(question).slice(0, 1000)}\n\nSOPs:\n` + sops.map(s => [
    `[${s.id}] ${s.title}${s.section ? ` (${s.section})` : ''}`,
    s.purpose ? `Purpose: ${s.purpose}` : '', s.trigger ? `When: ${s.trigger}` : '',
    s.steps.length ? `Steps: ${s.steps.map((x, i) => `${i + 1}. ${x.text}`).join(' ')}` : '', s.body ? s.body : ''
  ].filter(Boolean).join('\n').slice(0, 1800)).join('\n\n');
  return { system, user };
}

/** The model's pick, checked against what it was shown. */
export function helpFromAi(j: Record<string, unknown>, shown: SopDoc[]): { sops: SopDoc[]; answer: string; covers: 'full' | 'partial' | 'none'; missing: string } {
  const ids = Array.isArray(j.ids) ? j.ids.map(String) : [];
  const sops = ids.map(id => shown.find(s => s.id === id)).filter((s): s is SopDoc => !!s).slice(0, 3);
  const covers = !sops.length ? 'none' : j.covers === 'partial' ? 'partial' : j.covers === 'none' ? 'none' : 'full';
  return { sops: covers === 'none' ? [] : sops, answer: covers !== 'none' && typeof j.answer === 'string' ? j.answer.trim().slice(0, 1200) : '',
           covers, missing: covers === 'full' ? '' : typeof j.missing === 'string' ? j.missing.trim().slice(0, 200) : '' };
}

/**
 * The answer in the thread: what the SOPs say, and each to read. Covering only part of it, the thread is
 * asked for the rest — and can become the SOP (owner, 2026-10-14: "do we refund an early checkout?" found
 * only how to log a refund request).
 */
export function helpAnswerBlocks(answer: string, sops: SopDoc[], appUrl?: string, gap?: { missing: string; from: { channel: string; root: string } } | null): Block[] {
  return [
    section(`📚 ${esc(answer)}`),
    ...sops.map(s => section(`*${esc(s.title)}*${s.purpose ? `\n${esc(s.purpose).slice(0, 160)}` : ''}`, button('Read', 'sop_view', s.id))),
    ...(gap ? [section(`🙋 The SOPs don't say ${gap.missing ? `*${esc(gap.missing)}*` : 'the rest'}. Whoever knows — please explain it here in this thread, then tap the button and Kaizen turns it into an SOP.`),
               { type: 'actions', elements: [{ ...button('📝 Write it as SOP', 'mention_new_sop', JSON.stringify({ title: '', from: gap.from })), style: 'primary' }] }] : []),
    context(`From the SOPs${appUrl ? ` · <${appUrl}/?tab=sops|Open the library>` : ''}${gap ? '' : ' · not right? Explain it here and *@Kaizen newsop* turns it into one.'}`)
  ];
}

/** No SOP covers it: the thread is asked, and can become the SOP. */
export function helpMissingBlocks(question: string, from: { channel: string; root: string }): Block[] {
  return [
    section(`📭 No SOP covers this yet: _${esc(question).slice(0, 200)}_\n🙋 Whoever knows how we do it — please explain it here in this thread. Then tap the button (or *@Kaizen newsop*) and Kaizen turns the thread into an SOP, so nobody has to ask again.`),
    { type: 'actions', elements: [{ ...button('📝 Write it as SOP', 'mention_new_sop', JSON.stringify({ title: '', from })), style: 'primary' }] }
  ];
}
