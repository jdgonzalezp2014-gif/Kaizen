/**
 * A handyman on a repair (§137) — the same idea as a cleaner on a clean: one
 * work order, steps in order, every step saved and told to the team. Two
 * doors share this: the link the team sends for one work order (no account,
 * `/report#w=`), and the handyman signed in with the email in the vendor
 * directory (their open work orders). Or neither: the repair is handled
 * inside, as before.
 *
 * The team sets the day. The handyman accepts it — or can't, and the work
 * order gets a "Reschedule" sub-task. The unit's access shows on the day set
 * only. Charges and materials go with their receipt and WAIT for approval (no
 * preset prices); approved, they become the repair's cost — and the repair,
 * once completed, its expense in Costs (settleRepair).
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { decrypt, encrypt } from './crypto.ts';
import { newToken, sha256, strip } from './crew.ts';
import { accessByUnit } from './unit-access.ts';
import { fieldPhotos } from './inventory.ts';
import { addFieldExpense } from './field-costs.ts';
import { settleRepair } from './repair-costs.ts';
import { mirrorOn, pushWork } from './hostaway-tasks.ts';
import { commentToThread } from './slack.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';

const TZ = 'America/New_York';
export interface VendorWho { name: string; source: 'link' | 'vendor' }

interface Row {
  id: string; title: string; description: string | null; unit_id: string | null; unit: string | null; scheduled_on: string | null;
  start_time: string | null; due_on: string | null; status: string; vendor: string | null; kind: string;
  vendor_accepted_at: string | null; vendor_accepted_by: string | null; resolution_note: string | null; cost_actual: number | null;
}
/**
 * Owner, 2026-10-27: a repair's items are each a work order, given like cleans (Give items, todos.ts) — an item with
 * no day or listing of its own is on the repair's. The vendor is never inherited: "all but this one" must stay possible.
 */
async function workRow(sql: SqlFn, id: string): Promise<Row | null> {
  const [r] = await sql`SELECT t.id::text, t.title, t.description, coalesce(t.unit_ids[1], p.unit_ids[1]) AS unit_id, u.name AS unit,
                                coalesce(t.scheduled_on, p.scheduled_on)::text AS scheduled_on,
                                CASE WHEN t.scheduled_on IS NULL THEN p.start_time ELSE t.start_time END AS start_time,
                                t.due_on::text, t.status, t.vendor, t.kind,
                                t.vendor_accepted_at::text, t.vendor_accepted_by, t.resolution_note, t.cost_actual::float AS cost_actual
                           FROM todos t LEFT JOIN todos p ON p.account_id = t.account_id AND p.id = t.parent_id AND p.kind = 'work_order' AND p.deleted_at IS NULL
                           LEFT JOIN units u ON u.account_id = t.account_id AND u.id = coalesce(t.unit_ids[1], p.unit_ids[1])
                          WHERE t.account_id = 1 AND t.id = ${Number(id) || 0} AND t.deleted_at IS NULL` as Row[];
  return r ?? null;
}

/** What the handyman sees of one work order. The access only on the day set and while it is open; never the team's notes beyond the description. */
export async function workPage(sql: SqlFn, id: string) {
  const r = await workRow(sql, id);
  if (!r) return null;
  const today = todayIn(TZ);
  const [photos, charges, acc] = await Promise.all([
    sql`SELECT stage, name, url FROM work_photos WHERE account_id = 1 AND todo_id = ${Number(id)} ORDER BY id`,
    sql`SELECT id::text, amount::float AS amount, description, status, decision_note AS "decisionNote", photos
          FROM field_expenses WHERE account_id = 1 AND todo_id = ${Number(id)} AND source = 'vendor' ORDER BY id`,
    r.unit && r.scheduled_on === today && !['completed', 'cancelled'].includes(r.status) ? accessByUnit(sql) : Promise.resolve(null)
  ]) as [{ stage: 'before' | 'after'; name: string; url: string }[], { id: string; amount: number; description: string; status: string; decisionNote: string | null; photos: unknown }[], Awaited<ReturnType<typeof accessByUnit>> | null];
  const access = acc && r.unit ? acc.get(r.unit) : null;
  return {
    work: { id: r.id, title: r.title, description: r.description, unit: r.unit, scheduledOn: r.scheduled_on, startTime: r.start_time,
            dueOn: r.due_on, status: r.status, vendor: r.vendor, accepted: r.vendor_accepted_at ? { at: r.vendor_accepted_at, by: r.vendor_accepted_by } : null,
            resolution: r.resolution_note },
    today,
    address: access?.address ?? (r.unit ? (await accessByUnit(sql)).get(r.unit)?.address ?? null : null),
    access: access ? strip(access) : null,
    photos: { before: photos.filter(p => p.stage === 'before').length, after: photos.filter(p => p.stage === 'after').length },
    charges
  };
}

async function note(sql: SqlFn, encryptionKey: string, id: string, body: string, by: string, kind: 'note' | 'change' | 'status' = 'change') {
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'task', ${id}, ${kind}, ${body.slice(0, 4000)}, ${by})`;
  // Ops follows the work order's own Slack thread, as for any comment.
  await commentToThread(sql, encryptionKey, 'task', id, body, by).catch(() => {});
}

/** After a change: the Hostaway mirror and the repair's money, as any work. */
async function settle(sql: SqlFn, encryptionKey: string, id: string, by: string) {
  const creds = () => getCredentials(sql, encryptionKey);
  await settleRepair(sql, id, by, creds).catch(() => {});
  if (await mirrorOn(sql)) await pushWork(sql, await creds(), id).catch(() => {});
}

/**
 * One step from the handyman. Throws a plain message on a refusal.
 *   accept                      the day the team set
 *   cant { reason }             → a "Reschedule" sub-task for the team; the acceptance cleared
 *   photo { stage } + files     before / after (the first before starts the work)
 *   note { text }               a question or what was done, to the team
 *   charge { amount, description, kind: labor | materials } + receipt  → waits for approval
 *   done { text }               what was done; the work order completes (its cost = what is approved)
 */
export async function workAct(sql: SqlFn, encryptionKey: string, id: string, who: VendorWho, b: Record<string, unknown>, files: File[],
                              waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const r = await workRow(sql, id);
  if (!r) throw new Error('This work order is gone.');
  if (r.status === 'completed' || r.status === 'cancelled') throw new Error('This work order is closed.');
  const by = `${who.name}${who.source === 'link' ? ' (link)' : ''}`;
  const tell = (text: string, kind: 'note' | 'change' | 'status' = 'change') => waitUntil(note(sql, encryptionKey, id, `🔧 ${who.name}: ${text}`, by, kind));

  switch (b.action) {
    case 'accept': {
      await sql`UPDATE todos SET vendor_accepted_at = now(), vendor_accepted_by = ${who.name},
                                 status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END, updated_at = now()
                 WHERE account_id = 1 AND id = ${Number(id)}`;
      tell(`accepted the day — ${r.scheduled_on ?? 'no day set'}${r.start_time ? ` ${r.start_time}` : ''}.`, 'status');
      waitUntil(settle(sql, encryptionKey, id, by));
      return;
    }
    case 'cant': {
      const reason = String(b.reason ?? '').trim().slice(0, 300);
      await sql`UPDATE todos SET vendor_accepted_at = NULL, vendor_accepted_by = NULL,
                                 status = CASE WHEN status = 'confirmed' THEN 'pending' ELSE status END, updated_at = now()
                 WHERE account_id = 1 AND id = ${Number(id)}`;
      // The owner: if they can't, it stays as a task to reschedule.
      await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, priority, parent_id)
                VALUES (1, ${`Reschedule — ${who.name} can't on ${r.scheduled_on ?? 'the day set'}${reason ? `: ${reason}` : ''}`.slice(0, 300)},
                        ${r.unit_id ? [r.unit_id] : []}, ${by}, 'task', 'pending', 'high', ${Number(id)})`;
      // Their link stops working: the team picks a day (and maybe a vendor) again.
      await sql`UPDATE work_links SET expires_on = ${addDays(todayIn(TZ), -1)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
      tell(`can't on ${r.scheduled_on ?? 'the day set'}${reason ? ` — “${reason}”` : ''}. A "Reschedule" sub-task is on the work order.`, 'status');
      waitUntil(settle(sql, encryptionKey, id, by));
      return;
    }
    case 'photo': {
      const stage = String(b.stage);
      if (stage !== 'before' && stage !== 'after') throw new Error('Before or after?');
      if (!files.length) throw new Error('No photo.');
      const up = await fieldPhotos(sql, encryptionKey, files, `repair #${id} ${stage}`);
      for (const p of up) await sql`INSERT INTO work_photos (account_id, todo_id, stage, name, url, by_name) VALUES (1, ${Number(id)}, ${stage}, ${p.name}, ${p.url}, ${who.name})`;
      if (stage === 'before') await sql`UPDATE todos SET status = 'in_progress', updated_at = now() WHERE account_id = 1 AND id = ${Number(id)} AND status IN ('pending', 'confirmed')`;
      tell(`${up.length} photo${up.length === 1 ? '' : 's'} ${stage.toUpperCase()}:\n${up.map(p => p.url).join('\n')}`, 'note');
      if (stage === 'before') waitUntil(settle(sql, encryptionKey, id, by));
      return;
    }
    case 'note': {
      const text = String(b.text ?? '').trim().slice(0, 1500);
      if (!text) throw new Error('Write the note first.');
      tell(text, 'note');
      return;
    }
    case 'charge': {
      const amount = Math.round(Number(b.amount) * 100) / 100;
      const description = String(b.description ?? '').trim().slice(0, 200);
      const kind = b.kind === 'materials' ? 'Materials' : 'Labor';
      if (!(amount > 0) || amount > 20000) throw new Error('Write the amount.');
      if (!description) throw new Error('Say what it is for.');
      const photos = await fieldPhotos(sql, encryptionKey, files, `repair #${id} ${kind}`);
      await addFieldExpense(sql, { source: 'vendor', by: who.name, amount, description: `${kind}: ${description} — repair #${id} ${r.title}`.slice(0, 300),
                                   category: 'Repairs', todoId: id, unitId: r.unit_id, photos });
      tell(`${kind.toLowerCase()} $${amount.toFixed(2)} — ${description}${photos.length ? ` (receipt: ${photos.map(p => p.url).join(' ')})` : ' (no receipt)'} · waiting for approval`);
      return;
    }
    case 'done': {
      const text = String(b.text ?? '').trim().slice(0, 1500);
      if (!text) throw new Error('Say what was done.');
      await sql`UPDATE todos SET status = 'completed', done_at = now(), done_by = ${by},
                                 resolution_note = ${text}, updated_at = now()
                 WHERE account_id = 1 AND id = ${Number(id)}`;
      const [p] = await sql`SELECT count(*)::int AS n FROM field_expenses WHERE account_id = 1 AND todo_id = ${Number(id)} AND source = 'vendor' AND status = 'pending'` as { n: number }[];
      tell(`✅ done — ${text}${p?.n ? ` · ${p.n} charge${p.n === 1 ? '' : 's'} still waiting for approval` : ''}`, 'status');
      waitUntil(settle(sql, encryptionKey, id, by));
      return;
    }
    default: throw new Error('Unknown step.');
  }
}

/* ── the link door ─────────────────────────────────────────────────── */

/** The team's side: the link for one work order — the same one again while it lasts. A day and a vendor first. */
export async function workLinkFor(sql: SqlFn, encryptionKey: string, id: string, origin: string) {
  const r = await workRow(sql, id);
  if (!r) throw new Error('That work order is gone.');
  if (r.status === 'completed' || r.status === 'cancelled') throw new Error('This work order is closed.');
  // A repair holding work-order items is their folder: its description lists every item, other vendors' too.
  const [items] = await sql`SELECT count(*)::int AS n FROM todos WHERE account_id = 1 AND parent_id = ${Number(id)} AND kind = 'work_order' AND deleted_at IS NULL` as { n: number }[];
  if (items!.n) throw new Error('This repair holds its items — give the items to the vendor (they see them on their page), or send each item’s link.');
  if (!r.vendor) throw new Error('Choose the vendor first.');
  if (!r.scheduled_on) throw new Error('Set the day first — the vendor accepts it or says they can’t.');
  const expires = addDays(r.scheduled_on > todayIn(TZ) ? r.scheduled_on : todayIn(TZ), 7);
  const [had] = await sql`SELECT vendor, token_enc, expires_on::text AS expires FROM work_links WHERE account_id = 1 AND todo_id = ${Number(id)}` as
    { vendor: string; token_enc: string; expires: string }[];
  let token = had && had.vendor === r.vendor && had.expires >= todayIn(TZ) ? await decrypt(had.token_enc, encryptionKey).catch(() => null) : null;
  if (!token) {
    token = newToken();
    await sql`INSERT INTO work_links (account_id, todo_id, vendor, token_enc, token_hash, expires_on)
              VALUES (1, ${Number(id)}, ${r.vendor}, ${await encrypt(token, encryptionKey)}, ${await sha256(token)}, ${expires})
              ON CONFLICT (account_id, todo_id) DO UPDATE SET vendor = EXCLUDED.vendor, token_enc = EXCLUDED.token_enc,
                token_hash = EXCLUDED.token_hash, expires_on = EXCLUDED.expires_on, created_at = now()`;
  } else if (had!.expires !== expires) {
    await sql`UPDATE work_links SET expires_on = ${expires} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
  }
  const [v] = await sql`SELECT phone FROM vendors WHERE account_id = 1 AND lower(name) = lower(${r.vendor})` as { phone: string | null }[];
  return { link: `${origin}/report#w=${token}`, vendor: r.vendor, phone: v?.phone ?? null, title: r.title, unit: r.unit, day: r.scheduled_on, expires };
}

/** Which work order a link opens — refused once expired, closed, or given to another vendor. */
export async function workOfToken(sql: SqlFn, request: Request): Promise<{ id: string; vendor: string } | Response> {
  const token = request.headers.get('X-Work-Token') ?? '';
  const gone = (ended = false) => Response.json({ ok: false, error: 'bad_link', message: ended
    ? 'This work order is closed or changed, so this link no longer works. / Esta orden se cerró o cambió, así que este enlace ya no sirve.'
    : 'This link is not valid — ask for it again. / Este enlace no es válido — pídelo de nuevo.' }, { status: 403 });
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return gone();
  const [l] = await sql`SELECT l.todo_id::text AS id, l.vendor, l.expires_on::text AS expires, t.vendor AS now_vendor, t.status, t.deleted_at IS NOT NULL AS gone
                          FROM work_links l JOIN todos t ON t.account_id = l.account_id AND t.id = l.todo_id
                         WHERE l.account_id = 1 AND l.token_hash = ${await sha256(token)}` as
    { id: string; vendor: string; expires: string; now_vendor: string | null; status: string; gone: boolean }[];
  if (!l) return gone();
  if (l.gone || l.expires < todayIn(TZ) || (l.now_vendor ?? '').toLowerCase() !== l.vendor.toLowerCase()) return gone(true);
  return { id: l.id, vendor: l.vendor };
}
