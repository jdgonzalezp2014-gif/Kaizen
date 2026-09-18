/**
 * POST /api/cleanings — pull what cleaners are PAID from a Google Sheet.
 *
 * This is the one number still coming from the old spreadsheet, and it
 * is NOT the cleaning fee Hostaway already knows. Hostaway's
 * `cleaningFee` is what the GUEST is charged; it is revenue. What the
 * sheet holds is what the cleaner is paid, which is a cost. Treating one
 * as the other is a two-sided error — it inflates revenue and erases an
 * expense at the same time, so the net is wrong by roughly twice the
 * cleaning on every single booking.
 *
 * A published-CSV URL rather than the Sheets API: no OAuth, no service
 * account, no secret to rotate, and the next host points it at their own
 * sheet without anyone deploying anything.
 *
 *   In the sheet:  File → Share → Publish to web → the sheet, CSV.
 */
import { parseCsv, parseAmount, pick } from '../_lib/csv.ts';
import { importCleanings } from '../_lib/cleanings-import.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  const body = await request.json().catch(() => ({})) as { url?: string; commit?: boolean };
  const url = (body.url ?? account?.cleaningsCsvUrl ?? '').trim();

  if (!url) {
    return Response.json({ ok: false, error: 'no_url',
      message: 'No cleanings sheet configured. In the sheet: File → Share → Publish to web → ' +
               'choose the Cleanings log tab and CSV, then paste the URL in Settings.' }, { status: 400 });
  }
  if (!/^https:\/\/docs\.google\.com\//.test(url)) {
    return Response.json({ ok: false, error: 'bad_url',
      message: 'That is not a docs.google.com URL. Paste the published-CSV link, not the editing link.' },
      { status: 400 });
  }

  let csv: string;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csv = await res.text();
  } catch (e) {
    return Response.json({ ok: false, error: 'fetch_failed',
      message: `Could not read the sheet: ${e instanceof Error ? e.message : String(e)}. ` +
               'A published sheet needs no sign-in — if this returned HTML, publishing is probably off.' },
      { status: 502 });
  }
  // A sheet that is shared but not PUBLISHED serves a sign-in page, with
  // a 200 and a body full of HTML. Parsed as CSV that is a header row of
  // markup and zero matches, reported as "0 units updated" — which reads
  // like the sheet is empty rather than like it was never readable.
  if (/^\s*</.test(csv)) {
    return Response.json({ ok: false, error: 'not_published',
      message: 'That URL returned a web page, not CSV — the sheet is shared but not published. ' +
               'Use File → Share → Publish to web.' }, { status: 502 });
  }

  const units = await sql`SELECT id, name FROM units WHERE account_id = 1` as { id: string; name: string }[];
  if (!units.length) {
    return Response.json({ ok: false, error: 'no_units',
      message: 'No units synced yet — rows are matched to units by name. Sync listings first.' },
      { status: 409 });
  }
  const byName = new Map(units.map(u => [u.name.toLowerCase().replace(/\s+/g, ''), u.id]));

  const rows = parseCsv(csv);
  const seen = new Map<string, { name: string; standard: number[]; deep: number[] }>();
  const unmatched: string[] = [];
  let skipped = 0;

  for (const r of rows) {
    const name = pick(r, 'unit', 'internal name', 'listing', 'property', 'name');
    if (!name) continue;
    const amt = parseAmount(pick(r, 'price', 'cleaning', 'cleaning cost', 'cleaner pay', 'cost', 'amount'));
    // A log row with no price is a clean that was not needed, or not
    // priced yet ("TBD"). Counting it as zero would drag the unit's
    // cleaning cost down towards nothing.
    if (amt == null || amt <= 0) { skipped++; continue; }

    const id = byName.get(name.toLowerCase().replace(/\s+/g, ''));
    if (!id) { if (!unmatched.includes(name)) unmatched.push(name); continue; }

    const deep = /^(y|yes|true|1|x)$/i.test(pick(r, 'deep', 'deep clean').trim());
    const e = seen.get(id) ?? { name, standard: [], deep: [] };
    (deep ? e.deep : e.standard).push(amt);
    seen.set(id, e);
  }

  /**
   * The median of the STANDARD cleans, not the most recent one.
   *
   * This sheet is a log, one row per clean, and the same unit legitimately
   * shows different prices: a deep clean costs more, and different cleaners
   * charge differently. "Latest wins" would set one unit's recurring cost
   * from whichever clean happened to be last — P2-1304 appears at both $35
   * and $70 in the current sheet, so that choice swings its cost by double.
   *
   * Deep cleans are held out of the median and reported separately: they
   * are real but occasional, and folding them in overstates the routine
   * cost of every turnover.
   */
  const median = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m]! : Math.round((a[m - 1]! + a[m]!) / 2 * 100) / 100;
  };

  const matched = [...seen.entries()]
    .map(([id, e]) => ({
      id, name: e.name,
      amount: e.standard.length ? median(e.standard) : median(e.deep),
      samples: e.standard.length + e.deep.length,
      spread: e.standard.length > 1 && Math.min(...e.standard) !== Math.max(...e.standard)
        ? `${Math.min(...e.standard)}–${Math.max(...e.standard)}` : null,
      deepOnly: e.standard.length === 0,
      deepAvg: e.deep.length ? median(e.deep) : null
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (body.commit !== true) {
    return Response.json({ ok: true, dryRun: true, matched, unmatched, skipped,
      message: `${matched.length} unit(s) would be updated from ${rows.length} log row(s)` +
               (skipped ? `; ${skipped} row(s) had no price and were skipped` : '') +
               (unmatched.length ? `; ${unmatched.length} sheet name(s) match no unit` : '') + '.' });
  }

  // The dry run above previews; the write is the SAME code the automatic
  // refresh runs. Two implementations of an import is two sets of rules
  // about what a blank price means, and they drift.
  const result = await importCleanings(sql as never, url);
  if (!result.ok) {
    return Response.json({ ok: false, error: 'import_failed', message: result.problem },
      { status: 400 });
  }
  if (body.url) await sql`UPDATE accounts SET cleanings_csv_url = ${url} WHERE id = 1`;

  return Response.json({ ok: true, dryRun: false, updated: result.rated,
                         logged: result.logged, matched, unmatched: result.unmatched, skipped });
};
