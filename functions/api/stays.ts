/**
 * GET /api/stays?unitId=…&date=YYYY-MM-DD — who was staying in a unit on a
 * day, asked of Hostaway now (§84). The one stay picker behind manual
 * cleans, to-dos, work orders and claims; open to the roles that create
 * any of them (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { fetchReservationsTouching } from '../_lib/hostaway.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const unitId = url.searchParams.get('unitId') ?? '';
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{1,20}$/.test(unitId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, message: 'Which unit and day?' }, { status: 400 });
  }
  try {
    const stays = (await fetchReservationsTouching(await getCredentials(sql, env.ENCRYPTION_KEY), date, date))
      .filter(r => r.listingId === unitId && r.arrival <= date && r.departure >= date)
      .map(r => ({ resId: r.reservationId, guest: r.guestName ?? '', arrival: r.arrival, departure: r.departure, channel: r.channel }));
    return Response.json({ ok: true, stays }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false, message: `Hostaway: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
};
