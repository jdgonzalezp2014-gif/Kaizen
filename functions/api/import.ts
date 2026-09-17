/**
 * POST /api/import — bring an existing costs or claims spreadsheet in.
 *
 * A host moving onto this system has years of cost history in a Google
 * Sheet. Asking them to retype it is asking them not to switch, so File →
 * Download → CSV → drop it here has to work.
 *
 * Two passes, always. The first is a DRY RUN that reports what would
 * happen and what could not be matched; nothing is written. Nobody should
 * discover a column was misread by finding it in their accounts.
 *
 * Rows are matched to units by NAME, because a spreadsheet says "CL1339",
 * never a Hostaway listing id. Unmatched rows are reported, never guessed
 * at and never silently dropped.
 */
import { parseCsv, parseAmount, parseDate, pick } from '../_lib/csv.ts';
import { db, type Env } from '../_lib/db.ts';
import { userEmail } from '../_lib/auth.ts';

type Kind = 'expenses' | 'claims';

interface Parsed {
  row: number;
  unitName: string;
  unitId: string | null;
  date: string;
  amount: number | null;
  category: string;
  notes: string;
  severity?: string;
  problem?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  const kind = (body.kind === 'claims' ? 'claims' : 'expenses') as Kind;
  const csv = String(body.csv ?? '');
  const dryRun = body.commit !== true;
  const dayFirst = body.dayFirst === true;

  if (!csv.trim()) return Response.json({ ok: false, error: 'No CSV supplied.' }, { status: 400 });

  const units = await sql`SELECT id, name FROM units WHERE account_id = 1` as { id: string; name: string }[];
  // Matched case- and space-insensitively: a sheet will say "CL 1446"
  // where Hostaway says "CL1446", and that is not a different apartment.
  const byName = new Map(units.map(u => [u.name.toLowerCase().replace(/\s+/g, ''), u.id]));

  const rows = parseCsv(csv);
  const parsed: Parsed[] = rows.map((r, i) => {
    const unitName = pick(r, 'unit', 'internal name', 'listing', 'property', 'name');
    const key = unitName.toLowerCase().replace(/\s+/g, '');
    const unitId = unitName ? (byName.get(key) ?? null) : null;

    const date = parseDate(
      pick(r, 'date', 'start date', 'occurred on', 'occurred'), dayFirst);
    const amount = parseAmount(
      pick(r, 'amount', 'cost', 'total', 'refund', 'repair cost'));

    let problem: string | undefined;
    if (!date) problem = 'no readable date';
    else if (kind === 'expenses' && amount === null) problem = 'no readable amount';
    else if (unitName && !unitId) problem = `no unit named "${unitName}"`;

    return {
      row: i + 2,                      // +2: 1-indexed, plus the header
      unitName, unitId, date, amount,
      category: pick(r, 'category', 'type') || 'General',
      notes: pick(r, 'notes', 'description', 'detail'),
      severity: pick(r, 'severity') || 'Medium',
      problem
    };
  });

  const ready = parsed.filter(p => !p.problem);
  const skipped = parsed.filter(p => p.problem);

  if (dryRun) {
    return Response.json({
      ok: true, dryRun: true, kind,
      total: parsed.length, ready: ready.length, skipped: skipped.length,
      // Capped: a 4,000-row sheet with a misnamed column would otherwise
      // return 4,000 identical complaints.
      problems: skipped.slice(0, 25).map(p => ({ row: p.row, problem: p.problem })),
      preview: ready.slice(0, 5)
    });
  }

  const by = userEmail(request);
  let written = 0;
  for (const p of ready) {
    if (kind === 'expenses') {
      await sql`
        INSERT INTO expenses (account_id, unit_id, shared, start_date, category,
                              frequency, amount, source, notes, created_by)
        VALUES (1, ${p.unitId}, ${p.unitId === null}, ${p.date}, ${p.category},
                'One-time', ${p.amount}, 'import:csv', ${p.notes}, ${by})
      `;
    } else {
      await sql`
        INSERT INTO claims (account_id, unit_id, occurred_on, category,
                            severity, description, created_by)
        VALUES (1, ${p.unitId}, ${p.date}, ${p.category},
                ${p.severity}, ${p.notes}, ${by})
      `;
    }
    written++;
  }

  return Response.json({
    ok: true, dryRun: false, kind, written,
    skipped: skipped.length,
    problems: skipped.slice(0, 25).map(p => ({ row: p.row, problem: p.problem }))
  });
};
