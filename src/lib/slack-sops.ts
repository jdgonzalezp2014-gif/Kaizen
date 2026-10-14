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
  const first = clean[0]?.text.split('\n')[0]?.replace(/[*_~`]/g, '').trim() ?? '';
  return { ...EMPTY, title: first.slice(0, 80), steps: clean.flatMap(m => linesOf(m.text, 60)).slice(0, 60) };
}

/** What the model is asked: only the conversation and the sections; nothing invented. */
export function sopPrompt(sections: SopSectionLite[], messages: { who: string; text: string }[]) {
  const system = [
    'You turn a team conversation from a short-term-rental company into a Standard Operating Procedure.',
    'Answer ONLY with JSON: {"title": string, "sectionKey": string, "purpose": string, "trigger": string, "owner": string,',
    '"steps": string[], "doneWhen": string, "rules": string[]}.',
    'title: short, a name for the procedure. sectionKey: one of the given keys. purpose: why it exists, one or two sentences.',
    'trigger: when it applies. owner: the role that runs it, if the conversation says; else "". steps: in order, imperative, one action each.',
    'doneWhen: how to know it is finished. rules: "If … → …" decisions stated in the conversation.',
    'Use only what the conversation says. Do not invent policies, amounts or names; leave a field "" or [] when it is not there.',
    'Write in English.'
  ].join('\n');
  const user = `Sections (key: label):\n${sections.map(s => `${s.key}: ${s.label}`).join('\n')}\n\nConversation:\n` +
    messages.map(m => `${m.who}: ${redact(slackText(m.text))}`).join('\n').slice(0, 12000);
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
