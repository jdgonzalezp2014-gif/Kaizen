/**
 * Reading the cleanings sheet.
 *
 * Extracted so the manual pull and the automatic refresh run the SAME
 * code. Two implementations of an import is two sets of rules about what
 * a blank price means, and they drift.
 */
import { firstRowWidth, parseCsv, parseCsvWithHeader, parseAmount, pick } from './csv.ts';

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export interface CleaningsImport {
  ok: boolean;
  rows: number;
  logged: number;
  rated: number;
  unmatched: string[];
  problem: string | null;
  /** Read, but something about the sheet needs a human. */
  warning?: string | null;
}

/**
 * The daily file's Cleanings Log, column for column (`15 cleaningslog.js`,
 * CL_HEADERS). That project fixes the layout — "the same 12 columns, in
 * the same order" — and says so in its own README.
 */
export const CLEANINGS_LOG_COLUMNS = [
  'Updated', 'Checkout', 'Unit', 'Guest', 'Beds', 'Cleaner',
  'Price', 'Time', 'Deep', 'Urgency', 'Notes', 'Res ID'
];

/**
 * Rows of the log, surviving a lost header.
 *
 * Seen on the live sheet in September 2026: the published header row
 * came through blank except for `Res ID`. Every lookup by name then
 * missed, every row was skipped for having no unit, and the import
 * reported success while writing nothing — so the cleanings on screen
 * quietly stopped moving.
 *
 * Recognised narrowly: exactly the log's twelve columns, the last one
 * still named `Res ID`, and no `Unit` column anywhere. Only then is the
 * fixed order used, and the result says it was.
 */
export function readCleaningsLog(csv: string): { rows: Record<string, string>[]; repaired: boolean } {
  const rows = parseCsv(csv);
  const first = rows[0];
  const headerLost = !!first && !('unit' in first) && ('resid' in first) &&
    firstRowWidth(csv) === CLEANINGS_LOG_COLUMNS.length;
  return headerLost
    ? { rows: parseCsvWithHeader(csv, CLEANINGS_LOG_COLUMNS), repaired: true }
    : { rows, repaired: false };
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

  const { rows, repaired } = readCleaningsLog(csv);
  const unmatched: string[] = [];
  const perUnit = new Map<string, { standard: number[]; deep: number[] }>();

  // Collected into columns, then written in ONE statement.
  //
  // A row at a time meant one HTTP round trip to Postgres per clean: at
  // 202 rows that is 202 requests and twenty-five seconds, and the person
  // who happens to open the tab when the cache expires pays all of it.
  // The work was never the problem — the waiting was.
  const col = {
    key: [] as string[], unit: [] as (string | null)[], name: [] as string[],
    date: [] as string[], cleaner: [] as (string | null)[], assign: [] as string[],
    guest: [] as (string | null)[], price: [] as (number | null)[],
    deep: [] as boolean[], urgency: [] as (string | null)[], note: [] as (string | null)[],
    time: [] as (string | null)[], beds: [] as (number | null)[]
  };

  for (const r of rows) {
    const name = pick(r, 'unit', 'internal name', 'listing', 'property', 'name');
    const checkout = pick(r, 'checkout', 'check-out', 'date');
    if (!name || !checkout) continue;

    const id = byName.get(name.toLowerCase().replace(/\s+/g, '')) ?? null;
    if (!id && !unmatched.includes(name)) unmatched.push(name);

    const amount = parseAmount(pick(r, 'price', 'cleaning', 'cost', 'amount'));
    const deep = /^(y|yes|true|1|x)$/i.test(pick(r, 'deep', 'deep clean').trim());
    const resId = pick(r, 'res id', 'resid', 'reservation id');
    const who = readAssignment(pick(r, 'cleaner'));

    col.key.push(resId || `${name}|${checkout}`);
    col.unit.push(id);
    col.name.push(name);
    col.date.push(checkout.slice(0, 10));
    col.cleaner.push(who.cleaner);
    col.assign.push(who.assignment);
    col.guest.push(pick(r, 'guest') || null);
    col.price.push(amount != null && amount > 0 ? amount : null);
    col.deep.push(deep);
    col.urgency.push(pick(r, 'urgency') || null);
    col.note.push(pick(r, 'notes') || null);
    // What the operations board needs to show a turnover without the
    // sheet: the checkout time a person set on Main, and the bedroom
    // count the price was read against.
    col.time.push(pick(r, 'time', 'checkout time') || null);
    const beds = Number(pick(r, 'beds', 'bedrooms'));
    col.beds.push(Number.isInteger(beds) && beds > 0 ? beds : null);

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

  const logged = col.key.length;
  if (logged) {
    await sql`
      INSERT INTO cleanings
        (account_id, key, unit_id, unit_name, checkout_on, cleaner, assignment,
         guest, price, deep, urgency, reservation_note, checkout_time, beds)
      SELECT 1, k, u, n, d, c, a, g, p, dp, ug, rn, tm, bd
        FROM unnest(${col.key}::text[], ${col.unit}::text[], ${col.name}::text[],
                    ${col.date}::date[], ${col.cleaner}::text[], ${col.assign}::text[],
                    ${col.guest}::text[], ${col.price}::numeric[], ${col.deep}::boolean[],
                    ${col.urgency}::text[], ${col.note}::text[], ${col.time}::text[],
                    ${col.beds}::smallint[])
             AS t(k, u, n, d, c, a, g, p, dp, ug, rn, tm, bd)
      ON CONFLICT (account_id, key) DO UPDATE SET
        unit_id = EXCLUDED.unit_id, unit_name = EXCLUDED.unit_name,
        checkout_on = EXCLUDED.checkout_on, cleaner = EXCLUDED.cleaner,
        assignment = EXCLUDED.assignment, guest = EXCLUDED.guest,
        price = EXCLUDED.price, deep = EXCLUDED.deep, urgency = EXCLUDED.urgency,
        reservation_note = EXCLUDED.reservation_note,
        checkout_time = EXCLUDED.checkout_time, beds = EXCLUDED.beds, imported_at = now()
    `;
  }

  // The MEDIAN of the standard cleans, not the most recent. The same unit
  // legitimately shows different prices — a deep clean costs more, and
  // cleaners differ — so "latest wins" would set a recurring cost from
  // whichever clean happened to be last. One statement again.
  const ids = [...perUnit.keys()];
  const fees = ids.map(id => {
    const e = perUnit.get(id)!;
    return e.standard.length ? median(e.standard) : median(e.deep);
  });
  if (ids.length) {
    await sql`
      UPDATE units SET cleaning_fee = t.fee, cleaning_fee_source = 'sheet',
                       cleaning_fee_at = now()
        FROM unnest(${ids}::text[], ${fees}::numeric[]) AS t(id, fee)
       WHERE units.account_id = 1 AND units.id = t.id
    `;
  }
  const rated = ids.length;

  // Rows that all failed to parse are a broken sheet, not an empty week.
  // Reported as a failure so nothing downstream reads "0 logged" as news.
  if (rows.length > 0 && logged === 0) {
    return { ok: false, rows: rows.length, logged, rated, unmatched,
      problem: `Read ${rows.length} row(s) but none had a unit and a checkout date — check the header row of the Cleanings Log.` };
  }

  return { ok: true, rows: rows.length, logged, rated, unmatched, problem: null,
    warning: repaired
      ? 'The Cleanings Log\'s header row is blank in the sheet, so it was read by its fixed column order. Restore the headers (Updated, Checkout, Unit, …) in the sheet.'
      : null };
}
