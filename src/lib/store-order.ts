/**
 * Walmart and Amazon orders, as the team saves them with MarkDownload (owner, 2026-10-15) — pure.
 *
 * A receipt is the order page saved as Markdown: on walmart.com/orders/<n> select from the order's title to its
 * Total and "Download selection" (the whole page loses the items), on Amazon the order details page. Every product
 * comes with its link, so the store's own product number (Walmart item id, Amazon ASIN) is read as printed — no AI,
 * nothing guessed — and remembered on the supply as a buying option (`buy_options`, 075) with how many of the
 * supply's measure come in one (`pack`). ONE store product per supply for now (owner, 2026-10-15: not several
 * platforms' links). The next receipt matches by that number; an order opens Walmart's cart from those numbers
 * (`cartLinks`). Kaizen never pays: the person checks the cart and pays in the store.
 */
import { aliasKey, orderFor, similarItems, wrongSize, type Receipt, type ReceiptItem, type ReceiptLine, type ReceiptOrder } from './receipt.ts';

export type Store = 'walmart' | 'amazon';
export interface StoreProduct { store: Store; id: string; url: string }
export interface BuyOption { label: string; url: string; pack?: number | null }

/** A product page's store and number — walmart.com/ip/<name>/<id>, amazon.com/dp/<ASIN> (or /gp/product/<ASIN>). */
export function storeProduct(url: string): StoreProduct | null {
  const w = /^https?:\/\/(?:www\.)?walmart\.com\/ip\/(?:([^/?#\s]+)\/)?(\d{5,})/i.exec(url.trim());
  if (w) return { store: 'walmart', id: w[2]!, url: `https://www.walmart.com/ip/${w[1] ? `${w[1]}/` : ''}${w[2]}` };
  const a = /^https?:\/\/(?:www\.|smile\.)?amazon\.com\/(?:[^?#\s]*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/?#]|$)/i.exec(url.trim());
  if (a) return { store: 'amazon', id: a[1]!.toUpperCase(), url: `https://www.amazon.com/dp/${a[1]!.toUpperCase()}` };
  return null;
}
export const STORE_NAME: Record<Store, string> = { walmart: 'Walmart', amazon: 'Amazon' };

/** One product line of the order, as printed. `amount` = what the line cost (Amazon prints the price of one). */
export interface OrderLine { text: string; product: StoreProduct; qty: number; amount: number | null; unitPrice: number | null;
  /** How many come in one, when printed ("Count Per Pack: 40", "42 Count", "4 Rolls"), and the word it counts. */
  pack: number | null; packWord: string | null }
export interface StoreOrder { store: Store | null; orderNo: string | null; date: string | null; subtotal: number | null; tax: number | null;
  total: number | null; /** "Subtotal (19 items)" — the quantities should add up to it. */ count: number | null; lines: OrderLine[] }

const money = (s: string | undefined) => s == null ? null : Math.round(Number(s.replace(/,/g, '')) * 100) / 100;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "Oct 15, 2026" / "October 5, 2026" → 2026-10-15. */
function isoDate(s: string | undefined): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s ?? '');
  const k = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return m && k >= 0 ? `${m[3]}-${String(k + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null;
}
const PACK_WORDS = 'count|ct|rolls?|bags?|pods?|paks?|pacs?|packets?|pairs?|pieces?|pcs|sheets?|wipes?|filters?|bars?|bottles?|cans?|tablets?|batteries';
/** The pack printed: "Count Per Pack: 40" first, else "42 Count" / "4 Rolls" in the name — never "150 2-Ply Sheets per Roll". */
function packOf(name: string, block: string): { pack: number | null; packWord: string | null } {
  const per = /Count Per Pack:\s*(\d+)/i.exec(block);
  // Walmart's "(6 pack) … Mug" / "Multipack Quantity: 6": six of the product, each holding what its name says.
  const multi = Number(/Multipack Quantity:\s*(\d+)/i.exec(block)?.[1] ?? 1) || 1;
  if (per && Number(per[1]) > 1) return { pack: Number(per[1]) * multi, packWord: 'count' };
  const m = new RegExp(`\\b(\\d{1,4})[\\s-]*(${PACK_WORDS})\\b(?!\\s+per\\b)`, 'i').exec(name);
  if (m && Number(m[1]) > 1) return { pack: Number(m[1]) * multi, packWord: m[2]!.toLowerCase() };
  return multi > 1 ? { pack: multi, packWord: 'count' } : { pack: null, packWord: null };
}

/**
 * The order read from its Markdown, as printed. Each product's block runs from its first link to the next
 * product's (its picture and its name both link to it); Walmart prints "Qty 4" and the line's price ("$3.76",
 * "$0.94 ea"), Amazon the quantity alone on its line ("3") and the price of one.
 */
export function parseOrderMd(md: string): StoreOrder {
  const raw = md.replace(/\r/g, '');
  // Walmart lists what was returned or never came after what was bought, down to "How can we help?" (seen
  // 2026-10-05: three returned products and two unavailable ones printed again) — none of it was bought.
  const gone = /\n\s*(?:Return to Walmart store|\d+ unavailable items?|\d+ canceled items?)\s*\n/i.exec(raw);
  const help = gone ? /\n(?:#+\s*)?How can we help\?/i.exec(raw.slice(gone.index)) : null;
  const text = gone ? raw.slice(0, gone.index) + (help ? raw.slice(gone.index + help.index) : '') : raw;
  const linkRe = /\]\((https?:\/\/[^)\s]+)\)/g;
  const firsts: { at: number; product: StoreProduct }[] = [];
  for (const m of text.matchAll(linkRe)) {
    const p = storeProduct(m[1]!);
    const at = text.lastIndexOf('\n', m.index!) + 1;
    // A Walmart store purchase prints each scan as its own block (15 towels = 15 pictures): a new picture of the
    // same product is another block, added up below. Elsewhere a product's first link starts its only block.
    const again = p?.store === 'walmart' && text.startsWith('[![', at) && !firsts.some(f => f.at === at);
    if (p && (again || !firsts.some(f => f.product.store === p.store && f.product.id === p.id))) {
      // The block starts on the link's own line: Amazon's name is the picture's description, "[![name](img)](url)".
      firsts.push({ at, product: p });
    }
  }
  const store: Store | null = firsts[0]?.product.store ?? (/walmart\.com/i.test(text) ? 'walmart' : /amazon\.com/i.test(text) ? 'amazon' : null);
  const endAt = (() => {
    const m = /\n(?:#+\s*)?(?:How can we help\?|Subtotal \(|Item\(s\) Subtotal|Order Summary)/i.exec(text.slice(firsts.at(-1)?.at ?? 0));
    return m ? (firsts.at(-1)?.at ?? 0) + m.index : text.length;
  })();
  const lines = firsts.map((f, i): OrderLine => {
    const block = text.slice(f.at, i + 1 < firsts.length ? firsts[i + 1]!.at : endAt);
    // The name: the link's own words, else the picture's description; a link's words may sit on their own lines.
    const named = [...block.matchAll(/\[(?!!)\s*([^[\]]+?)\s*\]\(([^)\s]+)\)/g)].find(m => storeProduct(m[2]!)?.id === f.product.id)?.[1];
    const alt = /!\[([^\]]+)\]/.exec(block)?.[1];
    const name = (named ?? alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || f.product.id;
    // Prices outside the links (a picture's address can hold digits) — and not the "5.9¢/fl oz" unit price.
    const plain = block.replace(/\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)/g, ' ');
    const qtyW = /\bQty\s*(\d+)/i.exec(plain);
    const qtyA = /^\s*(\d{1,3})\s*$/m.exec(plain);
    const qty = Number(qtyW?.[1] ?? qtyA?.[1] ?? 1) || 1;
    const each = money(/\$([\d,]+\.\d{2})\s*ea\b/i.exec(plain)?.[1]);
    // Not the list price ("$14.97/ea"), the saving ("$2.00 from savings") nor the old price ("Was $14.96").
    const price = money([...plain.matchAll(/(?<!Was\s*)\$([\d,]+\.\d{2})(?!\d|\s*(?:\/\s*)?ea\b|\s*from savings)/gi)][0]?.[1]);
    // Walmart's price is the line's; Amazon's is one's.
    const amazon = f.product.store === 'amazon';
    const amount = price == null ? null : amazon ? Math.round(price * qty * 100) / 100 : price;
    // Walmart's "$1.00 ea" on a 6-pack is one mug's: one product's price is the line's ÷ its quantity.
    const unitPrice = amazon ? price : price != null ? Math.round(price / qty * 100) / 100 : each;
    return { text: name, product: f.product, qty, amount, unitPrice, ...packOf(name, plain) };
  }).reduce<OrderLine[]>((all, l) => {
    // Same product and pack = the same thing scanned again; a 4-pack and an 8-pack of one product stay two lines.
    const same = all.find(x => x.product.store === l.product.store && x.product.id === l.product.id && x.pack === l.pack);
    if (!same) return [...all, l];
    same.qty += l.qty;
    same.amount = same.amount == null || l.amount == null ? null : Math.round((same.amount + l.amount) * 100) / 100;
    same.unitPrice = same.amount == null ? same.unitPrice : Math.round(same.amount / same.qty * 100) / 100;
    return all;
  }, []);
  const sub = /Subtotal\s*\((\d+)\s*items?\)\s*\$([\d,]+\.\d{2})/i.exec(text);
  const subA = /Item\(s\) Subtotal:?\s*\$([\d,]+\.\d{2})/i.exec(text);
  const tax = /(?:Estimated tax to be collected|Taxes?)\s*:?\s*(?:Taxes?\s*)?\$([\d,]+\.\d{2})/i.exec(text);
  const grand = /(?:Grand Total|Order Total)\s*:?\s*\$([\d,]+\.\d{2})/i.exec(text) ?? /(?:^|[^A-Za-z(])Total\s*:?\s*\$([\d,]+\.\d{2})/.exec(text.replace(/Total before tax/gi, ''));
  const beforeTax = money(/Total before tax:?\s*\$([\d,]+\.\d{2})/i.exec(text)?.[1]);
  const taxN = money(tax?.[1]);
  const total = money(grand?.[1]) ?? (beforeTax != null ? Math.round((beforeTax + (taxN ?? 0)) * 100) / 100 : null);
  // A store purchase has no order number: its TC# (the receipt's) stands for it.
  const orderNo = /(?:Order|TC)\s*#\s*:?\s*([0-9][0-9-]{8,})/i.exec(text)?.[1] ?? null;
  const date = isoDate(/Order placed\s+([A-Za-z]+\.? \d{1,2}, \d{4})/i.exec(text)?.[1]) ?? isoDate(/([A-Za-z]{3,9}\.? \d{1,2}, \d{4})\s+(?:order|purchase)\b/i.exec(text)?.[1]);
  return { store, orderNo, date, subtotal: money(sub?.[2] ?? subA?.[1]), tax: taxN, total, count: sub ? Number(sub[1]) : null, lines };
}

const single = (w: string) => w.toLowerCase().replace(/(?<=[a-z]{3})(es|s)$/, '').replace(/^pak$|^pac$/, 'pack');
/** How many of the supply's measure one bought product is — remembered first, else the pack printed when it counts the same thing. */
export function packFor(line: Pick<OrderLine, 'pack' | 'packWord'>, measure: string, remembered?: number | null): number {
  if (remembered && remembered > 0) return remembered;
  if (!line.pack) return 1;
  const m = single(measure);
  if (['pack', 'box', 'case', 'set', 'kit'].includes(m)) return 1;
  return line.packWord === 'count' || line.packWord === 'ct' || single(line.packWord ?? '') === m ? line.pack : 1;
}

/** A supply's buying options for one store's product. */
const optionOf = (it: ReceiptItem & { buyOptions?: BuyOption[] }, p: StoreProduct) =>
  (it.buyOptions ?? []).find(o => { const q = storeProduct(o.url); return q?.store === p.store && q.id === p.id; });

/** How a line was matched: its product number on a supply · a text a person decided before · a look-alike to confirm · nothing. */
export type Match = 'product' | 'alias' | 'guess' | 'none';

/**
 * The order's lines as receipt lines for the purchase form: a supply only when SURE — its product number is on
 * exactly one supply (on several = a set, split into each), or a person decided that text before. Otherwise the look-alikes are offered (≈ not exact) or
 * nothing (✕ no match), and the person decides. Fees and savings the lines do not explain become one line, so the
 * lines plus tax add up to the total.
 */
export function readOrder(o: StoreOrder, items: (ReceiptItem & { buyOptions?: BuyOption[] })[], orders: ReceiptOrder[] = [],
                          aliases: Map<string, string> = new Map()): Receipt {
  const active = items.filter(i => i.active !== false);
  const lines: ReceiptLine[] = o.lines.flatMap((l): ReceiptLine[] => {
    const owners = active.filter(i => optionOf(i, l.product));
    // A set (owner, 2026-10-15): one product on several supplies — the Swirl flatware on Forks ×16, Knives ×8 and
    // Spoons ×24, a sheet set on Sheet sets ×1 and Pillowcases ×2 — is split into one line per supply, each counting
    // its own pieces; the price is shared evenly (the cents left over on the first) so the lines still add up.
    if (owners.length > 1) {
      const share = l.amount == null ? null : Math.floor(l.amount / owners.length * 100) / 100;
      return owners.map((it, k): ReceiptLine => {
        const amount = share == null ? null : k ? share : Math.round((l.amount! - share * (owners.length - 1)) * 100) / 100;
        return { text: `${l.text} — ${it.name}${it.size ? ` (${it.size})` : ''}`, qty: l.qty, amount, kind: 'item', itemId: it.id,
                 unitPrice: amount == null ? null : Math.round(amount / l.qty * 100) / 100,
                 itemQty: Math.round(l.qty * packFor(l, it.measure, optionOf(it, l.product)?.pack) * 100) / 100, candidates: [],
                 orderId: orderFor(it.id, orders), size: null, newName: null, product: l.product, match: 'product', pack: l.pack, packWord: l.packWord };
      });
    }
    const learned = aliases.get(aliasKey(l.text));
    const byAlias = learned ? active.find(i => i.id === learned) : undefined;
    const it = owners.length === 1 ? owners[0]! : byAlias;
    const match: Match = owners.length === 1 ? 'product' : byAlias ? 'alias' : 'none';
    const candidates = it ? [] : [...new Set([...owners.map(i => i.id), ...similarItems(l.text, active, 8).filter(c => !wrongSize(active.find(i => i.id === c)!, null, active))])].slice(0, 4);
    const pack = it ? packFor(l, it.measure, optionOf(it, l.product)?.pack) : null;
    return [{ text: l.text, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount, kind: 'item', itemId: it?.id ?? null,
             itemQty: it ? Math.round(l.qty * pack! * 100) / 100 : l.qty, candidates, orderId: orderFor(it?.id ?? null, orders), size: null, newName: null,
             product: l.product, match: it ? match : candidates.length ? 'guess' : 'none', pack: l.pack, packWord: l.packWord }];
  });
  const sum = Math.round(lines.reduce((a, l) => a + (l.amount ?? 0), 0) * 100) / 100;
  const rest = o.total != null ? Math.round((o.total - sum - (o.tax ?? 0)) * 100) / 100 : 0;
  if (Math.abs(rest) >= 0.01 && o.lines.length) {
    lines.push({ text: rest < 0 ? 'Savings and promotions' : 'Fees (shipping, bag, delivery)', qty: null, unitPrice: null, amount: rest,
                 kind: rest < 0 ? 'discount' : 'fee', itemId: null, itemQty: null, candidates: [], orderId: null, size: null, newName: null });
  }
  return { store: o.store ? STORE_NAME[o.store] : null, date: o.date, total: o.total, tax: o.tax, orderNo: o.orderNo, lines };
}

/**
 * The bought product remembered on its supply, first, with its pack. A supply has ONE Walmart/Amazon product
 * (owner, 2026-10-15): bought elsewhere, the new one replaces it; other stores' links (Costco…) stay.
 */
export function withProduct(options: BuyOption[], url: string, pack: number | null): BuyOption[] {
  const p = storeProduct(url);
  if (!p) return options;
  const old = options.find(o => { const q = storeProduct(o.url); return q?.store === p.store && q.id === p.id; });
  const kept: BuyOption = { label: old?.label || STORE_NAME[p.store], url: old?.url ?? p.url, ...(pack && pack > 0 ? { pack } : old?.pack ? { pack: old.pack } : {}) };
  return [kept, ...options.filter(o => !storeProduct(o.url))].slice(0, 10);
}

/**
 * What the saved page may have left out (owner, 2026-10-15 — checked on every read, not left to memory): the order
 * number and date (Walmart's selection started below the title), and products (they do not add up to the subtotal).
 */
export function orderWarnings(o: StoreOrder): string[] {
  const out: string[] = [];
  const from = o.store === 'walmart' ? ' — select from the order\'s title ("Oct 15, 2026 order") down to Total' : '';
  if (!o.orderNo || !o.date) out.push(`No ${!o.orderNo && !o.date ? 'order number or date' : !o.orderNo ? 'order number' : 'order date'} in the file${from}: a repeat is told only if the file is identical.`);
  const sum = Math.round(o.lines.reduce((a, l) => a + (l.amount ?? 0), 0) * 100) / 100;
  const n = o.lines.reduce((a, l) => a + l.qty, 0);
  if (o.subtotal != null && Math.abs(sum - o.subtotal) >= 0.01) out.push(`The products add up to $${sum.toFixed(2)}, the subtotal says $${o.subtotal.toFixed(2)} — some may be missing from the file${from}.`);
  else if (o.count != null && n !== o.count) out.push(`${n} items read, the order says ${o.count} — check the quantities.`);
  return out;
}

/**
 * Walmart's cart for an order (verified 2026-10-15: affil.walmart.com/cart/addToCart?items=<item id>|<qty>,… fills the
 * signed-in cart). Amazon's add-to-cart form (gp/aws/cart/add.html) only opened the cart as it was, so an Amazon supply
 * is its product page and how many. As many as cover the order: ⌈qty ÷ pack⌉. Supplies with neither are named.
 */
export function cartLinks(lines: { itemId: string; qty: number }[], items: { id: string; name: string; buyOptions?: BuyOption[] }[]) {
  const want = new Map<string, number>();
  for (const l of lines) if (l.qty > 0) want.set(l.itemId, (want.get(l.itemId) ?? 0) + l.qty);
  const walmart: { id: string; qty: number; itemId: string }[] = [];
  const amazon: { url: string; qty: number; itemId: string }[] = [];
  const none: string[] = [];
  for (const [itemId, qty] of want) {
    const it = items.find(i => i.id === itemId);
    const opt = (it?.buyOptions ?? []).find(o => storeProduct(o.url));
    const p = opt ? storeProduct(opt.url)! : null;
    if (!p) { none.push(itemId); continue; }
    const n = Math.max(1, Math.ceil(Math.round(qty / (opt!.pack && opt!.pack > 0 ? opt!.pack : 1) * 1000) / 1000));
    // A set on several supplies (forks, knives, spoons): bought as many times as the supply that needs most asks.
    if (p.store === 'amazon') { const had = amazon.find(x => x.url === p.url); if (had) had.qty = Math.max(had.qty, n); else amazon.push({ url: p.url, qty: n, itemId }); continue; }
    const had = walmart.find(x => x.id === p.id);
    if (had) had.qty = Math.max(had.qty, n); else walmart.push({ id: p.id, qty: n, itemId });
  }
  const url = walmart.length ? `https://affil.walmart.com/cart/addToCart?items=${walmart.map(x => `${x.id}|${x.qty}`).join(',')}` : null;
  return { walmart: { url, items: walmart }, amazon, none };
}

/**
 * What the receipt says against what was ordered, per supply (in its measure): ordered and not bought,
 * bought fewer or more, bought without being ordered.
 */
export function againstOrder(ordered: Map<string, number>, bought: Map<string, number>) {
  const missing: string[] = [], fewer: string[] = [], more: string[] = [], extra: string[] = [], ok: string[] = [];
  for (const [id, q] of ordered) {
    const b = bought.get(id) ?? 0;
    if (!b) missing.push(id); else if (b < q) fewer.push(id); else if (b > q) more.push(id); else ok.push(id);
  }
  for (const id of bought.keys()) if (!ordered.has(id) && (bought.get(id) ?? 0) > 0) extra.push(id);
  return { ok, missing, fewer, more, extra };
}
