/**
 * /api/claims — what guests complained about (or paid extra for, §162: upselling), and what it cost.
 *
 * Full CRUD, unlike the money tables, and the difference is deliberate.
 * An expense is a fact that happened once; a claim is a CASE that moves
 * — opened, investigated, refunded, closed — and a table that could only
 * be appended to would make "update the status" mean "file it again".
 *
 * What does not change is `occurred_on`: when the guest raised it, never
 * when someone got round to fixing it. Filing a July complaint in
 * September moves it into the wrong month and quietly flatters July.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { commentToThread, notifyClaim } from '../_lib/slack.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { closeDate } from '../../src/lib/claims.ts';
import { todayIn } from '../../src/lib/dates.ts';

const SEVERITY = ['Low', 'Medium', 'High', 'Critical'];
const STATUS = ['Open', 'In progress', 'Resolved', 'Refunded', 'Dismissed'];

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  // A claim's timeline (§77): notes, status changes, work added and closed.
  const updates = new URL(request.url).searchParams.get('updates');
  if (updates) {
    const rows = await sql`SELECT id, kind, body, created_by, created_at FROM work_updates
                            WHERE account_id = 1 AND subject = 'claim' AND subject_id = ${updates}
                            ORDER BY created_at, id`;
    return Response.json({ ok: true, updates: rows.map((r: any) => ({ id: String(r.id), kind: r.kind, body: r.body,
      createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() })) });
  }
  const claims = await sql`
    SELECT c.id, c.unit_id, c.occurred_on, c.category, c.severity, c.status,
           c.source, c.description, c.resolved_on,
           -- §162: what was requested and received is Finance's (/api/claims-money, its own permission) — not here.
           -- §162: the repair work is what its work cost — a work order's cost (its estimate until there is one) and
           -- what was bought on a purchase order, sub-tasks included (they carry the claim). Cancelled work costs nothing.
           (SELECT COALESCE(sum(COALESCE(t.cost_actual, CASE WHEN t.kind = 'work_order' THEN t.cost_estimate END, 0)
                                + (SELECT COALESCE(sum(p.total), 0) FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = t.id)), 0)
              FROM todos t WHERE t.account_id = 1 AND t.claim_id = c.id::text AND t.deleted_at IS NULL AND t.status <> 'cancelled') AS repair_work,
           c.created_by, c.created_at, u.name AS unit_name, c.reservation_id, c.reservation_label, c.case_url
      FROM claims c
      LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
     WHERE c.account_id = 1 AND c.deleted_at IS NULL
     ORDER BY
       -- Open cases first regardless of age: a three-month-old open
       -- claim is the one that needs attention, and sorting purely by
       -- date buries it under yesterday's resolved ones.
       (c.status IN ('Open', 'In progress')) DESC, c.occurred_on DESC
     LIMIT 500`;
  return Response.json({ ok: true, claims });
};

interface Body {
  id?: string;
  unitId?: string | null;
  occurredOn?: string;
  category?: string;
  severity?: string;
  status?: string;
  source?: string;
  description?: string;
  resolvedOn?: string | null;
  /** The stay it is about (§84), from the stay picker. */
  reservationId?: string | null;
  reservationLabel?: string | null;
  /** The case on the platform (§88): https only. */
  caseUrl?: string | null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const b = await request.json().catch(() => ({})) as Body & { action?: string; body?: string; via?: string };

  // Undo a removal (§86): the claim comes back with its figures, its
  // timeline and its linked work, which never lost the link.
  if (b.action === 'restore') {
    const rows = await sql`UPDATE claims SET deleted_at = NULL, deleted_by = NULL
                            WHERE account_id = 1 AND id::text = ${String(b.id ?? '')} AND deleted_at IS NOT NULL RETURNING id`;
    if (!rows.length) return Response.json({ ok: false, error: 'Nothing to restore.' }, { status: 404 });
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${String(b.id)}, 'change', 'Restored', ${who.email})`;
    return Response.json({ ok: true });
  }

  // An update on the case, in words (§77). Appended, never edited.
  if (b.action === 'note') {
    const text = String(b.body ?? '').trim().slice(0, 4000);
    if (!b.id || !text) return Response.json({ ok: false, error: 'An update needs words.' }, { status: 400 });
    const found = await sql`SELECT 1 FROM claims WHERE account_id = 1 AND id::text = ${String(b.id)} AND deleted_at IS NULL`;
    if (!found.length) return Response.json({ ok: false, error: 'That claim is gone.' }, { status: 404 });
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${String(b.id)}, 'note', ${text}, ${who.email})`;
    if (b.via !== 'slack-thread') waitUntil(commentToThread(sql, env.ENCRYPTION_KEY, 'claim', String(b.id), text, who.email).catch(() => {}));
    return Response.json({ ok: true });
  }

  const resId = b.reservationId && /^\d{1,20}$/.test(String(b.reservationId)) ? String(b.reservationId) : null;
  const resLabel = resId && typeof b.reservationLabel === 'string' ? b.reservationLabel.trim().slice(0, 160) || null : null;
  const caseUrl = typeof b.caseUrl === 'string' && /^https:\/\/\S+$/.test(b.caseUrl.trim()) ? b.caseUrl.trim().slice(0, 1000) : null;
  if (typeof b.caseUrl === 'string' && b.caseUrl.trim() && !caseUrl) {
    return Response.json({ ok: false, error: 'The case link is the https:// address of the case.' }, { status: 400 });
  }
  const severity = SEVERITY.includes(String(b.severity)) ? b.severity : 'Medium';
  const status = STATUS.includes(String(b.status)) ? b.status : 'Open';

  // Closing a case without a date leaves a resolved claim that cannot be
  // aged, so the date is filled rather than left to whoever remembers —
  // New York's day (UTC's is tomorrow after 8 PM), and kept on later edits (closeDate, §167).
  const today = todayIn('America/New_York');

  if (b.id) {
    const before = (await sql`SELECT status, resolved_on::text AS resolved_on FROM claims WHERE account_id = 1 AND id = ${b.id}`)[0] as
      { status: string; resolved_on: string | null } | undefined;
    const resolvedOn = closeDate(String(status), b.resolvedOn, before ?? null, today);
    if (before && before.status !== status) {
      await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                VALUES (1, 'claim', ${String(b.id)}, 'status', ${`${before.status} → ${status}`}, ${who.email})`;
    }
    const rows = await sql`
      UPDATE claims SET
        unit_id = ${b.unitId || null},
        occurred_on = COALESCE(${b.occurredOn ?? null}, occurred_on),
        category = ${b.category ?? null}, severity = ${severity}, status = ${status},
        source = ${b.source ?? null}, description = ${b.description ?? null},
        -- Cleared when a case is reopened, so a claim never carries a
        -- resolution date while it is open.
        resolved_on = ${resolvedOn},
        -- The stay changes only when it is sent: a form that does not show
        -- it must not clear it.
        reservation_id = CASE WHEN ${b.reservationId !== undefined} THEN ${resId} ELSE reservation_id END,
        reservation_label = CASE WHEN ${b.reservationId !== undefined} THEN ${resLabel} ELSE reservation_label END,
        case_url = CASE WHEN ${b.caseUrl !== undefined} THEN ${caseUrl} ELSE case_url END
      WHERE account_id = 1 AND id = ${b.id}
      RETURNING id`;
    // §99: a status change is news in the claims channel.
    if (rows.length && before && before.status !== status) {
      waitUntil(notifyClaim(sql as unknown as SqlFn, env.ENCRYPTION_KEY, String(b.id), 'changed', who.email, `→ ${status}`).catch(() => {}));
    }
    return Response.json({ ok: rows.length > 0, id: rows[0]?.id });
  }

  const rows = await sql`
    INSERT INTO claims
      (account_id, unit_id, occurred_on, category, severity, status, source,
       description, resolved_on, created_by, reservation_id, reservation_label, case_url)
    VALUES (1, ${b.unitId || null},
            ${b.occurredOn || today},
            ${b.category ?? null}, ${severity}, ${status}, ${b.source ?? null},
            ${b.description ?? null}, ${closeDate(String(status), b.resolvedOn, null, today)}, ${who.email}, ${resId}, ${resLabel}, ${caseUrl})
    RETURNING id`;
  if (rows[0]?.id != null) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${String(rows[0].id)}, 'status', ${`Claim opened — ${status}`}, ${who.email})`;
    waitUntil(notifyClaim(sql as unknown as SqlFn, env.ENCRYPTION_KEY, String(rows[0].id), 'opened', who.email).catch(() => {}));
  }
  return Response.json({ ok: true, id: rows[0]?.id });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id is required.' }, { status: 400 });
  const sql = db(env);
  // Removed, never erased (§86): stamped, skipped by every reader, and
  // restorable. Its work keeps the link, so an undo brings it all back.
  const rows = await sql`UPDATE claims SET deleted_at = now(), deleted_by = ${who.email}
                          WHERE account_id = 1 AND id = ${id} AND deleted_at IS NULL RETURNING id`;
  if (rows.length) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${String(id)}, 'change', 'Removed', ${who.email})`;
  }
  return Response.json({ ok: rows.length > 0 });
};
