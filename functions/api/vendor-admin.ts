/**
 * /api/vendor-admin — Operations → Handymen (owner, 2026-10-25): a handyman's
 * page for the team, as Operations → Cleaners is a cleaner's. Their work
 * orders in any dates, each job's pay and charges, the invoice — and the
 * team's edits, the same ones a clean has.
 *
 *   GET  [?vendor=<name>&period=YYYY-MM-DD[&to=YYYY-MM-DD]]   who has work to pay; with a vendor, their page
 *   GET  ?view=vendor&vendor=<name>[&work=<id>&photo=<Drive id>]   "View as handyman": their own page (/api/vendor's), and its photos
 *   POST { action: 'flag', id, note, how: 'none' | 'deduct' | 'pay', value? }
 *                                     a note the handyman reads — on a job done, with a deduction or a pay typed instead
 *   POST { action: 'unflag', id }
 *   POST { action: 'correct', id, pay: number | '', note }   the job's pay by hand ('' = back to the approved charges)
 *   POST { action: 'notPaid', id, note } / { action: 'restorePaid', id }   a job done taken off the pay (and Costs), or put back
 *   POST { action: 'addJob', vendor, date, title, unitId?, pay, chargeOwner? }   a job done that has no work order yet
 *   POST { action: 'invoicePeriod', vendor, period: 'weekly' | 'monthly' }
 *   POST { action: 'link', vendor, mode?: 'new' | 'off' }   the handyman's own link (/crew#v=…), the same one each time
 *   POST { action: 'slackChannel', vendor, channel? }   where the bot tells them of new work and their day: a channel that exists, or a new #handyman-<name>
 * A handyman's charges are decided where they always were (crew-admin `decideField`).
 *
 * GET needs `operations`, POST `operations.edit` (roles.ts). Every edit is a
 * line in the work order's activity log and settles its money (settleRepair:
 * Costs, and the owner's Hostaway charge when it is charged to the owner).
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { refuse } from '../_lib/crew.ts';
import { findVendor, loadVendorPage, vendorNames } from '../_lib/vendor-pay.ts';
import { ensureVendor } from '../_lib/payouts.ts';
import { vendorGet } from '../_lib/vendor-door.ts';
import { handymanChannel, vendorOwnLink } from '../_lib/vendor-slack.ts';
import { slackSetup } from '../_lib/slack.ts';
import { settleRepair } from '../_lib/repair-costs.ts';
import { syncPayCheck } from '../_lib/pay-check.ts';
import { flaggedPay, VENDOR_VOID } from '../../src/lib/vendor-pay.ts';
import { todayIn } from '../../src/lib/dates.ts';

const TZ = 'America/New_York';
const money = (n: number | null) => n == null ? 'no pay' : `$${n.toFixed(2)}`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const name = url.searchParams.get('vendor');
  // "View as handyman" (owner, 2026-10-27, as §122's "View as cleaner"): their own page, from the same server code.
  if (url.searchParams.get('view') === 'vendor') {
    const v = name ? await findVendor(sql, name) : null;
    return v ? vendorGet(request, env, sql, v.name) : refuse(404, 'not_found', 'No such handyman.');
  }
  const [vendors, page, slack] = await Promise.all([
    vendorNames(sql),
    name ? loadVendorPage(sql, name, url.searchParams.get('period'), url.searchParams.get('to')) : Promise.resolve(null),
    slackSetup(sql, env.ENCRYPTION_KEY).then(s => Object.fromEntries(Object.entries(s.config.handymen ?? {}).map(([k, v]) => [k, v.channelName])), () => ({}))
  ]);
  if (name && !page) return refuse(404, 'not_found', `${name} has no work orders and is not in the vendor directory.`);
  return Response.json({ ok: true, vendors, page, slack }, { headers: { 'Cache-Control': 'no-store' } });
};

interface Job { id: string; title: string; status: string; vendor: string | null; pay: number | null; pay_fixed: number | null; pay_void: string | null; pay_flag_note: string | null }

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const note = String(b.note ?? '').trim().slice(0, 500);
  const log = (id: string, body: string) =>
    sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'task', ${id}, 'change', ${body.slice(0, 4000)}, ${who.email})`;
  const settle = async (id: string) => {
    await settleRepair(sql, id, who.email, () => getCredentials(sql, env.ENCRYPTION_KEY)).catch(() => {});
    await syncPayCheck(sql, id, who.email).catch(() => {});
  };

  // Owner, 2026-10-25: the handyman's own link, copied by the team. The same
  // link every time (kept encrypted) so one already sent keeps working; "new"
  // replaces it, "off" turns it off.
  if (b.action === 'link') {
    const n = String(b.vendor ?? '').trim();
    if (!n || !(await findVendor(sql, n))) return refuse(400, 'bad_request', 'Pick a handyman.');
    const name = await ensureVendor(sql, n);
    const [v] = await sql`SELECT link_token_enc, phone FROM vendors WHERE account_id = 1 AND lower(name) = lower(${name})` as { link_token_enc: string | null; phone: string | null }[];
    if (b.mode === 'off') {
      await sql`UPDATE vendors SET link_token_hash = NULL, link_token_enc = NULL, updated_at = now() WHERE account_id = 1 AND lower(name) = lower(${name})`;
      return Response.json({ ok: true, link: null });
    }
    const link = await vendorOwnLink(sql, env.ENCRYPTION_KEY, name, new URL(request.url).origin, b.mode === 'new');
    return Response.json({ ok: true, link, phone: v?.phone ?? null });
  }

  if (b.action === 'slackChannel') {
    const v = await findVendor(sql, String(b.vendor ?? ''));
    if (!v) return refuse(400, 'bad_request', 'Pick a handyman.');
    const name = await ensureVendor(sql, v.name);
    try { return Response.json({ ok: true, ...(await handymanChannel(sql, env.ENCRYPTION_KEY, name, who.email, typeof b.channel === 'string' ? b.channel : null)) }); }
    catch (e) { return refuse(400, 'bad_request', e instanceof Error ? e.message : String(e)); }
  }

  if (b.action === 'invoicePeriod') {
    const period = b.period === 'weekly' ? 'weekly' : b.period === 'monthly' ? 'monthly' : null;
    if (!period) return refuse(400, 'bad_request', 'Weekly or monthly.');
    const v = await findVendor(sql, String(b.vendor ?? ''));
    if (!v) return refuse(400, 'bad_request', `${String(b.vendor ?? '')} has no work orders and is not in the vendor directory.`);
    const name = await ensureVendor(sql, v.name);
    await sql`UPDATE vendors SET invoice_period = ${period}, updated_at = now() WHERE account_id = 1 AND lower(name) = lower(${name})`;
    return Response.json({ ok: true, added: !v.inDirectory });
  }

  if (b.action === 'addJob') {
    const v = await findVendor(sql, String(b.vendor ?? ''));
    if (!v) return refuse(400, 'bad_request', 'Pick a vendor.');
    const date = String(b.date ?? '');
    const title = String(b.title ?? '').trim().slice(0, 300);
    const pay = b.pay === '' || b.pay == null ? NaN : Math.round(Number(b.pay) * 100) / 100;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIn(TZ)) return refuse(400, 'bad_request', 'The day it was done — today or before.');
    if (!title) return refuse(400, 'bad_request', 'Say what the job was.');
    if (!(pay >= 0) || pay > 20000) return refuse(400, 'bad_request', 'The pay is a number (0 to 20,000).');
    const unit = b.unitId ? String(b.unitId) : null;
    // A job already done: a completed work order, dated at noon New York that day so its day never shifts.
    // Not mirrored to Hostaway — it is a record of work done, not a task for anyone.
    const [t] = await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, vendor, cost_actual, charge_owner,
                                             done_at, done_by, resolution_note)
                          VALUES (1, ${title}, ${unit ? [unit] : []}, ${who.email}, 'work_order', 'completed', ${v.name}, ${pay},
                                  ${b.chargeOwner === true && !!unit}, (${date}::date + time '12:00') AT TIME ZONE ${TZ}, ${who.email},
                                  ${`Recorded from ${v.name}'s page in Operations → Handymen.`})
                          RETURNING id::text` as { id: string }[];
    await log(t!.id, `Added from ${v.name}'s page: done ${date}, ${money(pay)}.`);
    await settle(t!.id);
    return Response.json({ ok: true, id: t!.id });
  }

  // Everything else edits one job: a work order with a vendor.
  const id = String(Number(b.id) || 0);
  const [j] = await sql`SELECT id::text, title, status, vendor, cost_actual::float AS pay, pay_fixed::float AS pay_fixed, pay_void, pay_flag_note
                          FROM todos WHERE account_id = 1 AND id = ${Number(id)} AND kind = 'work_order' AND deleted_at IS NULL` as Job[];
  if (!j || !j.vendor) return refuse(404, 'not_found', 'That job is not a work order with a vendor — reload.');
  const done = j.status === 'completed';

  if (b.action === 'flag' || b.action === 'unflag') {
    if (b.action === 'unflag') {
      await sql`UPDATE todos SET pay_flag_note = NULL, pay_flagged_by = NULL, pay_flagged_at = NULL, updated_at = now() WHERE account_id = 1 AND id = ${Number(id)}`;
      await log(id, 'Pay flag removed.');
      await syncPayCheck(sql, id, who.email).catch(() => {});
      return Response.json({ ok: true });
    }
    if (!note) return refuse(400, 'bad_request', 'A flag needs a note — it is what the handyman reads.');
    const how = b.how === 'deduct' || b.how === 'pay' ? b.how : 'none';
    if (how !== 'none' && !done) return refuse(400, 'bad_request', 'The pay is corrected once the job is done.');
    let pay = j.pay;
    try { pay = flaggedPay(j.pay, how, b.value === '' || b.value == null ? null : Number(b.value)); }
    catch (e) { return refuse(400, 'bad_request', e instanceof Error ? e.message : String(e)); }
    await sql`UPDATE todos SET pay_flag_note = ${note}, pay_flagged_by = ${who.email}, pay_flagged_at = now(), updated_at = now()
               WHERE account_id = 1 AND id = ${Number(id)}`;
    if (how !== 'none') {
      await sql`UPDATE todos SET pay_fixed = ${pay}, cost_actual = ${pay}, pay_note = ${note} WHERE account_id = 1 AND id = ${Number(id)}`;
    }
    await settle(id);
    await log(id, `⚑ Pay flag: “${note}”${how === 'none' ? '' : ` — pay ${money(j.pay)} → ${money(pay)}`}.`);
    return Response.json({ ok: true, pay });
  }

  if (b.action === 'correct') {
    if (!done) return refuse(400, 'bad_request', 'The pay is corrected once the job is done — before that, set its cost in the work order.');
    const back = b.pay === '' || b.pay == null;
    const typed = back ? null : Math.round(Number(b.pay) * 100) / 100;
    if (!back && !(typed! >= 0)) return refuse(400, 'bad_request', 'The pay is a number (0 or more), or blank for the approved charges.');
    if (!back && !note) return refuse(400, 'bad_request', 'Say why the pay is corrected — the handyman reads it.');
    // Blank: the approved charges are the pay again — or, with none, the cost the work order already had.
    const [r] = back
      ? await sql`UPDATE todos SET pay_fixed = NULL, pay_note = NULL, updated_at = now(),
                         cost_actual = coalesce((SELECT sum(amount) FROM field_expenses WHERE account_id = 1 AND todo_id = ${Number(id)}
                                                   AND source = 'vendor' AND status = 'approved'), cost_actual)
                   WHERE account_id = 1 AND id = ${Number(id)} RETURNING cost_actual::float AS pay` as { pay: number | null }[]
      : await sql`UPDATE todos SET pay_fixed = ${typed}, cost_actual = ${typed}, pay_note = ${note}, updated_at = now()
                   WHERE account_id = 1 AND id = ${Number(id)} RETURNING cost_actual::float AS pay` as { pay: number | null }[];
    await log(id, back ? `Pay back to the approved charges: ${money(r!.pay)}.` : `Pay corrected ${money(j.pay)} → ${money(typed)}: “${note}”.`);
    await settle(id);
    return Response.json({ ok: true, pay: r!.pay });
  }

  if (b.action === 'notPaid' || b.action === 'restorePaid') {
    if (!done) return refuse(400, 'bad_request', 'Only a job already done is on the pay — an open one can be cancelled in the work order.');
    if (b.action === 'notPaid') {
      if (!note) return refuse(400, 'bad_request', 'Say why it is not paid — the handyman reads the reason.');
      if (j.pay_void) return refuse(409, 'already_void', 'That job is already not paid — reload.');
      await sql`UPDATE todos SET pay_void = ${`${VENDOR_VOID}${note}`}, updated_at = now() WHERE account_id = 1 AND id = ${Number(id)}`;
      await log(id, `○ Not paid: “${note}” — off ${j.vendor}'s invoice and out of Costs.`);
    } else {
      if (!j.pay_void) return refuse(409, 'not_void', 'That job is on the pay already — reload.');
      await sql`UPDATE todos SET pay_void = NULL, updated_at = now() WHERE account_id = 1 AND id = ${Number(id)}`;
      await log(id, `Put back on ${j.vendor}'s pay.`);
    }
    await settle(id);
    return Response.json({ ok: true });
  }

  return refuse(400, 'bad_request', 'Unknown action.');
};
