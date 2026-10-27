/**
 * GET /api/calendar-log — when each unit's nights were blocked, opened or booked (§169).
 *
 * Read from the hourly looks (functions/_lib/calendar-watch.ts), never from Hostaway: Hostaway keeps no
 * history, so what this returns is only what Kaizen saw change since it started looking.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { runsOf, type ChangeRow } from '../../src/lib/calendar-watch.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 90));
  const rows = (await sql`
    SELECT listing_id AS "unitId", day::text AS day, was, became AS now, note,
           seen_at::text AS "seenAt", since::text AS since
      FROM calendar_changes
     WHERE account_id = 1 AND seen_at > now() - make_interval(days => ${days})
     ORDER BY seen_at DESC, listing_id, day
     LIMIT 20000
  `) as ChangeRow[];
  const units = (await sql`SELECT id, name FROM units WHERE account_id = 1`) as { id: string; name: string }[];
  const [w] = (await sql`
    SELECT min(started_at)::text AS "since", max(checked_at)::text AS "lastLook" FROM calendar_watch WHERE account_id = 1
  `) as { since: string | null; lastLook: string | null }[];
  return Response.json({
    runs: runsOf(rows),
    units: Object.fromEntries(units.map(u => [u.id, u.name])),
    watchingSince: w?.since ?? null,
    lastLook: w?.lastLook ?? null,
    days
  });
};
