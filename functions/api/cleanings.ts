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
  const matched: { id: string; name: string; amount: number }[] = [];
  const unmatched: string[] = [];

  for (const r of rows) {
    const name = pick(r, 'unit', 'internal name', 'listing', 'property', 'name');
    const amt = parseAmount(pick(r, 'cleaning', 'cleaning cost', 'cleaner pay', 'price', 'cost', 'amount'));
    if (!name || amt == null) continue;
    const id = byName.get(name.toLowerCase().replace(/\s+/g, ''));
    if (!id) { if (!unmatched.includes(name)) unmatched.push(name); continue; }
    // Last row wins: a cleanings LOG has one line per clean, and the
    // most recent price is the current one.
    const seen = matched.findIndex(m => m.id === id);
    if (seen >= 0) matched[seen]!.amount = amt; else matched.push({ id, name, amount: amt });
  }

  if (body.commit !== true) {
    return Response.json({ ok: true, dryRun: true, matched, unmatched,
      message: `${matched.length} unit(s) would be updated` +
               (unmatched.length ? `; ${unmatched.length} name(s) in the sheet match no unit.` : '.') });
  }

  for (const m of matched) {
    await sql`UPDATE units SET cleaning_fee = ${m.amount}, cleaning_fee_source = 'sheet',
                               cleaning_fee_at = now()
               WHERE account_id = 1 AND id = ${m.id}`;
  }
  if (body.url) await sql`UPDATE accounts SET cleanings_csv_url = ${url} WHERE id = 1`;

  return Response.json({ ok: true, dryRun: false, updated: matched.length, matched, unmatched });
};
