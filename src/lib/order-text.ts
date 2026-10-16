/**
 * "@Kaizen order 2 paper towels and 1 Tide for LP-4212" (owner, 2026-10-15): a purchase order from free text.
 * Each line is matched to a supply by its words (or an alias a person taught); a doubtful one is never guessed —
 * the draft asks, with the closest items as buttons, or "+ Add as new item". The place is asked unless the text
 * names a storage or closet exactly. Nothing is saved until Confirm (agents draft, humans send). Pure.
 *
 * A pasted list works too (owner, same day: a new unit's setup, 58 lines under a paragraph): one line = one item,
 * the lines that read as prose are skipped and counted. The draft lives in `slack_order_drafts` (095) — the
 * Confirm button carries its id — and a message holds 50 blocks, so what is settled is a text list with one
 * "Change a line…" menu; only the questions get buttons, and what is not in Kaizen is added all at once.
 */
import { aliasKey, scoreItems, words, type ReceiptItem, type ReceiptLine } from './receipt.ts';
import { cartLinks, type BuyOption } from './store-order.ts';
import { esc, guessUnit, kaizenButton, type Opt } from './slack.ts';

type Block = Record<string, unknown>;
const mrk = (text: string) => ({ type: 'mrkdwn', text: text.slice(0, 3000) });
const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75), emoji: true });
const section = (text: string, accessory?: Block): Block => ({ type: 'section', text: mrk(text), ...(accessory ? { accessory } : {}) });
const context = (text: string): Block => ({ type: 'context', elements: [mrk(text)] });
const button = (text: string, action_id: string, value: string, style?: 'primary' | 'danger'): Block =>
  ({ type: 'button', text: plain(text), action_id, value, ...(style ? { style } : {}) });

export interface NewItem { name: string; kind: 'supply' | 'furniture'; measure: string }
/** One line of the draft (short keys: it is kept as JSON). */
export interface DraftLine {
  /** What was written for it. */ t: string;
  /** How many. */ q: number;
  /** The supply, once sure or picked. */ i: string | null;
  /** The closest supplies, best first (kept so "Change" can offer them again). */ c: string[];
  /** "+ Add as new item": made on Confirm. */ n?: NewItem;
  /** Already on the to-do's order at that place: add to it, or replace it. */ m?: 'sum' | 'replace';
  /** Picked by a person — taught as an alias on Confirm. */ p?: 1;
  /** Sent back to a question by "Change a line…" — asked one by one even with nothing alike. */ x?: 1;
  /** What the AI thinks it is, when it is not in Kaizen: the new-item forms start from it. */ s?: NewItem;
}
export interface OrderDraft {
  /** Who asked (Slack user). */ by: string;
  /** Channel, the thread it lives in, and the message that asked. */ ch: string; root: string; msg: string;
  /** The to-do of this thread (a task, a cleaner's request, an inspection's order) — the lines go on it. */ todo: string | null;
  /** This thread's claim: the new to-do is for it. */ claim: string | null;
  /** Storage, closet or house key — asked unless written exactly. */ place: string | null;
  /** What came after "for"/"para" when it was not a place (a unit, said back so the person picks its place). */ said: string | null;
  /** The listing named in the text — for a new to-do. */ unit: string | null;
  /** Lines of a pasted list that read as prose, not items. */ sk?: number;
  /** Who read it: "✨ Read by <model>", or why the rules did (the AI did not answer). */ ai?: string;
  lines: DraftLine[];
}
export type OrderLine = { itemId: string; place: string; qty: number };

const MAX_LINES = 80;
const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, docena: 12
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "2 paper towels", "2sets of bowls", "paper towels x3", "two Tide", "una escoba" → the words and how many (1 when not said). */
export function lineQty(chunk: string): { text: string; qty: number } {
  let t = chunk.trim().replace(/^[-•*]\s*/, '');
  let qty = 1;
  const lead = t.match(/^(\d+(?:\.\d+)?)\s*(?:x\s+|×\s*)?([a-z(][\s\S]*)$/i);
  const trail = t.match(/^(.+?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)$/i);
  const word = t.match(/^([a-z]+)\s+(.+)$/i);
  if (lead) { qty = Number(lead[1]); t = lead[2]!; }
  else if (trail) { qty = Number(trail[2]); t = trail[1]!; }
  else if (word && NUMBERS[word[1]!.toLowerCase()] != null) { qty = NUMBERS[word[1]!.toLowerCase()]!; t = word[2]!; }
  t = t.replace(/^(?:of|de)\s+/i, '').trim();
  return { text: t.slice(0, 100), qty: qty > 0 && Number.isFinite(qty) ? Math.ceil(qty) : 1 };
}

/** In a pasted list, an item is a line that starts with how many, or a short one; "New unit setup:" and a paragraph are not. */
const isItemLine = (l: string) => /^[-•*]?\s*\d/.test(l) || NUMBERS[(l.match(/^[-•*]?\s*([a-z]+)\s/i)?.[1] ?? '').toLowerCase()] != null
  || (l.split(/\s+/).length <= 6 && !/[:.]$/.test(l));

/**
 * The text split into lines and where it goes. Several lines = a list: one item per line, prose skipped. One
 * line: split at "," ";" "+" "and" "y" "&". A trailing "for/para/to/at/en <X>" is taken off only when X is a
 * place (then it is the place), or a listing or a place without its "closet"/"(house)" — "LP-4212" (then it is
 * said back, and the place is still asked — owner: always ask). The Repository says LP-4212 where Hostaway says
 * P2-4212, so a place also knows its listing.
 */
export function parseOrderText(text: string, places: { key: string; name: string; unit?: string | null }[], units: Opt[]) {
  let t = text.replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<([^>]+)>/g, '$1').trim();
  let place: string | null = null, said: string | null = null, unit: string | null = null;
  const rows = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (rows.length > 1) {
    const items = rows.filter(isItemLine);
    return { lines: items.map(lineQty).filter(l => l.text).slice(0, MAX_LINES), place, said, unit: guessUnit(text, units), skipped: rows.length - items.length };
  }
  const tail = t.match(/^([\s\S]*\S)\s+(?:for|para|to|at|en|in)\s+(?:the\s+|el\s+|la\s+)?([^,;\n]+?)[\s.!]*$/i);
  if (tail) {
    const x = tail[2]!.trim();
    const hit = places.find(p => norm(p.name) === norm(x));
    const base = places.find(p => norm(p.name.replace(/\s+(closet|\(house\))$/i, '')) === norm(x));
    if (hit) { place = hit.key; unit = hit.unit ?? null; t = tail[1]!; }
    else if (guessUnit(x, units) || base) { said = x; unit = base?.unit ?? null; t = tail[1]!; }
  }
  const lines = t.split(/\s*(?:[,;+&]|\s(?:and|y)\s)\s*/i).map(c => c.trim()).filter(Boolean).map(lineQty).filter(l => l.text).slice(0, MAX_LINES);
  return { lines, place, said, unit: guessUnit(text, units) ?? unit, skipped: 0 };
}

// How it is packed and joining words say nothing about WHAT it is ("2 sets of bowls" is bowls — not "Sheet sets").
const FILLER = new Set(['set', 'pack', 'case', 'box', 'boxe', 'pair', 'of', 'with', 'and', 'the', 'de', 'pk', 'ct', 'y']);
/** The words that name the thing: no parentheses, no packing words, plurals as singular. */
export const coreWords = (text: string) => words(text.replace(/\([^)]*\)/g, ' ')).filter(w => !FILLER.has(w));

/**
 * A line's supply: an alias a person taught, or the ONE item whose every name word is in the line and whose
 * name holds the line's last word (what it is) — "queen mattresses" is not "Comforter — Queen", "paper towel
 * holders" is not "Paper towels". Anything else is a question, with the closest three; nothing alike = not in Kaizen.
 */
export function matchOrderLine(text: string, items: ReceiptItem[], aliases: Map<string, string> = new Map()): { i: string | null; c: string[] } {
  const t = coreWords(text);
  const scored = t.length ? scoreItems(t.join(' '), items) : [];
  const c = scored.slice(0, 3).map(x => x.id);
  const taught = aliases.get(aliasKey(text));
  if (taught && items.some(i => i.id === taught && i.active !== false)) return { i: taught, c };
  const head = t[t.length - 1];
  const whole = scored.filter(x => {
    const w = coreWords(items.find(i => i.id === x.id)?.name ?? '');
    return w.length > 0 && w.every(a => t.includes(a)) && !!head && w.includes(head);
  });
  return { i: whole.length === 1 ? whole[0]!.id : null, c };
}

/**
 * The AI's reading (owner, 2026-10-15: "la idea es apoyarse en IA" — `readRequestText`, the same as ✨ Build the cart)
 * as draft lines: its supply only when sure (a taught alias wins — `readReceipt`), else the supplies IT named as the
 * question's buttons — not ones added for sharing a word, so "sofa beds" is not asked about "Bed sheets" — and nothing
 * named = not in Kaizen, with the AI's name, type and measure ready for the new-item form.
 */
export function draftLinesFromRead(lines: ReceiptLine[]): DraftLine[] {
  return lines.filter(l => l.kind === 'item').map(l => {
    const t = l.text.slice(0, 100);
    // In the supply's measure when it is one (an 18-pack of washcloths = 18); a new item is counted as written ("2 (18 pack)" = 2 packs).
    const q = Math.max(1, Math.ceil((l.itemId ? l.itemQty : null) ?? l.qty ?? 1));
    if (l.itemId) return { t, q, i: l.itemId, c: [] };
    const s: NewItem = { name: itemName(l.newName ?? t), kind: l.newKind ?? guessKind(t), measure: l.newMeasure ?? guessMeasure(t) };
    return { t, q, i: null, c: (l.suggested ?? []).slice(0, 3), s };
  });
}

/* ── what is not in Kaizen yet: a name, a type and a measure guessed from the words, corrected in the form ── */
const PACK = /^(?:\(\s*\d+\s*(?:pack|pk|ct)\s*\)\s*(?:of\s+)?|(?:sets?|packs?|cases?|box(?:es)?|pairs?|rolls?)\s+of\s+)/i;
/** "sets of large plates" → "Large plates"; "(18 pack) of hangers white" → "Hangers white". */
export function itemName(text: string) {
  const t = text.replace(PACK, '').trim() || text.trim();
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 60);
}
/** What it is counted in: a set, a pack, a case, a box — else one by one. */
export function guessMeasure(text: string) {
  const m = text.match(/^\(?\s*\d*\s*(set|pack|pk|case|box|pair|roll)/i)?.[1]?.toLowerCase();
  return m === 'pk' ? 'pack' : m ?? 'unit';
}
const SUPPLY_HEADS = new Set(['soap', 'wash', 'shampoo', 'conditioner', 'lotion', 'pod', 'detergent', 'bleach', 'cleaner', 'wipe', 'sponge',
  'bag', 'bulb', 'filter', 'freshener', 'foil', 'coffee', 'tissue', 'gel', 'spray']);
/** Used up by cleans (soap, pods, bags…) = supplies; anything else — linens, dishes, furniture — is furniture. By the last noun. */
export function guessKind(text: string): 'supply' | 'furniture' {
  const t = text.replace(/\([^)]*\)/g, ' ');
  if (/\btoilet paper\b|\bpaper towels?\b(?!\s+holder)/i.test(t)) return 'supply';
  const w = words(t);
  return SUPPLY_HEADS.has(w[w.length - 1] ?? '') ? 'supply' : 'furniture';
}

const settled = (l: DraftLine) => !!(l.i || l.n);
const asked = (l: DraftLine) => !settled(l) && (l.c.length > 0 || !!l.x);
const missing = (l: DraftLine) => !settled(l) && !l.c.length && !l.x;

/** The lines that already sit on the to-do's order at this place — the draft asks: add, or replace? */
export function clashes(d: Pick<OrderDraft, 'lines' | 'place'>, existing: OrderLine[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!d.place) return out;
  d.lines.forEach((l, idx) => {
    const had = l.i ? existing.filter(e => String(e.itemId) === l.i && e.place === d.place).reduce((a, e) => a + e.qty, 0) : 0;
    if (had > 0) out.set(idx, had);
  });
  return out;
}

/** What is still missing before Confirm can save — null when nothing. */
export function draftProblem(d: OrderDraft, existing: OrderLine[]): string | null {
  if (!d.lines.length) return 'Nothing is left on the order.';
  const open = d.lines.filter(l => !settled(l));
  if (open.length) return `${open.length === 1 ? `“${open[0]!.t}” is` : `${open.length} lines are`} still open — pick the item, add as new, or drop.`;
  if (!d.place) return 'Pick where it goes first.';
  const clash = [...clashes(d, existing).keys()].find(k => !d.lines[k]!.m);
  if (clash != null) return `“${d.lines[clash]!.t}” is already on this order — say whether it adds or replaces.`;
  return null;
}

/** The to-do's order after Confirm: a clashing line adds to what was there, or replaces it; the rest is appended. */
export function mergeOrder(existing: OrderLine[], add: (OrderLine & { m?: 'sum' | 'replace' })[]): OrderLine[] {
  let out = existing.map(e => ({ itemId: String(e.itemId), place: e.place, qty: e.qty }));
  for (const a of add) {
    const had = out.filter(e => e.itemId === a.itemId && e.place === a.place).reduce((s, e) => s + e.qty, 0);
    if (!had) { out.push({ itemId: a.itemId, place: a.place, qty: a.qty }); continue; }
    out = out.filter(e => !(e.itemId === a.itemId && e.place === a.place));
    out.push({ itemId: a.itemId, place: a.place, qty: a.m === 'replace' ? a.qty : had + a.qty });
  }
  return out;
}

/** The draft's id, read back from its own message (the Confirm button's value). */
export function draftIdFromBlocks(blocks: unknown): string | null {
  for (const b of (Array.isArray(blocks) ? blocks : []) as { elements?: { action_id?: string; value?: string }[] }[]) {
    const e = b.elements?.find(x => x.action_id === 'order_confirm');
    if (e?.value && /^\d+$/.test(e.value)) return e.value;
  }
  return null;
}

export interface DraftItem { id: string; name: string; measure: string; active?: boolean; buyOptions?: BuyOption[] }
const many = (measure: string, n: number) => `${n} ${measure}${n === 1 || /s$/.test(measure) ? '' : 's'}`;

/** Text cut into sections of at most ~2900 characters, whole lines each. */
function chunks(lines: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > 2900) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  return cur ? [...out, cur] : out;
}

/** The store links for what is already resolved — a Walmart cart, Amazon pages, and what has neither (≤3000 characters). */
function cartLine(d: OrderDraft, items: DraftItem[]): string {
  const lines = d.lines.filter(l => l.i).map(l => ({ itemId: l.i!, qty: l.q }));
  if (!lines.length) return '';
  const c = cartLinks(lines, items);
  const name = (id: string) => items.find(i => i.id === id)?.name ?? '?';
  const bits = [c.walmart.url ? `<${c.walmart.url}|🛒 Walmart cart (${c.walmart.items.length})>` : '',
                ...c.amazon.map(a => `<${a.url}|Amazon: ${esc(name(a.itemId))} ×${a.qty}>`),
                c.none.length ? `No store link: ${c.none.map(id => esc(name(id))).join(', ')}` : ''].filter(Boolean);
  let out = '';
  for (const b of bits) { if ((out + b).length > 2900) { out += ' · …'; break; } out = out ? `${out} · ${b}` : b; }
  return out;
}

/**
 * The draft as a Slack message (≤50 blocks): what is settled as a list with "Change a line…", the clashes
 * (add or replace), the questions one by one with the closest items as buttons — as many as fit, the rest
 * after — what is not in Kaizen grouped (add them all as new items, or drop them), where it goes, the store
 * links, and Confirm (the draft's id) / Cancel.
 */
export function orderDraftMessage(d: OrderDraft, id: string, o: { items: DraftItem[]; places: Opt[]; existing: OrderLine[]; todoTitle?: string | null; problem?: string | null;
  /** Said under the place: where a house's supplies go instead ("🧴 3 supplies go to S1105 Storage…"). */ routed?: string | null }):
  { text: string; blocks: Block[] } {
  const name = (iid: string) => o.items.find(i => i.id === iid)?.name ?? `item ${iid}`;
  const measure = (iid: string) => o.items.find(i => i.id === iid)?.measure ?? 'unit';
  const clash = clashes(d, o.existing);
  const where = d.todo ? `Goes on *${esc(o.todoTitle ?? `to-do #${d.todo}`)}* — this thread’s to-do.`
    : `A new to-do *Buy supplies…* will be made${d.claim ? ' for this thread’s claim' : ''}.`;
  // Owner, 2026-10-15: the place first — a big order goes to one place (a new unit's setup); pick it once, everything goes there.
  const opts = o.places.slice(0, 100).map(p => ({ text: plain(p.label), value: p.value }));
  const chosen = opts.find(x => x.value === d.place);
  const top: Block[] = [section(`🛒 *Purchase order — draft* · ${d.lines.length} line${d.lines.length === 1 ? '' : 's'}\n${where} Nothing is saved until *Confirm*.`),
                        ...(d.ai ? [context(esc(d.ai))] : []),
                        section(`📍 *Everything goes to:*${d.said && !chosen ? ` you wrote “${esc(d.said)}” — pick its place.` : ''}`,
                          opts.length ? { type: 'static_select', action_id: 'order_place', placeholder: plain('Pick the place'), options: opts, ...(chosen ? { initial_option: chosen } : {}) } : undefined),
                        ...(o.routed ? [context(esc(o.routed))] : [])];

  const done = d.lines.map((l, idx) => ({ l, idx })).filter(x => settled(x.l));
  const list = done.map(({ l, idx }) => {
    const what = l.n ? `➕ *${esc(l.n.name)}* (new ${l.n.kind}) × ${many(l.n.measure, l.q)}` : `*${esc(name(l.i!))}* × ${many(measure(l.i!), l.q)}`;
    const had = clash.get(idx);
    const merge = had == null ? '' : l.m === 'sum' ? ` · adds to ${had} → ${had + l.q}` : l.m === 'replace' ? ` · replaces ${had}` : ` · ⚠ ${had} already on this order`;
    return `${idx + 1}. ${what} — _“${esc(l.t)}”_${merge}`;
  });
  const settledBlocks: Block[] = chunks(list).map(c => section(c));
  const changeable = d.lines.map((l, idx) => ({ l, idx })).filter(x => !asked(x.l)).slice(0, 100);
  if (changeable.length) settledBlocks.push({ type: 'actions', block_id: 'order_change', elements: [{ type: 'static_select', action_id: 'order_change',
    placeholder: plain('Change a line…'), options: changeable.map(({ l, idx }) => ({ text: plain(`${idx + 1}. ${l.t}`), value: String(idx) })) }] });

  const gone = d.lines.map((l, idx) => ({ l, idx })).filter(x => missing(x.l));
  const goneBlocks: Block[] = gone.length ? [
    section(`➕ *Not in Kaizen yet* (${gone.length}): ${gone.map(({ l, idx }) => `${idx + 1}. ${esc(l.t)} × ${l.q}`).join(' · ')}`.slice(0, 2900)),
    { type: 'actions', block_id: 'order_missing', elements: [button(`+ Add ${gone.length === 1 ? 'it' : `all ${Math.min(gone.length, 45)}`} as new items…`, 'order_new_all', 'all', 'primary'),
      button(`✕ Drop ${gone.length === 1 ? 'it' : 'them'}`, 'order_drop_all', 'all')] }] : [];

  const cart = cartLine(d, o.items);
  const bottom: Block[] = [
    ...(d.sk ? [context(`${d.sk} line${d.sk === 1 ? '' : 's'} of text ${d.sk === 1 ? 'was' : 'were'} not read as items.`)] : []),
    ...(cart ? [context(cart)] : []),
    ...(o.problem ? [context(`⚠ ${esc(o.problem)}`)] : []),
    { type: 'actions', block_id: 'order_go', elements: [button('Confirm', 'order_confirm', id, 'primary'), button('Cancel', 'order_cancel', 'cancel')] }];

  // Slack takes 50 blocks: the clashes and questions get what is left, two blocks each; the rest come after.
  let room = 50 - top.length - settledBlocks.length - goneBlocks.length - bottom.length - 1;
  const middle: Block[] = [];
  const waiting: number[] = [];
  for (const [idx, had] of clash) {
    const l = d.lines[idx]!;
    if (room < 2) { waiting.push(idx); continue; }
    room -= 2;
    middle.push(section(`↳ ${idx + 1}. *${esc(l.i ? name(l.i) : l.t)}*: ${had} already on this order at that place — add ${l.q}, or make it ${l.q}?`),
      { type: 'actions', block_id: `om_${idx}`, elements: [
        button(`Add → ${had + l.q}`, 'order_merge_sum', `${idx}`, l.m === 'sum' ? 'primary' : undefined),
        button(`Replace → ${l.q}`, 'order_merge_replace', `${idx}`, l.m === 'replace' ? 'primary' : undefined)] });
  }
  d.lines.forEach((l, idx) => {
    if (!asked(l)) return;
    if (room < 2) { waiting.push(idx); return; }
    room -= 2;
    middle.push({ ...section(`❓ ${idx + 1}. _“${esc(l.t)}”_ × ${l.q} — ${l.c.length ? 'which item is it?' : 'which item?'}`), block_id: `ol_${idx}` },
      { type: 'actions', block_id: `oc_${idx}`, elements: [
        ...l.c.map(iid => button(name(iid), 'order_pick', `${idx}:${iid}`)),
        button('Another item…', 'order_other', String(idx)),
        button('+ New item', 'order_new', String(idx)),
        button('✕ Drop', 'order_drop', String(idx))] });
  });
  if (waiting.length) middle.push(context(`… and ${waiting.length} more to answer — they show here as these are answered.`));
  return { text: '🛒 Purchase order — draft', blocks: [...top, ...settledBlocks, ...middle, ...goneBlocks, ...bottom] };
}

/** Said in the thread once it is saved: what, where, on which to-do — and the store links, for whoever buys it. */
export function orderSavedMessage(d: OrderDraft, o: { items: DraftItem[]; placeLabel: string; todoId: string; todoTitle: string; fresh: boolean; by: string; appUrl?: string }):
  { text: string; blocks: Block[] } {
  const name = (id: string) => o.items.find(i => i.id === id)?.name ?? `item ${id}`;
  const list = d.lines.map(l => `• ${esc(l.i ? name(l.i) : l.n?.name ?? l.t)} × ${l.q}${l.m === 'replace' ? ' (replaced)' : l.m === 'sum' ? ' (added)' : ''}`);
  const head = `🛒 Purchase order ${o.fresh ? 'made' : 'saved'} on *${esc(o.todoTitle)}* by <@${o.by}> — ${d.lines.length} line${d.lines.length === 1 ? '' : 's'} to *${esc(o.placeLabel)}*:`;
  const cart = cartLine(d, o.items);
  const open = kaizenButton(o.appUrl, 'todo', o.todoId);
  return { text: `🛒 Purchase order saved on ${o.todoTitle}`,
           blocks: [section(head), ...chunks(list).slice(0, 45).map(c => section(c)), ...(cart ? [context(cart)] : []), ...(open.length ? [{ type: 'actions', elements: open }] : [])] };
}

/** "Another item…" — every active item, the closest first (a menu holds 100). */
export function pickItemModal(meta: string, written: string, items: DraftItem[], closest: string[]): Block {
  const active = items.filter(i => i.active !== false);
  const sorted = [...closest.map(id => active.find(i => i.id === id)).filter((i): i is DraftItem => !!i), ...active.filter(i => !closest.includes(i.id))].slice(0, 100);
  return { type: 'modal', callback_id: 'order_pick_item', private_metadata: meta, title: plain('Pick the item'), submit: plain('Use it'), close: plain('Back'),
    blocks: [{ type: 'input', block_id: 'item', label: plain(`For “${written}”`), element: { type: 'static_select', action_id: 'v', placeholder: plain('Item'),
      options: sorted.map(i => ({ text: plain(i.name), value: i.id })) } }] };
}

const KIND_OPTS = [{ text: plain('Supplies — used up by cleans'), value: 'supply' }, { text: plain('Furniture — linens, dishes, equipment'), value: 'furniture' }];

/** "+ New item" — name as written, supplies or furniture, its measure. */
export function newItemModal(meta: string, written: string, s?: NewItem): Block {
  const kind = s?.kind ?? guessKind(written);
  return { type: 'modal', callback_id: 'order_new_item', private_metadata: meta, title: plain('New item'), submit: plain('Use it'), close: plain('Back'),
    blocks: [
      { type: 'input', block_id: 'name', label: plain('Name'), element: { type: 'plain_text_input', action_id: 'v', initial_value: s?.name ?? itemName(written), max_length: 60 } },
      { type: 'input', block_id: 'kind', label: plain('Type'), element: { type: 'radio_buttons', action_id: 'v', initial_option: KIND_OPTS.find(k => k.value === kind), options: KIND_OPTS } },
      { type: 'input', block_id: 'measure', label: plain('Counted by'), hint: plain('roll, bottle, pack, set, unit…'),
        element: { type: 'plain_text_input', action_id: 'v', initial_value: s?.measure ?? guessMeasure(written), max_length: 20 } },
      context('The item is made when the order is confirmed. Its store link and minimums are set in Kaizen → Setup → Inventory.')] };
}

/**
 * Everything not in Kaizen at once (≤45 — a form holds 100 blocks): per line its name and its type, guessed from
 * the words; what it is counted in is guessed too ("sets of…" = set) and changed later in Setup → Inventory.
 */
export function newItemsModal(meta: string, rows: { idx: number; t: string; q: number; s?: NewItem }[]): Block {
  return { type: 'modal', callback_id: 'order_new_items', private_metadata: meta, title: plain('New items'), submit: plain('Add them'), close: plain('Back'),
    blocks: [context('Each is made when the order is confirmed, counted as shown (set, pack, unit…) — change it later in Kaizen → Setup → Inventory.'),
      ...rows.slice(0, 45).flatMap(r => [
        { type: 'input', block_id: `nn_${r.idx}`, label: plain(`${r.idx + 1}. ${r.t} × ${r.q} — counted by ${newMeasureOf(r)}`),
          element: { type: 'plain_text_input', action_id: 'v', initial_value: r.s?.name ?? itemName(r.t), max_length: 60 } },
        { type: 'input', block_id: `nk_${r.idx}`, label: plain('Type'),
          element: { type: 'static_select', action_id: 'v', initial_option: KIND_OPTS.find(k => k.value === (r.s?.kind ?? guessKind(r.t))), options: KIND_OPTS } }])] };
}

/** What a new item from the grouped form is counted in: the AI's word, else guessed from the line. */
export const newMeasureOf = (l: { t: string; s?: NewItem }) => l.s?.measure ?? guessMeasure(l.t);

/**
 * The model's compact rows ([n, id, sure, [alts], name, measure, furniture, itemQty], `readOrderLines`) as the
 * raw lines `readReceipt` checks — the words and how many are the list's own, not the model's. A line with no
 * row, or a row that is not one, is null.
 */
export function rowsToRaw(rows: unknown, lines: { text: string; qty: number }[]): (Record<string, unknown> | null)[] {
  const out: (Record<string, unknown> | null)[] = lines.map(() => null);
  (Array.isArray(rows) ? rows : []).forEach((r, k) => {
    if (!Array.isArray(r)) return;
    // flash-lite answered "1: nights stands" for 1 (2026-10-15): the number it starts with, else the row's place.
    const lead = parseInt(String(r[0]), 10);
    const n = Number.isFinite(lead) ? lead : k + 1;
    const line = lines[n - 1];
    if (!line || out[n - 1]) return;
    const id = r[1] == null || r[1] === 0 || r[1] === '0' || r[1] === '' ? null : String(r[1]);
    out[n - 1] = { text: line.text, qty: line.qty, kind: 'item', itemId: id, sure: r[2] === 1 || r[2] === true,
      alternatives: Array.isArray(r[3]) ? r[3].map(String) : [], name: typeof r[4] === 'string' ? r[4] : null,
      measure: typeof r[5] === 'string' ? r[5] : null, furniture: r[6] === 1 || r[6] === true ? true : r[6] === 0 || r[6] === false ? false : null,
      itemQty: Number(r[7]) > 0 ? Number(r[7]) : null };
  });
  return out;
}

/**
 * Where a line goes when the order goes to `place` (owner, 2026-10-15: one place, no splits): there — unless supplies
 * are sent to a house, where nothing is kept: then where that house's supplies are kept (its closet or its storage,
 * from the Repository). null = nowhere it can go. `kind` unknown (an open question) counts as going there.
 */
export function lineTarget(place: { key: string; house?: boolean; supplies?: string | null }, kind: 'supply' | 'furniture' | undefined): string | null {
  if (!place.house || kind !== 'supply') return place.key;
  return place.supplies ?? null;
}
