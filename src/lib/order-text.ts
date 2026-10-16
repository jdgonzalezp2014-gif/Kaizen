/**
 * "@Kaizen order 2 paper towels and 1 Tide for LP-4212" (owner, 2026-10-15): a purchase order from free text.
 * Each line is matched to a supply by its words (or an alias a person taught); a doubtful one is never guessed —
 * the draft asks, with the closest items as buttons, or "+ Add as new item". The place is asked unless the text
 * names a storage or closet exactly. Nothing is saved until Confirm (agents draft, humans send). Pure.
 *
 * The draft lives in the Confirm button's value (Slack keeps ≤2000 characters there): every click reads it back
 * from the message and redraws the message — no table, no migration.
 */
import { aliasKey, scoreItems, type ReceiptItem } from './receipt.ts';
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
/** One line of the draft — short keys, it travels in a button's value. */
export interface DraftLine {
  /** What was written for it. */ t: string;
  /** How many. */ q: number;
  /** The supply, once sure or picked. */ i: string | null;
  /** The closest supplies, best first (kept so "Change" can offer them again). */ c: string[];
  /** "+ Add as new item": made on Confirm. */ n?: NewItem;
  /** Already on the to-do's order at that place: add to it, or replace it. */ m?: 'sum' | 'replace';
  /** Picked by a person — taught as an alias on Confirm. */ p?: 1;
}
export interface OrderDraft {
  /** Who asked (Slack user). */ by: string;
  /** Channel, the thread it lives in, and the message that asked. */ ch: string; root: string; msg: string;
  /** The to-do of this thread (a task, a cleaner's request, an inspection's order) — the lines go on it. */ todo: string | null;
  /** This thread's claim: the new to-do is for it. */ claim: string | null;
  /** Storage, closet or house key — asked unless written exactly. */ place: string | null;
  /** What came after "for"/"para" when it was not a place (a unit, said back so the person picks its place). */ said: string | null;
  /** The listing named in the text — for a new to-do. */ unit: string | null;
  lines: DraftLine[];
}
export type OrderLine = { itemId: string; place: string; qty: number };

const MAX_LINES = 10;
const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, docena: 12
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "2 paper towels", "paper towels x2", "two Tide", "una escoba" → the words and how many (1 when not said). */
export function lineQty(chunk: string): { text: string; qty: number } {
  let t = chunk.trim().replace(/^[-•*]\s*/, '');
  let qty = 1;
  const lead = t.match(/^(\d+(?:\.\d+)?)\s*(?:x|×)?\s+(.+)$/i);
  const trail = t.match(/^(.+?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)$/i);
  const word = t.match(/^([a-z]+)\s+(.+)$/i);
  if (lead) { qty = Number(lead[1]); t = lead[2]!; }
  else if (trail) { qty = Number(trail[2]); t = trail[1]!; }
  else if (word && NUMBERS[word[1]!.toLowerCase()] != null) { qty = NUMBERS[word[1]!.toLowerCase()]!; t = word[2]!; }
  t = t.replace(/^(?:of|de)\s+/i, '').trim();
  return { text: t.slice(0, 60), qty: qty > 0 && Number.isFinite(qty) ? Math.ceil(qty) : 1 };
}

/**
 * The text split into lines ("," ";" "+" "and" "y" "&" or a new line) and where it goes. A trailing
 * "for/para/to/at/en <X>" is taken off the lines only when X is a place (then it is the place), or a listing or a
 * place without its "closet"/"(house)" — "LP-4212" (then it is said back, and the place is still asked — owner:
 * always ask). The Repository says LP-4212 where Hostaway says P2-4212, so a place also knows its listing.
 */
export function parseOrderText(text: string, places: { key: string; name: string; unit?: string | null }[], units: Opt[]) {
  let t = text.replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<([^>]+)>/g, '$1').trim();
  let place: string | null = null, said: string | null = null, unit: string | null = null;
  const tail = t.match(/^([\s\S]*\S)\s+(?:for|para|to|at|en|in)\s+(?:the\s+|el\s+|la\s+)?([^,;\n]+?)[\s.!]*$/i);
  if (tail) {
    const x = tail[2]!.trim();
    const hit = places.find(p => norm(p.name) === norm(x));
    const base = places.find(p => norm(p.name.replace(/\s+(closet|\(house\))$/i, '')) === norm(x));
    if (hit) { place = hit.key; unit = hit.unit ?? null; t = tail[1]!; }
    else if (guessUnit(x, units) || base) { said = x; unit = base?.unit ?? null; t = tail[1]!; }
  }
  const lines = t.split(/\s*(?:[,;+&\n]|\s(?:and|y)\s)\s*/i).map(c => c.trim()).filter(Boolean).map(lineQty).filter(l => l.text).slice(0, MAX_LINES);
  return { lines, place, said, unit: guessUnit(text, units) ?? unit };
}

/**
 * A line's supply: an alias a person taught, or a clear best match — at least one whole word in common and
 * well ahead of the next (×1.5). Anything else is a question, with the closest three.
 */
export function matchOrderLine(text: string, items: ReceiptItem[], aliases: Map<string, string> = new Map()): { i: string | null; c: string[] } {
  const scored = scoreItems(text, items);
  const c = scored.slice(0, 3).map(x => x.id);
  const taught = aliases.get(aliasKey(text));
  if (taught && items.some(i => i.id === taught && i.active !== false)) return { i: taught, c };
  const [top, next] = scored;
  if (top && top.whole >= 1 && (!next || top.s >= next.s * 1.5)) return { i: top.id, c };
  return { i: null, c };
}

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
  const open = d.lines.find(l => !l.i && !l.n);
  if (open) return `Pick the item for “${open.t}” first (or + Add as new item).`;
  if (!d.place) return 'Pick where it goes first.';
  const clash = [...clashes(d, existing).keys()].find(k => !d.lines[k]!.m);
  if (clash != null) return `“${d.lines[clash]!.t}” is already on this order — say whether it adds or replaces.`;
  return null;
}

/** The to-do's order after Confirm: a clashing line adds to what was there, or replaces it; the rest is appended. */
export function mergeOrder(existing: OrderLine[], add: (OrderLine & { m?: 'sum' | 'replace' })[]): OrderLine[] {
  const out = existing.map(e => ({ itemId: String(e.itemId), place: e.place, qty: e.qty }));
  for (const a of add) {
    const same = out.filter(e => e.itemId === a.itemId && e.place === a.place);
    if (!same.length) { out.push({ itemId: a.itemId, place: a.place, qty: a.qty }); continue; }
    const had = same.reduce((s, e) => s + e.qty, 0);
    const keep = out.filter(e => !(e.itemId === a.itemId && e.place === a.place));
    keep.push({ itemId: a.itemId, place: a.place, qty: a.m === 'replace' ? a.qty : had + a.qty });
    out.splice(0, out.length, ...keep);
  }
  return out;
}

/** The draft read back from its own message (the Confirm button's value). */
export function draftFromBlocks(blocks: unknown): OrderDraft | null {
  for (const b of (Array.isArray(blocks) ? blocks : []) as { elements?: { action_id?: string; value?: string }[] }[]) {
    const e = b.elements?.find(x => x.action_id === 'order_confirm');
    if (e?.value) try { return JSON.parse(e.value) as OrderDraft; } catch { return null; }
  }
  return null;
}

export interface DraftItem { id: string; name: string; measure: string; active?: boolean; buyOptions?: BuyOption[] }
const many = (measure: string, n: number) => `${n} ${measure}${n === 1 || /s$/.test(measure) ? '' : 's'}`;

/** The store links for what is already resolved — a Walmart cart, Amazon pages, and what has neither. */
function cartLine(d: OrderDraft, items: DraftItem[]): string {
  const lines = d.lines.filter(l => l.i).map(l => ({ itemId: l.i!, qty: l.q }));
  if (!lines.length) return '';
  const c = cartLinks(lines, items);
  const name = (id: string) => items.find(i => i.id === id)?.name ?? '?';
  const bits = [c.walmart.url ? `<${c.walmart.url}|🛒 Walmart cart (${c.walmart.items.length})>` : '',
                ...c.amazon.map(a => `<${a.url}|Amazon: ${esc(name(a.itemId))} ×${a.qty}>`),
                c.none.length ? `No store link: ${c.none.map(id => esc(name(id))).join(', ')}` : ''].filter(Boolean);
  return bits.join(' · ');
}

/**
 * The draft as a Slack message: each line (sure, or a question with the closest items), where it goes,
 * the store links, and Confirm / Cancel. Confirm carries the draft itself.
 */
export function orderDraftMessage(d: OrderDraft, o: { items: DraftItem[]; places: Opt[]; existing: OrderLine[]; todoTitle?: string | null; problem?: string | null }):
  { text: string; blocks: Block[] } {
  const name = (id: string) => o.items.find(i => i.id === id)?.name ?? `item ${id}`;
  const measure = (id: string) => o.items.find(i => i.id === id)?.measure ?? 'unit';
  const where = d.todo ? `Goes on *${esc(o.todoTitle ?? `to-do #${d.todo}`)}* — this thread’s to-do.`
    : `A new to-do *Buy supplies…* will be made${d.claim ? ' for this thread’s claim' : ''}.`;
  const blocks: Block[] = [section(`🛒 *Purchase order — draft*\n${where} Nothing is saved until *Confirm*.`)];
  const clash = clashes(d, o.existing);
  d.lines.forEach((l, idx) => {
    const wrote = `_“${esc(l.t)}”_`;
    if (l.i || l.n) {
      const what = l.n ? `➕ *${esc(l.n.name)}* (new ${l.n.kind}) × ${many(l.n.measure, l.q)}` : `*${esc(name(l.i!))}* × ${many(measure(l.i!), l.q)}`;
      blocks.push({ ...section(`• ${what} — ${wrote}`, button('Change', 'order_change', String(idx))), block_id: `ol_${idx}` });
      const had = clash.get(idx);
      if (had != null) {
        const said = l.m === 'sum' ? ` → *adds*: ${had + l.q}` : l.m === 'replace' ? ` → *replaces*: ${l.q}` : ' — add to it, or replace it?';
        blocks.push({ type: 'actions', block_id: `om_${idx}`, elements: [
          button(`Add → ${had + l.q}`, 'order_merge_sum', `${idx}`, l.m === 'sum' ? 'primary' : undefined),
          button(`Replace → ${l.q}`, 'order_merge_replace', `${idx}`, l.m === 'replace' ? 'primary' : undefined)] });
        blocks.push(context(`↳ ${had} already on this order at that place${said}`));
      }
      return;
    }
    blocks.push({ ...section(`• ❓ ${wrote} × ${l.q} — ${l.c.length ? 'which item is it?' : 'no item looks like it.'}`), block_id: `ol_${idx}` });
    const others = o.items.filter(i => i.active !== false && !l.c.includes(i.id)).slice(0, 100 - l.c.length);
    blocks.push({ type: 'actions', block_id: `oc_${idx}`, elements: [
      ...l.c.map(id => button(name(id), 'order_pick', `${idx}:${id}`)),
      button('+ Add as new item', 'order_new', String(idx)),
      ...(others.length ? [{ type: 'static_select', action_id: 'order_pick_other', placeholder: plain('Another item…'),
        options: others.map(i => ({ text: plain(i.name), value: `${idx}:${i.id}` })) }] : []),
      button('✕ Drop', 'order_drop', String(idx))] });
  });
  const opts = o.places.slice(0, 100).map(p => ({ text: plain(p.label), value: p.value }));
  const chosen = opts.find(x => x.value === d.place);
  blocks.push(section(`📍 *Where does it go?*${d.said && !chosen ? ` You wrote “${esc(d.said)}” — pick its storage or closet.` : ''}`,
    opts.length ? { type: 'static_select', action_id: 'order_place', placeholder: plain('Pick the place'), options: opts, ...(chosen ? { initial_option: chosen } : {}) } : undefined));
  const cart = cartLine(d, o.items);
  if (cart) blocks.push(context(cart));
  if (o.problem) blocks.push(context(`⚠ ${esc(o.problem)}`));
  blocks.push({ type: 'actions', block_id: 'order_go', elements: [button('Confirm', 'order_confirm', JSON.stringify(d), 'primary'), button('Cancel', 'order_cancel', '')] });
  return { text: '🛒 Purchase order — draft', blocks };
}

/** Said in the thread once it is saved: what, where, on which to-do — and the store links, for whoever buys it. */
export function orderSavedMessage(d: OrderDraft, o: { items: DraftItem[]; placeLabel: string; todoId: string; todoTitle: string; fresh: boolean; by: string; appUrl?: string }):
  { text: string; blocks: Block[] } {
  const name = (id: string) => o.items.find(i => i.id === id)?.name ?? `item ${id}`;
  const list = d.lines.map(l => `• ${esc(l.i ? name(l.i) : l.n?.name ?? l.t)} × ${l.q}${l.m === 'replace' ? ' (replaced)' : l.m === 'sum' ? ' (added)' : ''}`).join('\n');
  const head = `🛒 Purchase order ${o.fresh ? 'made' : 'saved'} on *${esc(o.todoTitle)}* by <@${o.by}> — to *${esc(o.placeLabel)}*:`;
  const cart = cartLine(d, o.items);
  const open = kaizenButton(o.appUrl, 'todo', o.todoId);
  return { text: `🛒 Purchase order saved on ${o.todoTitle}`,
           blocks: [section(`${head}\n${list}`), ...(cart ? [context(cart)] : []), ...(open.length ? [{ type: 'actions', elements: open }] : [])] };
}

/** The "+ Add as new item" form — name as written, supply or furniture, its measure. */
export function newItemModal(meta: string, written: string): Block {
  const name = written.charAt(0).toUpperCase() + written.slice(1);
  return { type: 'modal', callback_id: 'order_new_item', private_metadata: meta, title: plain('New item'), submit: plain('Use it'), close: plain('Back'),
    blocks: [
      { type: 'input', block_id: 'name', label: plain('Name'), element: { type: 'plain_text_input', action_id: 'v', initial_value: name.slice(0, 120), max_length: 120 } },
      { type: 'input', block_id: 'kind', label: plain('Type'), element: { type: 'radio_buttons', action_id: 'v',
        initial_option: { text: plain('Supplies — used up by cleans'), value: 'supply' },
        options: [{ text: plain('Supplies — used up by cleans'), value: 'supply' }, { text: plain('Furniture — linens, dishes, equipment'), value: 'furniture' }] } },
      { type: 'input', block_id: 'measure', label: plain('Counted by'), hint: plain('roll, bottle, pack, unit…'),
        element: { type: 'plain_text_input', action_id: 'v', initial_value: 'unit', max_length: 20 } },
      context('The item is made when the order is confirmed. Its store link and minimums are set in Kaizen → Setup → Inventory.')] };
}
