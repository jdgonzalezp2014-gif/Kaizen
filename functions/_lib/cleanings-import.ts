/**
 * Reading the cleanings sheet.
 *
 * Extracted so the manual pull and the automatic refresh run the SAME
 * code. Two implementations of an import is two sets of rules about what
 * a blank price means, and they drift.
 */
import { parseCsv, parseAmount, pick } from './csv.ts';

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export interface CleaningsImport {
  ok: boolean;
  rows: number;
  logged: number;
  rated: number;
  unmatched: string[];
  problem: string | null;
}

/**
 * A cleaner, or the absence of one.
 *
 * The sheet uses the cleaner column for two different things: who is
 * doing it, and that nobody is. "🚫 Not needed" means the stay needed no
 * clean; "❓ TBD" means one is coming but unassigned. Left as written,
 * both appeared in the by-cleaner breakdown as though they were people,
 * and both counted as cleans.
 *
 * Matched on the words, not the emoji: the emoji is decoration someone
 * may drop, and a match that depends on it would silently stop working.
 */
export function readAssignment(raw: string): { cleaner: string | null; assignment: string } {
  const t = (raw ?? '').trim();
  if (!t) return { cleaner: null, assignment: 'tbd' };
  const plain = t.toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (/not needed|no cleaning|none/.test(plain)) return { cleaner: null, assignment: 'not_needed' };
  if (/^tbd$|unassigned|pending/.test(plain)) return { cleaner: null, assignment: 'tbd' };
  return { cleaner: t, assignment: 'assigned' };
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : Math.round(((a[m - 1]! + a[m]!) / 2) * 100) / 100;
};

export async function importCleanings(sql: Sql, url: string): Promise<CleaningsImport> {
  const fail = (problem: string): CleaningsImport =>
    ({ ok: false, rows: 0, logged: 0, rated: 0, unmatched: [], problem });

  if (!/^https:\/\/docs\.google\.com\//.test(url)) {
    return fail('That is not a docs.google.com URL. Paste the published-CSV link.');
  }

  let csv: string;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csv = await res.text();
  } catch (e) {
    return fail(`Could not read the sheet: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A sheet that is shared but not PUBLISHED serves a sign-in page with a
  // 200 and a body of HTML, which parses to zero rows and reads as "the
  // sheet is empty" rather than "it was never readable".
  if (/^\s*</.test(csv)) {
    return fail('That URL returned a web page, not CSV — the sheet is shared but not published.');
  }

  const units = (await sql`SELECT id, name FROM units WHERE account_id = 1`) as
    { id: string; name: string }[];
  if (!units.length) return fail('No units synced yet — rows are matched by name.');
  const byName = new Map(units.map(u => [u.name.toLowerCase().replace(/\s+/g, ''), u.id]));

  const rows = parseCsv(csv);
  const unmatched: string[] = [];
  const perUnit = new Map<string, { standard: number[]; deep: number[] }>();
  let logged = 0;

  for (const r of rows) {
    const name = pick(r, 'unit', 'internal name', 'listing', 'property', 'name');
    const checkout = pick(r, 'checkout', 'check-out', 'date');
    if (!name || !checkout) continue;

    const id = byName.get(name.toLowerCase().replace(/\s+/g, '')) ?? null;
    if (!id && !unmatched.includes(name)) unmatched.push(name);

    const amount = parseAmount(pick(r, 'price', 'cleaning', 'cost', 'amount'));
    const deep = /^(y|yes|true|1|x)$/i.test(pick(r, 'deep', 'deep clean').trim());
    const resId = pick(r, 'res id', 'resid', 'reservation id');
    const key = resId || `${name}|${checkout}`;
    const who = readAssignment(pick(r, 'cleaner'));

    await sql`
      INSERT INTO cleanings
        (account_id, key, unit_id, unit_name, checkout_on, cleaner, assignment,
         guest, price, deep, urgency, reservation_note)
      VALUES (1, ${key}, ${id}, ${name}, ${checkout.slice(0, 10)},
              ${who.cleaner}, ${who.assignment}, ${pick(r, 'guest') || null},
              ${amount != null && amount > 0 ? amount : null},
              ${deep}, ${pick(r, 'urgency') || null}, ${pick(r, 'notes') || null})
      ON CONFLICT (account_id, key) DO UPDATE SET
        unit_id = EXCLUDED.unit_id, unit_name = EXCLUDED.unit_name,
        checkout_on = EXCLUDED.checkout_on, cleaner = EXCLUDED.cleaner,
        assignment = EXCLUDED.assignment,
        guest = EXCLUDED.guest, price = EXCLUDED.price, deep = EXCLUDED.deep,
        urgency = EXCLUDED.urgency, reservation_note = EXCLUDED.reservation_note,
        imported_at = now()
    `;
    logged++;

    // Priced, actually-cleaned rows only. A clean with no figure is "not
    // priced yet" and counting it as zero would drag the unit's rate
    // towards nothing; a stay that needed no clean is not a data point
    // about what cleaning costs at all.
    if (id && amount != null && amount > 0 && who.assignment !== 'not_needed') {
      const e = perUnit.get(id) ?? { standard: [], deep: [] };
      (deep ? e.deep : e.standard).push(amount);
      perUnit.set(id, e);
    }
  }

  // The MEDIAN of the standard cleans, not the most recent. The same unit
  // legitimately shows different prices — a deep clean costs more, and
  // cleaners differ — so "latest wins" would set a recurring cost from
  // whichever clean happened to be last.
  let rated = 0;
  for (const [id, e] of perUnit) {
    const amount = e.standard.length ? median(e.standard) : median(e.deep);
    await sql`
      UPDATE units SET cleaning_fee = ${amount}, cleaning_fee_source = 'sheet',
                       cleaning_fee_at = now()
       WHERE account_id = 1 AND id = ${id}`;
    rated++;
  }

  return { ok: true, rows: rows.length, logged, rated, unmatched, problem: null };
}
