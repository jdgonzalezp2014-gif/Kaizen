/**
 * A purchase receipt read by the AI (owner, 2026-10-14) — pure: what the model
 * said, checked against the supplies list; which supplies a doubtful line could
 * be; and how one receipt's total splits across the orders it paid for.
 *
 * The AI only fills in the form — a person checks it and records it. So a
 * line is matched to a supply only when the model says it is sure AND that
 * supply exists; otherwise the person picks from the likely ones, adds it as a
 * new item, or skips it. Nothing is guessed on the person's behalf.
 */

export interface ReceiptItem { id: string; name: string; measure: string; active?: boolean }
export interface ReceiptOrder { todoId: string; lines: { itemId: string }[] }

/** Tax, a bag fee, a discount… — on the receipt, never a supply. */
export type LineKind = 'item' | 'tax' | 'fee' | 'discount' | 'other';

export interface ReceiptLine {
  text: string; qty: number | null; unitPrice: number | null; amount: number | null; kind: LineKind;
  /** The supply it is, only when sure — null = the person decides. */
  itemId: string | null;
  /** How many of the supply's own measure (a 6-pack of rolls = 6 rolls); falls back to qty. */
  itemQty: number | null;
  /** 0–4 likely supplies when it is not sure (never includes itemId). */
  candidates: string[];
  /** The open order it fits, if any. */
  orderId: string | null;
}

export interface Receipt { store: string | null; date: string | null; total: number | null; tax: number | null; lines: ReceiptLine[] }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
};
const KINDS: LineKind[] = ['item', 'tax', 'fee', 'discount', 'other'];
// What a receipt prints that is not something bought, when the model did not say.
const NOT_ITEM = /\b(sales\s+)?tax\b|\bbag\s*fee\b|\bsub\s*-?total\b|\bbalance\b|\bchange\s+due\b|\btender\b/i;

/** Lower-case words, a plural's "s" dropped — "Paper Towels 6PK" → paper, towel, 6pk. */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(w => w.length > 1).map(w => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
}

/**
 * The supplies a receipt line most looks like, best first — shared words, a word
 * that starts another ("TOWL" ~ "towel"), at most `n`. None alike → empty.
 */
export function similarItems(text: string, items: ReceiptItem[], n = 4): string[] {
  const t = words(text);
  if (!t.length) return [];
  const scored = items.filter(i => i.active !== false).map(i => {
    const w = words(i.name);
    let s = 0;
    for (const a of t) {
      if (w.includes(a)) s += 2;
      else if (a.length >= 3 && w.some(b => b.length >= 3 && (b.startsWith(a) || a.startsWith(b)))) s += 1;
    }
    return { id: i.id, s: s / Math.sqrt(w.length || 1) };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map(x => x.id);
}

/** The one open order that asks for this supply; two or more → none (the person says). */
export function orderFor(itemId: string | null, orders: ReceiptOrder[], said?: string | null): string | null {
  if (!itemId) return null;
  const fits = orders.filter(o => o.lines.some(l => l.itemId === itemId));
  if (said && fits.some(o => o.todoId === said)) return said;
  return fits.length === 1 ? fits[0]!.todoId : null;
}

/**
 * The model's answer made safe: numbers are numbers, every supply named exists
 * (else it is a doubt, not a match), a doubtful line gets 2–4 likely supplies —
 * the model's own first, then the look-alikes — and each matched line the open
 * order it fits.
 */
export function readReceipt(raw: unknown, items: ReceiptItem[], orders: ReceiptOrder[] = []): Receipt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const known = new Set(items.filter(i => i.active !== false).map(i => i.id));
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  const lines = (Array.isArray(r.lines) ? r.lines : []).slice(0, 80).map((x): ReceiptLine | null => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const text = String(l.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return null;
    const said = KINDS.includes(l.kind as LineKind) ? l.kind as LineKind : null;
    const kind: LineKind = said ?? (NOT_ITEM.test(text) ? 'other' : 'item');
    const id = l.itemId == null ? null : String(l.itemId);
    const sure = kind === 'item' && l.sure === true && id != null && known.has(id);
    const itemId = sure ? id : null;
    const own = (Array.isArray(l.alternatives) ? l.alternatives : []).map(String).concat(id && !sure ? [id] : [])
      .filter(a => known.has(a));
    const candidates = kind !== 'item' || itemId ? [] : [...new Set([...own, ...similarItems(text, items)])].slice(0, 4);
    const qty = num(l.qty), itemQty = num(l.itemQty);
    return { text, qty, unitPrice: num(l.unitPrice), amount: num(l.amount), kind, itemId, itemQty: itemQty && itemQty > 0 ? itemQty : qty,
             candidates, orderId: orderFor(itemId, orders, l.orderId == null ? null : String(l.orderId)) };
  }).filter((l): l is ReceiptLine => !!l);
  return { store: typeof r.store === 'string' && r.store.trim() ? r.store.trim().slice(0, 80) : null, date,
           total: num(r.total), tax: num(r.tax), lines };
}

/** What the bought lines add up to (items only — tax and fees are in the total, not in a line). */
export const linesTotal = (lines: Pick<ReceiptLine, 'amount' | 'kind'>[]) =>
  Math.round(lines.filter(l => l.kind === 'item' || l.kind === 'discount').reduce((a, l) => a + (l.amount ?? 0), 0) * 100) / 100;

/** Everything the receipt's lines add up to — its tax too when no line carries it — to set against its total. */
export const receiptSum = (r: Pick<Receipt, 'lines' | 'tax'>) =>
  Math.round((r.lines.reduce((a, l) => a + (l.amount ?? 0), 0) + (r.lines.some(l => l.kind === 'tax') ? 0 : r.tax ?? 0)) * 100) / 100;

/**
 * One receipt paying for several orders: each order's share of `total` in
 * proportion to what its lines cost — tax and fees spread the same way — in
 * cents, summing exactly to the total (the cents left by rounding go to the
 * biggest). Lines with no amount count nothing; if none has one, equal parts.
 */
export function splitTotal(total: number, groups: { key: string; amount: number }[]): { key: string; share: number }[] {
  if (!groups.length) return [];
  const cents = Math.round(total * 100);
  const base = groups.reduce((a, g) => a + Math.max(0, g.amount), 0);
  const w = groups.map(g => base > 0 ? Math.max(0, g.amount) / base : 1 / groups.length);
  const out = groups.map((g, i) => ({ key: g.key, c: Math.floor(cents * w[i]!) }));
  let left = cents - out.reduce((a, o) => a + o.c, 0);
  const order = out.map((_, i) => i).sort((a, b) => w[b]! - w[a]!);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]!]!.c++;
  return out.map(o => ({ key: o.key, share: o.c / 100 }));
}
