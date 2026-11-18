/**
 * A count written down instead of tapped (owner, 2026-11-17: "let me upload .md documents so the counts load by
 * themselves"): a Markdown or plain-text list — the template below, a note typed on the phone, a table — fills the
 * onsite count sheet. Nothing is saved from here: the sheet shows each filled number against the record, and a person
 * saves it as any count. No AI: a line either names an item on the list, closely enough to be sure, or it is shown as
 * not matched.
 */

export interface CountLine { name: string; qty: number; raw: string }
export interface MatchItem { id: string; name: string; baseName?: string | null; measure?: string | null }
export interface CountMatch { matched: { itemId: string; qty: number; line: CountLine; close: boolean }[]; unmatched: CountLine[] }

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;

/**
 * One item and its number per line, in the shapes people write:
 * `- Paper towels: 12` · `Paper towels — 12 rolls` · `| Paper towels | 12 |` · `12 x Paper towels` · `Paper towels 12`.
 * Headings, blank lines, a table's header and separator, and lines with no number are skipped.
 */
export function parseCountText(text: string): CountLine[] {
  const out: CountLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('>') || /^\|?\s*:?-{2,}/.test(l)) continue;
    if (/^(date|fecha|by|por)\s*:/i.test(l) || /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l)) continue;   // the template's date line
    if (l.startsWith('|')) {
      // A table row: the first cell with letters is the name, the first number-only cell is the count.
      const cells = l.split('|').map(c => c.trim()).filter(Boolean);
      const name = cells.find(c => /[a-z]/i.test(c) && !/^\d/.test(c));
      const n = cells.find(c => new RegExp(`^${NUM}$`).test(c));
      if (name && n) out.push({ name: clean(name), qty: num(n), raw });
      continue;
    }
    l = l.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?/, '');            // bullets, "1.", checkboxes
    let m = new RegExp(`^${NUM}\\s*(?:x|×)\\s+(.+)$`, 'i').exec(l);     // 12 x Paper towels
    if (m) { out.push({ name: clean(m[2]!), qty: num(m[1]!), raw }); continue; }
    m = new RegExp(`^(.+?)\\s*(?:[:=—–-]|\\s)\\s*${NUM}(?:\\s+[a-z ]{1,20})?\\.?$`, 'i').exec(l); // Name: 12 [rolls]
    if (m && /[a-z]/i.test(m[1]!)) out.push({ name: clean(m[1]!), qty: num(m[2]!), raw });
  }
  return out;
}

const num = (s: string) => Math.max(0, Math.min(99999, Number(s.replace(',', '.'))));
/** Drop what a person adds around a name: **bold**, the "(roll)" of the template, trailing punctuation. */
const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/[:\s—–-]+$/, '').trim();

/** Lowercase words, plural "s" off, so "Paper Towels" = "paper towel". */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9áéíóúñ ]+/g, ' ').split(/\s+/).filter(Boolean).map(w => w.length > 3 ? w.replace(/(es|s)$/, '') : w);
}

/**
 * Each line to one item: the same words (in any order) → sure; else the item sharing most words, when it shares at
 * least two thirds of the line's and no other item ties it → close (shown as such). Anything else is not matched —
 * never a guess between two.
 */
export function matchCounts(lines: CountLine[], items: MatchItem[]): CountMatch {
  const keyed = items.map(i => ({ i, w: new Set(words(i.baseName || i.name)), w2: new Set(words(i.name)) }));
  const matched: CountMatch['matched'] = [];
  const unmatched: CountLine[] = [];
  for (const line of lines) {
    const lw = [...new Set(words(line.name))];
    if (!lw.length) { unmatched.push(line); continue; }
    const same = keyed.filter(k => [k.w, k.w2].some(w => w.size === lw.length && lw.every(x => w.has(x))));
    if (same.length === 1) { matched.push({ itemId: same[0]!.i.id, qty: line.qty, line, close: false }); continue; }
    const scored = keyed.map(k => ({ k, s: lw.filter(x => k.w2.has(x) || k.w.has(x)).length / Math.max(lw.length, k.w.size) }))
      .filter(x => x.s >= 2 / 3).sort((a, b) => b.s - a.s);
    if (scored.length && (scored.length === 1 || scored[0]!.s > scored[1]!.s)) matched.push({ itemId: scored[0]!.k.i.id, qty: line.qty, line, close: true });
    else unmatched.push(line);
  }
  return { matched, unmatched };
}

/** The template to fill (on paper, in a notes app, by an assistant): one line per item on this place's list. */
export function countTemplate(place: string, items: MatchItem[], day: string): string {
  return [`# Count — ${place}`, '', `Date: ${day}`, '', 'Write how many there are after each colon. Leave a line blank if you did not count it.', '',
    ...items.map(i => `- ${i.baseName || i.name}${i.measure ? ` (${i.measure})` : ''}: `), ''].join('\n');
}
