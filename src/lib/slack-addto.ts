/**
 * "Add to…" (owner, 2026-10-14): a message in a listened channel (#kaizen-ops, #kgp-team) gets a
 * private, silent reply — add it as a comment to a task, or to a purchase order, a work order or a
 * claim. No model reads the messages (the owner: one that reads everything is money given away); the
 * first guess is by words — the listing's code, the claim's or task's own words. Pure.
 */
type Block = Record<string, unknown>;
const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75), emoji: true });
const mrk = (text: string) => ({ type: 'mrkdwn', text: text.slice(0, 3000) });

export interface AddTarget { value: string; label: string; group: 'task' | 'order' | 'work_order' | 'claim'; words: string;
  /** Worked on in the last days — breaks a tie. */ recent?: boolean }
export interface AddSource { channel: string; ts: string; thread?: string | null }

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'has', 'are', 'was', 'you', 'can', 'not', 'but', 'about',
  'they', 'them', 'her', 'his', 'she', 'him', 'our', 'out', 'all', 'any', 'get', 'got', 'one', 'two', 'will', 'just', 'need', 'needs',
  'please', 'pls', 'thanks', 'also', 'into', 'there', 'their', 'what', 'when', 'where', 'who', 'why', 'how', 'today', 'tomorrow',
  'que', 'los', 'las', 'con', 'por', 'para', 'una', 'del', 'est', 'esta', 'este', 'pero', 'como', 'hay']);

/** Words worth matching: 3+ letters, no stop words, unit codes (P2-4308, CL2260) kept whole. */
export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/<[^>]*>/g, ' ').match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])]
    .filter(w => w.length >= 3 && !STOP.has(w));
}
const isCode = (w: string) => /\d/.test(w) && /[a-z]/.test(w);

/**
 * The likeliest target for a message, or null: a shared unit code counts 4, a shared word 2,
 * a word that starts the other ("shan" ~ "shannon") 1 — so "Shan Eviction" beats "evict Shan" for
 * "the Shan eviction" (2026-10-14, a tie that offered nothing). What the channel last added to (the
 * last hour) counts 3 by itself; recent work breaks a tie. At least 3, and ahead of the next.
 */
export function suggestTarget(text: string, targets: AddTarget[], last?: string | null): AddTarget | null {
  const mine = wordsOf(text);
  if (!mine.length && !last) return null;
  const scored = targets.map(t => {
    const theirs = wordsOf(t.words);
    let n = 0;
    for (const w of mine) {
      if (theirs.includes(w)) n += isCode(w) ? 4 : 2;
      else if (w.length >= 4 && theirs.some(x => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) n += 1;
    }
    // Owner, 2026-10-14: what this channel was last adding to (the last hour) — a conversation keeps its topic.
    if (t.value === last) n += 3;
    // Worked on lately: only breaks a tie.
    if (n > 0 && t.recent) n += 0.5;
    return { t, n };
  }).sort((a, b) => b.n - a.n);
  const [best, next] = scored;
  return best && best.n >= 3 && best.n > (next?.n ?? 0) ? best.t : null;
}

const GROUPS: [AddTarget['group'], string][] = [['order', '🛒 Purchase orders'], ['work_order', '🔧 Work orders'], ['claim', '⚑ Claims']];

/** The private reply. The source message rides in the block ids (Slack gives them back on the click). */
export function addToBlocks(targets: AddTarget[], source: AddSource, suggested?: AddTarget | null): Block[] {
  const src = `${source.channel}|${source.ts}|${source.thread ?? ''}`;
  const opt = (t: AddTarget) => ({ text: plain(t.label), value: t.value });
  const tasks = targets.filter(t => t.group === 'task').slice(0, 100);
  const groups = GROUPS.map(([g, label]) => ({ label: plain(label), options: targets.filter(t => t.group === g).slice(0, 100).map(opt) }))
    .filter(g => g.options.length);
  return [
    { type: 'section', text: mrk(suggested ? `🔒 Add this to *${suggested.label.replace(/[<>&*]/g, '')}*?` : '🔒 Add this to Kaizen?'),
      ...(suggested ? { accessory: { type: 'button', action_id: 'addto_yes', value: suggested.value, text: plain('✓ Add'), style: 'primary' } } : {}),
      block_id: `addto_s|${src}` },
    { type: 'actions', block_id: `addto_a|${src}`, elements: [
      // Owner, 2026-10-14: the guess comes chosen in its menu — ✓ Add takes it; picking another adds that one.
      ...(tasks.length ? [{ type: 'static_select', action_id: 'addto_task', placeholder: plain('Add as comment to task…'), options: tasks.map(opt),
                            ...(suggested?.group === 'task' && tasks.some(t => t.value === suggested.value) ? { initial_option: opt(suggested) } : {}) }] : []),
      ...(groups.length ? [{ type: 'static_select', action_id: 'addto_other', placeholder: plain('Add to something else…'), option_groups: groups,
                             ...(suggested && suggested.group !== 'task' && groups.some(g => g.options.some(o => o.value === suggested.value)) ? { initial_option: opt(suggested) } : {}) }] : []),
      { type: 'button', action_id: 'addto_dismiss', value: 'x', text: plain('✕ Not this') }
    ] },
    { type: 'context', elements: [mrk('Only you see this. Later, react :paperclip: to a reply in its thread to add that one too.')] }
  ];
}

/** The source message back from a block id. */
export function sourceOf(blockId: string): AddSource | null {
  const [, channel, ts, thread] = blockId.split('|');
  return channel && ts ? { channel, ts, thread: thread || null } : null;
}
