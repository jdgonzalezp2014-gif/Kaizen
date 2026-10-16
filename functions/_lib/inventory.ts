/**
 * Inventory, server side (§134): the overview per place with what to order,
 * recording moves (from the team, a cleaner's page, or a shared report link),
 * and turning an order into one to-do — a shopping list with a sub-task per
 * line, mirrored to Hostaway like any work.
 */
import { shareRoot } from './clean-access.ts';
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { DriveError, createFolder, driveToken, uploadFile } from './gdrive.ts';
import { mirrorOn, pushWork } from './hostaway-tasks.ts';
import { notifyTask } from './slack.ts';
import { addFieldExpense } from './field-costs.ts';
import type { Priority } from '../../src/lib/todos.ts';

import { todayIn, addDays } from '../../src/lib/dates.ts';
import { itemKey, itemLabel, sameItem, needByPlace, orderList, perClean, placeKey, stockLevels, toOrder, unitUses, type InvItem, type Move, type MoveKind } from '../../src/lib/inventory.ts';
import { supplyPlaces } from './unit-access.ts';
import { findPlace, fitsPlace, placeWord } from '../../src/lib/unit-access.ts';
import { storeProduct, withProduct, type BuyOption } from '../../src/lib/store-order.ts';

const TZ = 'America/New_York';
const WINDOW_DAYS = 60, AHEAD_DAYS = 14;

export async function invItems(sql: SqlFn): Promise<InvItem[]> {
  const rows = await sql`SELECT id::text, name, size, category, measure, per_clean::float AS per_clean, reorder_at::float AS reorder_at, active, kind, buy_options
                           FROM inventory_items WHERE account_id = 1 ORDER BY active DESC, kind DESC, category, lower(name), lower(coalesce(size, ''))` as
    { id: string; name: string; size: string | null; category: string; measure: string; per_clean: number | null; reorder_at: number | null; active: boolean;
      kind: 'supply' | 'furniture'; buy_options: { label: string; url: string }[] | null }[];
  // `name` is what every screen, order and expense shows — with the size; `baseName` is what is edited.
  return rows.map(r => ({ id: r.id, name: itemLabel(r.name, r.size), baseName: r.name, size: r.size, category: r.category, measure: r.measure,
                          perClean: r.per_clean, reorderAt: r.reorder_at, active: r.active, kind: r.kind, buyOptions: r.buy_options ?? [] }));
}

export async function activeUnits(sql: SqlFn) {
  return await sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as { id: string; name: string }[];
}

/**
 * Every place's stock and what to order (§150). Places are the Repository's:
 * its Storage rows and each house's own closet; each unit draws from the one
 * its `storage` names. What a place needs = what the next cleans of the units
 * assigned to it NOW will take, learned per unit wherever it took from.
 */
export async function overview(sql: SqlFn) {
  const today = todayIn(TZ);
  const [items, sp, units, moveRows, aheadCleans, minRows, hiddenRows, answeredRows] = await Promise.all([
    invItems(sql), supplyPlaces(sql), activeUnits(sql),
    sql`SELECT item_id::text AS "itemId", place, unit_id AS "unitId", kind, qty::float AS qty, cleaning_key AS "cleaningKey",
               to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI:SS') AS at, by_name AS "byName", source
          FROM inventory_moves WHERE account_id = 1 ORDER BY created_at`,
    sql`SELECT unit_id, count(*)::int AS n FROM cleanings WHERE account_id = 1 AND void_reason IS NULL AND assignment <> 'not_needed'
           AND checkout_on > ${today}::date AND checkout_on <= ${addDays(today, AHEAD_DAYS)}::date GROUP BY unit_id`,
    sql`SELECT item_id::text AS "itemId", place, min_qty::float AS min FROM inventory_place_mins WHERE account_id = 1`,
    sql`SELECT item_id::text AS "itemId", place FROM inventory_place_hidden WHERE account_id = 1`,
    // The cleans that said what they took (lines or "nothing"): the average per clean is over these.
    sql`SELECT unit_id, cleaning_key FROM clean_records WHERE account_id = 1 AND supplies_at IS NOT NULL AND unit_id IS NOT NULL
           AND clean_date >= ${addDays(today, -WINDOW_DAYS)}::date`
  ]) as [InvItem[], Awaited<ReturnType<typeof supplyPlaces>>, { id: string; name: string }[], Move[], { unit_id: string; n: number }[],
         { itemId: string; place: string; min: number }[], { itemId: string; place: string }[], { unit_id: string; cleaning_key: string }[]];
  // §150: what a place does not keep leaves its list, its needs and its orders.
  const hidden = new Set(hiddenRows.map(h => `${h.itemId}|${h.place}`));
  const answered = new Map<string, string[]>();
  for (const r of answeredRows) answered.set(r.unit_id, [...answered.get(r.unit_id) ?? [], r.cleaning_key]);
  const levels = stockLevels(moveRows);
  const ahead = new Map(aheadCleans.map(r => [r.unit_id, r.n]));
  const since = addDays(today, -WINDOW_DAYS);
  const mins = new Map(minRows.map(m => [`${m.itemId}|${m.place}`, m.min]));
  // Places the Repository no longer lists (renamed, archived, or "no place") still show while their moves say something.
  type Row = { key: string | null; name: string; self: boolean; units: { id: string; name: string; recordId: string | null }[];
               view: 'storage' | 'house'; supplies?: string | null; from?: string | null; refills?: string[] };
  const rows: Row[] = sp.places.map(p => ({ key: p.key as string | null, name: p.name, self: p.self, units: p.units, view: 'storage' as const,
                                            ...(p.from ? { from: p.from } : {}), ...(p.refills ? { refills: p.refills } : {}) }));
  // Owner, 2026-10-15: the houses apart — their furniture is counted and ordered there, never in a storage.
  for (const h of sp.houses) rows.push({ key: h.key, name: h.name, self: h.self, units: h.units, view: 'house', supplies: h.supplies ?? null });
  for (const k of new Set(moveRows.map(m => m.place))) if (!rows.some(r => r.key === k))
    rows.push({ key: k, name: k ? `${sp.names.get(k) ?? k} (no longer a place)` : '▲ No place', self: false, units: [], view: 'storage' });
  const active = items.filter(i => i.active);
  const uses = new Map(active.flatMap(i => units.map(u => [`${i.id}|${u.id}`, unitUses(moveRows, i.id, u.id, since, answered.get(u.id))] as const)));
  const needs = new Map(active.map(i => [i.id, needByPlace(units.map(u => {
    const use = uses.get(`${i.id}|${u.id}`)!;
    return { place: sp.byUnit.get(u.id)?.key ?? null, rate: perClean(i, use.qty, use.cleans).rate, cleansAhead: ahead.get(u.id) ?? 0 };
  }))]));
  // The place's own average per clean, over the reported cleans of the units it supplies now.
  const placeRate = (i: InvItem, unitIds: string[]) => {
    const t = unitIds.reduce((a, id) => { const x = uses.get(`${i.id}|${id}`); return x ? { qty: a.qty + x.qty, cleans: a.cleans + x.cleans } : a; }, { qty: 0, cleans: 0 });
    return { ...perClean(i, t.qty, t.cleans), cleans: t.cleans };
  };
  /**
   * Which items a place lists (owner, 2026-10-15): a house its furniture only — supplies never live in a house;
   * a storage or a closet its supplies, plus the furniture that is there (has a record: moved, bought or counted
   * there) — furniture moves between the house and a storage.
   */
  const recorded = new Set(moveRows.map(m => `${m.itemId}|${placeKey(m.place)}`));
  const listed = (p: Row, i: InvItem) => p.view === 'house' ? i.kind === 'furniture'
    : i.kind !== 'furniture' || recorded.has(`${i.id}|${placeKey(p.key)}`);
  const minOf = (i: InvItem, key: string) => mins.get(`${i.id}|${key}`) ?? i.reorderAt;
  /**
   * A closet refilled from a storage (owner, 2026-10-15) is not bought for — it is refilled: what it is short
   * (its cleans ahead + its minimum − what it holds, once counted; never counted: its cleans ahead) is
   * "To refill" there, and counts as need at the storage, which is what gets ordered.
   */
  const refill = new Map<string, number>();
  const fedNeed = new Map<string, number>();
  for (const p of rows) if (p.key && p.from) for (const i of active) {
    if (i.kind === 'furniture' || hidden.has(`${i.id}|${p.key}`)) continue;
    const l = levels.get(`${i.id}|${placeKey(p.key)}`);
    const need = needs.get(i.id)!.get(p.key) ?? 0;
    const short = l?.countedAt ? toOrder(l.qty, need, minOf(i, p.key)) : Math.ceil(need);
    refill.set(`${i.id}|${p.key}`, l?.countedAt ? short : 0);
    if (short > 0) fedNeed.set(`${i.id}|${p.from}`, (fedNeed.get(`${i.id}|${p.from}`) ?? 0) + short);
  }
  const places = rows.map(p => ({
    place: p.key, name: p.name, self: p.self, view: p.view, ...(p.view === 'house' ? { supplies: p.supplies ?? null } : {}),
    ...(p.from ? { from: p.from } : {}), ...(p.refills ? { refills: p.refills } : {}),
    units: p.units.map(u => ({ ...u, cleansAhead: ahead.get(u.id) ?? 0 })),
    hidden: active.filter(i => hidden.has(`${i.id}|${p.key}`) && listed(p, i)).map(i => i.id),
    items: active.filter(i => !hidden.has(`${i.id}|${p.key}`) && listed(p, i)).map(i => {
      const l = levels.get(`${i.id}|${placeKey(p.key)}`);
      const own = p.key ? mins.get(`${i.id}|${p.key}`) : undefined;
      const min = own ?? i.reorderAt;
      // A house is not drawn from by cleans: what it needs is its minimum (furniture is not used up per clean).
      const need = p.key && p.view === 'storage' ? (needs.get(i.id)!.get(p.key) ?? 0) + (fedNeed.get(`${i.id}|${p.key}`) ?? 0) : 0;
      const r = p.view === 'storage' ? placeRate(i, p.units.map(u => u.id)) : { rate: null, learned: false, cleans: 0 };
      return { itemId: i.id, qty: l?.qty ?? null, countedAt: l?.countedAt ?? null, missingSince: l?.missingSince ?? null,
               perClean: r.rate, learned: r.learned, reportedCleans: r.cleans, need: Math.ceil(need), min, minOwn: own !== undefined,
               // Only a counted place is ordered for: a never-counted record is not a stock (§134).
               ...(p.key && p.from && i.kind !== 'furniture' ? { toOrder: 0, toRefill: refill.get(`${i.id}|${p.key}`) ?? 0 }
                 : { toOrder: p.key ? toOrder(l?.countedAt ? l.qty : null, need, min) : 0, toRefill: 0 }) };
    })
  }));
  const recent = (await sql`
    SELECT m.id::text, concat_ws(' — ', i.name, i.size) AS item, m.place, u.name AS unit, m.kind, m.qty::float AS qty, m.note, m.by_name AS "byName",
           m.source, m.photos, to_char(m.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
      FROM inventory_moves m JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN units u ON u.account_id = m.account_id AND u.id = m.unit_id
     WHERE m.account_id = 1 ORDER BY m.id DESC LIMIT 100` as { place: string | null }[])
    .map(m => ({ ...m, place: m.place ? sp.names.get(m.place) ?? m.place : null }));
  const unassigned = sp.unassigned.map(u => ({ ...u, cleansAhead: ahead.get(u.id) ?? 0 }));
  const [draft] = await sql`SELECT lines, for_todo::text AS "forTodo", saved_by AS "savedBy",
                                    to_char(saved_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS "savedAt" FROM inventory_order_drafts WHERE account_id = 1` as
    { lines: { itemId: string; place: string; qty: number }[]; forTodo: string | null; savedBy: string; savedAt: string }[];
  const [acc] = await sql`SELECT inventory_low_stock_tasks AS low FROM accounts WHERE id = 1` as { low: boolean }[];
  // The latest photos/note of how each place looked when counted.
  const looks = new Map((await sql`SELECT DISTINCT ON (place) place, note, photos, by_name AS "byName", counted,
                                          to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
                                     FROM inventory_place_looks WHERE account_id = 1 ORDER BY place, id DESC` as
    ({ place: string } & PlaceLook)[]).map(({ place, ...l }) => [place, l]));
  return { items, places: places.map(p => ({ ...p, look: (p.place && looks.get(p.place)) || null })), unassigned, recent, orders: await openOrders(sql), fieldTodos: await fieldTodos(sql),
           draft: draft ?? null, lowStockTasks: !!acc?.low, toPayBack: await toPayBack(sql), aheadDays: AHEAD_DAYS, windowDays: WINDOW_DAYS };
}

/** The messages a field reporter can get, in Spanish (§129: the crew page and the report link speak the cleaner's language). */
const ES: Record<string, string> = {
  'Count, used, bought, adjust or missing.': 'Usado, comprado o falta.',
  'Counts and corrections are the team’s.': 'Los conteos y correcciones los hace el equipo.',
  'How many?': '¿Cuántos?',
  'Which item?': '¿Cuál artículo?',
  'Which unit?': '¿Cuál unidad?',
  'Which place?': '¿Cuál lugar?',
  'The cost is a number.': 'El costo es un número.',
  'Write the total you paid.': 'Escribe el total que pagaste.',
  'Say what it is.': 'Di qué es.',
  'At most 5 photos at a time.': 'Máximo 5 fotos a la vez.',
  'Before or after?': '¿Antes o después?',
  'No photo.': 'No hay foto.',
  'At most 10 photos at a time.': 'Máximo 10 fotos a la vez.',
  'Which clean?': '¿Cuál limpieza?',
  'Add at least one AFTER photo first.': 'Primero agrega al menos una foto del DESPUÉS.',
  'First say what you took for this clean (step 2).': 'Primero di qué tomaste para esta limpieza (paso 2).',
  'Done or reopen?': '¿Completada o reabrir?'
};
export const esMessage = (m: string) => ES[m] ?? m.replace(/ is over 15 MB\.$/, ' pesa más de 15 MB.').replace(/: a photo or a PDF, please\.$/, ': una foto o un PDF, por favor.')
  .replace(/: a photo, please\.$/, ': una foto, por favor.');

const KINDS = new Set(['count', 'used', 'purchase', 'adjust', 'missing', 'taken']);
export type Who = { name: string; source: 'team' | 'cleaner' | 'link'; email?: string };

type Places = Awaited<ReturnType<typeof supplyPlaces>>;
const NOT_IN_HOUSE = 'Supplies are kept in a storage or a closet — not in the house.';

/**
 * Where a move happens (§150). The team names the place (a count, a purchase
 * into a storage); the field never does — a cleaner's take comes out of the
 * place the unit is assigned to in the Repository at that moment. A unit with
 * no place still records (null, shown ▲): the cleaner's step is never blocked.
 */
function placeOf(sp: Places, who: Who, unitId: string | null, unit: string | null, asked: unknown, kind?: 'supply' | 'furniture') {
  if (who.source === 'team' && asked) {
    const p = findPlace(sp, String(asked));
    if (!p) throw new Error('Which place?');
    if (!fitsPlace(p, kind)) throw new Error(NOT_IN_HOUSE);
    return { key: p.key as string | null, name: p.name };
  }
  if (!unitId) throw new Error('Which place?');
  const p = sp.byUnit.get(unitId);
  return p ? { key: p.key as string | null, name: p.name } : { key: null, name: `${unit} (no supplies place)` };
}

async function unitName(sql: SqlFn, unitId: string | null) {
  if (!unitId) return 'Storage';
  const [u] = await sql`SELECT name FROM units WHERE account_id = 1 AND id = ${unitId}` as { name: string }[];
  if (!u) throw new Error('Which unit?');
  return u.name;
}

async function newTodo(sql: SqlFn, title: string, description: string | null, unitId: string | null, by: string, priority: Priority = 'none') {
  const [t] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority)
                        VALUES (1, ${title.slice(0, 300)}, ${description}, ${unitId ? [unitId] : []}, ${by}, 'task', 'pending', ${priority})
                        RETURNING id::text` as { id: string }[];
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t!.id}, 'status', ${`To-do created by ${by}.`}, ${by})`;
  return t!.id;
}

/**
 * §164 (owner, 2026-10-15): the field no longer says how urgent — the team does, in Slack (its #kaizen-ops message,
 * and privately to ops in the cleaner's channel) or by setting the priority in Kaizen (functions/_lib/urgency.ts).
 * A flag, not a sub-task: a sub-task per report filled the urgent list.
 */
async function askUrgency(sql: SqlFn, id: string) {
  await sql`UPDATE todos SET urgency_pending = true WHERE account_id = 1 AND id = ${Number(id)}`;
}

const RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };
/**
 * A clean's reports are three kinds of to-do (§150, owner): what is wrong
 * (each its own), the supplies requested and what was bought — one to-do per
 * clean for each of these two, every report a sub-task, the to-do taking the
 * most urgent priority. Each can carry its own purchase order. `fresh`: the
 * to-do was just made (announce it); else a sub-task was added to the open
 * one. Null when the clean is unknown.
 */
async function cleanTodo(sql: SqlFn, who: Who, cleaningKey: unknown, group: 'request' | 'bought', title: string, description: string | null,
                         priority: Priority) {
  if (!cleaningKey) return null;
  const [c] = await sql`SELECT unit_id, unit_name, clean_date::text AS date FROM clean_records WHERE account_id = 1 AND cleaning_key = ${String(cleaningKey)}` as
    { unit_id: string | null; unit_name: string; date: string }[];
  if (!c) return null;
  const by = who.email ?? who.name;
  let [t] = await sql`SELECT id::text, priority FROM todos WHERE account_id = 1 AND clean_key = ${String(cleaningKey)} AND clean_group = ${group}
                         AND parent_id IS NULL AND status NOT IN ('completed', 'cancelled') ORDER BY id DESC LIMIT 1` as { id: string; priority: string }[];
  const fresh = !t;
  if (!t) {
    const head = group === 'request' ? `Supplies requested — clean of ${c.unit_name} on ${c.date}` : `Bought on the clean of ${c.unit_name} on ${c.date}`;
    // §159: a clean's request is its purchase order — what was asked is its description, line by line, in the
    // cleaner's words; the cart is built from it (✨) or filled when the receipt is read. Bought stays as it was.
    const id = await newTodo(sql, head, group === 'request' ? 'Asked for on this clean:'
      : `What ${who.name} reported on this clean — each one is a sub-task.`, c.unit_id, by, priority);
    if (group === 'request') await askUrgency(sql, id);
    await sql`UPDATE todos SET clean_key = ${String(cleaningKey)}, clean_group = ${group} WHERE account_id = 1 AND id = ${Number(id)}`;
    t = { id, priority };
  }
  if (group === 'request') {
    const said = title.replace(/^Supplies requested:\s*/, '');
    const extra = (description ?? '').split('\n').filter(l => /^(Photo|Receipt):/.test(l)).map(l => `  ${l}`);
    await sql`UPDATE todos SET description = concat_ws(E'\n', NULLIF(description, ''), ${[`• ${who.name}: ${said}`, ...extra].join('\n')}), updated_at = now()
              WHERE account_id = 1 AND id = ${Number(t.id)}`;
  } else {
    await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, parent_id)
              VALUES (1, ${title.slice(0, 300)}, ${description}, ${c.unit_id ? [c.unit_id] : []}, ${by}, 'task', 'pending', ${priority}, ${Number(t.id)})`;
  }
  if ((RANK[priority] ?? 0) > (RANK[t.priority] ?? 0)) await sql`UPDATE todos SET priority = ${priority}, updated_at = now() WHERE account_id = 1 AND id = ${Number(t.id)}`;
  if (!fresh) await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                        VALUES (1, 'task', ${t.id}, 'change', ${`${who.name} added: ${title}`.slice(0, 4000)}, ${by})`;
  return { todoId: t.id, fresh };
}

/**
 * "No hay" from step 2 (§150, owner): what a cleaner did NOT find in the
 * unit's place. Never zeroes the stock — they may just not have seen it, and
 * the record may be wrong: each item is marked ⚠ there (a `missing` move, a
 * count is due) and requested at once, one sub-task of the clean's request.
 * The team decides: check the stock, buy, or both.
 */
export async function ranOut(sql: SqlFn, who: Who, cleaningKey: string, unitId: string | null, raw: unknown) {
  const list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
  const ids = [...new Set((Array.isArray(list) ? list : []).map(x => String(x)))];
  if (!ids.length) return null;
  const items = (await invItems(sql)).filter(i => i.active && ids.includes(i.id));
  if (!items.length) return null;
  const sp = await supplyPlaces(sql);
  const at = placeOf(sp, who, unitId, unitId ? await unitName(sql, unitId) : null, null);
  for (const i of items) await sql`INSERT INTO inventory_moves (account_id, item_id, place, unit_id, kind, qty, cleaning_key, by_name, source)
                                   VALUES (1, ${Number(i.id)}, ${at.key}, ${unitId}, 'missing', 0, ${cleaningKey}, ${who.name}, ${who.source})`;
  const ct = await cleanTodo(sql, who, cleaningKey, 'request',
    `Supplies requested: not found at ${at.name} — ${items.map(i => i.name).join(', ')}`,
    `${who.name} did not find these at ${at.name}. Check the stock (count it in Operations → Inventory — they may not have seen it, ` +
    `or the record may be wrong) and/or order them.`, 'high');
  // §159: these are catalogue items already — they go on the order as lines (one each, for that place), so the
  // order shows what to buy without anyone typing it; the team changes the quantities.
  // A unit with no supplies place has nowhere to send them: what was asked stays in the description, for ✨.
  if (ct && at.key) {
    const lines = items.map(i => ({ itemId: i.id, place: at.key, qty: 1 }));
    await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by) VALUES (1, ${Number(ct.todoId)}, ${JSON.stringify(lines)}::jsonb, ${who.name})
              ON CONFLICT (account_id, todo_id) DO UPDATE SET lines = inventory_orders.lines || EXCLUDED.lines`;
  }
  return ct;
}

/**
 * One move. A "missing" report also makes a to-do to count the item there —
 * one person not finding something is a reason to look, not to zero the record.
 * Returns the to-do to mirror, if one was made.
 */
export async function recordMove(sql: SqlFn, who: Who, b: Record<string, unknown>, photos: { name: string; url: string }[] = [],
                                 known?: Places) {
  const kind = String(b.kind ?? '') as MoveKind;
  if (!KINDS.has(kind)) throw new Error('Count, used, bought, adjust or missing.');
  if (who.source !== 'team' && (kind === 'count' || kind === 'adjust')) throw new Error('Counts and corrections are the team’s.');
  // §150: what is bought reaches the stock only as a purchase the team records (fieldPurchase → approval → recordPurchase).
  if (kind === 'purchase') throw new Error('Record what was bought in Inventory → 🧾 Record a purchase.');
  const qty = Math.round(Number(b.qty) * 100) / 100;
  if (!Number.isFinite(qty) || (kind === 'adjust' ? qty === 0 : qty < 0) || Math.abs(qty) > 10000) throw new Error('How many?');
  if ((kind === 'used' || kind === 'taken') && qty === 0) throw new Error('How many?');
  const [item] = await sql`SELECT id, name, measure, kind FROM inventory_items WHERE account_id = 1 AND id = ${Number(b.itemId)} AND active` as
    { id: number; name: string; measure: string; kind: 'supply' | 'furniture' }[];
  if (!item) throw new Error('Which item?');
  const unitId = b.unitId ? String(b.unitId) : null;
  const unit = unitId ? await unitName(sql, unitId) : null;
  const at = placeOf(known ?? await supplyPlaces(sql), who, unitId, unit, b.place, item.kind);
  const place = at.name;
  const note = String(b.note ?? '').trim().slice(0, 500) || null;
  let todoId: string | null = null, fresh = true;
  if (kind === 'missing') {
    const levels = stockLevels(await sql`SELECT item_id::text AS "itemId", place, unit_id AS "unitId", kind, qty::float AS qty,
                                               to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at
                                          FROM inventory_moves WHERE account_id = 1 AND item_id = ${item.id}` as Move[]);
    const said = levels.get(`${item.id}|${placeKey(at.key)}`)?.qty;
    const title = `Check stock: ${item.name} at ${place}`;
    const description = `${who.name} found ${qty} ${item.measure}${qty === 1 ? '' : 's'}${said != null ? `; the record says ${said}` : ''}.${note ? `\nNote: ${note}` : ''}` +
      photos.map(p => `\nPhoto: ${p.url}`).join('') + `\nCount it in Operations → Inventory to set the record right.`;
    // §150: from a clean, a sub-task of that clean's to-do; from the team, its own.
    const ct = who.source !== 'team' ? await cleanTodo(sql, who, b.cleaningKey, 'request', title, description, 'medium') : null;
    if (ct) ({ todoId, fresh } = ct);
    else todoId = await newTodo(sql, title, description, unitId, who.email ?? who.name, 'medium');
  }
  const [mv] = await sql`INSERT INTO inventory_moves (account_id, item_id, place, unit_id, kind, qty, cleaning_key, note, photos, by_name, source, todo_id)
            VALUES (1, ${item.id}, ${at.key}, ${unitId}, ${kind}, ${qty}, ${b.cleaningKey ? String(b.cleaningKey) : null}, ${note},
                    ${JSON.stringify(photos)}::jsonb, ${who.name}, ${who.source}, ${todoId ? Number(todoId) : null})
            RETURNING id::text` as { id: string }[];
  return { todoId, fresh, place, item: item.name, moveId: mv!.id };
}

/**
 * What was taken from the storage for one clean, sent with one tap (§134).
 * All lines are checked before any is saved, so a mistake in one never
 * leaves half a report. It also ticks the clean's required "what I took" step.
 */
export async function recordUses(sql: SqlFn, who: Who, b: Record<string, unknown>) {
  const raw = typeof b.lines === 'string' ? JSON.parse(b.lines || '[]') : b.lines;
  const lines = (Array.isArray(raw) ? raw : []).map((l: { itemId?: unknown; qty?: unknown }) => ({ itemId: Number(l.itemId), qty: Number(l.qty) }))
    .filter(l => l.qty > 0);
  if (!lines.length) throw new Error('How many?');
  const known = new Set((await invItems(sql)).filter(i => i.active).map(i => Number(i.id)));
  if (lines.some(l => !known.has(l.itemId))) throw new Error('Which item?');
  if (lines.some(l => !Number.isFinite(l.qty) || l.qty > 10000)) throw new Error('How many?');
  const places = await supplyPlaces(sql);
  for (const l of lines) await recordMove(sql, who, { ...b, kind: 'taken', itemId: l.itemId, qty: l.qty, place: undefined }, [], places);

  if (b.cleaningKey) await sql`UPDATE clean_records SET supplies_at = now(), supplies_by = ${who.name}, supplies_none = false
                               WHERE account_id = 1 AND cleaning_key = ${String(b.cleaningKey)}`;
  // §150: the place it came out of — the caller checks it for low stock after the response.
  return { n: lines.length, place: b.unitId ? places.byUnit.get(String(b.unitId))?.key ?? null : null };
}

/** "Nothing from the storage" — said, not skipped: the step is answered. */
export async function nothingTaken(sql: SqlFn, who: Who, cleaningKey: string) {
  await sql`UPDATE clean_records SET supplies_at = now(), supplies_by = ${who.name},
                   supplies_none = NOT EXISTS (SELECT 1 FROM inventory_moves WHERE account_id = 1 AND cleaning_key = ${cleaningKey} AND kind = 'taken')
             WHERE account_id = 1 AND cleaning_key = ${cleaningKey}`;
}

/** A problem or a request from the field: a to-do for the team. */
export async function fieldTodo(sql: SqlFn, who: Who, b: Record<string, unknown>, photos: { name: string; url: string }[] = []) {
  const what = b.kind === 'request' ? 'Supplies requested' : 'Problem';
  const text = String(b.text ?? '').trim().slice(0, 300);
  if (!text) throw new Error('Say what it is.');
  const unitId = b.unitId ? String(b.unitId) : null;
  const place = unitId ? await unitName(sql, unitId) : null;
  // §164: the reporter is not asked how urgent — it comes in at medium, waiting for the team's answer (askUrgency).
  const priority: Priority = 'medium';
  const description = `Reported by ${who.name}.${photos.map(p => `\nPhoto: ${p.url}`).join('')}`;
  // §150: a need joins its clean's to-do as a sub-task; "something is wrong" is always its own to-do.
  if (b.kind === 'request') {
    const ct = await cleanTodo(sql, who, b.cleaningKey, 'request', `${what}: ${text}`, description, priority);
    if (ct) return ct;
  }
  const id = await newTodo(sql, place ? `${what} at ${place}: ${text}` : `${what}: ${text}`, description, unitId, who.email ?? who.name, priority);
  await askUrgency(sql, id);
  // Each problem is its own to-do; marked with its clean so a purchase order can be attached to it.
  if (b.kind !== 'request' && b.cleaningKey) await sql`UPDATE todos SET clean_key = ${String(b.cleaningKey)}, clean_group = 'problem' WHERE account_id = 1 AND id = ${Number(id)}`;
  // §159: a request outside a clean (a helper, a link) is a purchase order too.
  if (b.kind === 'request') await sql`UPDATE todos SET clean_group = 'request' WHERE account_id = 1 AND id = ${Number(id)}`;
  return { todoId: id, fresh: true };
}

/**
 * "I bought something" from a cleaner (§150), in their own words with the
 * total and the receipt. Nothing reaches the stock or Costs yet: the team
 * approves it in Operations → Cleaners by recording it as a purchase — which
 * items, to which place — and that purchase is its stock and its cost.
 */
export async function fieldPurchase(sql: SqlFn, who: Who, b: Record<string, unknown>, photos: { name: string; url: string }[] = []) {
  const text = String(b.text ?? '').trim().slice(0, 300);
  if (!text) throw new Error('Say what it is.');
  const cost = Math.round(Number(b.cost) * 100) / 100;
  if (!(cost > 0) || cost > 100000) throw new Error('Write the total you paid.');
  const unitId = b.unitId ? String(b.unitId) : null;
  if (unitId) await unitName(sql, unitId);
  const id = await addFieldExpense(sql, { source: who.source as 'cleaner' | 'link', by: who.name, amount: cost, description: `Bought: ${text}`,
    category: 'Restock', cleaningKey: b.cleaningKey ? String(b.cleaningKey) : null, unitId, photos });
  const title = `Bought by ${who.name}: ${text} — $${cost.toFixed(2)}`;
  const description = `Approve it in Operations → Cleaners: record what was bought in Inventory (items and where each went).` +
    photos.map(p => `\nReceipt: ${p.url}`).join('');
  const ct = await cleanTodo(sql, who, b.cleaningKey, 'bought', title, description, 'medium');
  return { fieldExpense: id, todoId: ct?.todoId ?? null, fresh: ct?.fresh ?? false };
}

/** What to order, as one to-do with a line per item and the place it goes to. */
export async function createOrder(sql: SqlFn, by: string, lines: OrderIn[], forTodo: string | null = null) {
  // Owner, 2026-10-15: the same lines as any order — a place may wait (no place yet), each says where it is bought.
  const data = orderLinesIn(lines);
  const list = data.length ? orderList(await nameOrderLines(sql, data)) : null;
  if (!list) throw new Error('Nothing to order.');
  // §150: an order can belong to a to-do from the field (a request, a problem); a second order on it adds to the
  // first. Else it is a to-do of its own. §162 (owner, 2026-10-15): the lines are the ORDER's — never a sub-task per
  // item (sub-tasks are other work, like installing what is bought), as an inspection's order already does (§159).
  if (forTodo) {
    const [t] = await sql`SELECT id::text, unit_ids FROM todos WHERE account_id = 1 AND id = ${Number(forTodo)} AND parent_id IS NULL
                            AND status NOT IN ('completed', 'cancelled')` as { id: string; unit_ids: string[] }[];
    if (!t) throw new Error('That to-do is closed or gone.');
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'task', ${t.id}, 'change', ${`Purchase order added:\n${list.items.map(i => i.replace(/^Buy: /, '• ')).join('\n')}`}, ${by})`;
    await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by) VALUES (1, ${Number(t.id)}, ${JSON.stringify(data)}::jsonb, ${by})
              ON CONFLICT (account_id, todo_id) DO UPDATE SET lines = inventory_orders.lines || EXCLUDED.lines`;
    await sql`DELETE FROM inventory_order_drafts WHERE account_id = 1`;
    return { id: t.id, fresh: false };
  }
  await sql`DELETE FROM inventory_order_drafts WHERE account_id = 1`;
  const id = await newTodo(sql, list.title, [`From Operations → Inventory, ${todayIn(TZ)}. When it is bought: Inventory → 🧾 Record a purchase.`,
    ...list.items.map(i => i.replace(/^Buy: /, '• '))].join('\n'), null, by);
  // The lines as data: the purchase that executes this order starts from them.
  await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by) VALUES (1, ${Number(id)}, ${JSON.stringify(data)}::jsonb, ${by})`;
  return { id, fresh: true };
}

/**
 * Edit settings (§150, owner: everything at once, no reprocess): per item its
 * name, measure and estimate per clean (the item's — every place) and the
 * minimum to keep in this place ('' = the item's). All checked, then saved.
 */
export async function saveSettings(sql: SqlFn, by: string, place: unknown, raw: unknown) {
  const list = (Array.isArray(raw) ? raw : []) as { itemId: unknown; name?: unknown; measure?: unknown; perClean?: unknown; min?: unknown }[];
  const items = await invItems(sql);
  const plan = list.map(e => {
    const it = items.find(i => i.id === String(e.itemId));
    if (!it) throw new Error('Which item?');
    const base = it.baseName ?? it.name;
    const name = e.name === undefined ? base : String(e.name).trim().slice(0, 120);
    const measure = e.measure === undefined ? it.measure : String(e.measure).trim().slice(0, 20) || 'unit';
    const perClean = e.perClean === undefined ? it.perClean : e.perClean === '' ? null : Number(e.perClean);
    if (!name) throw new Error('An item needs a name.');
    if (perClean !== null && !(perClean >= 0)) throw new Error('Amounts are numbers, 0 or more.');
    if (items.some(o => o.id !== it.id && o.name.toLowerCase() === itemLabel(name, it.size).toLowerCase())) throw new Error(`There is already an item called "${itemLabel(name, it.size)}".`);
    return { it, name, measure, perClean, min: e.min };
  });
  for (const x of plan) if (x.name !== (x.it.baseName ?? x.it.name) || x.measure !== x.it.measure || x.perClean !== x.it.perClean)
    await sql`UPDATE inventory_items SET name = ${x.name}, measure = ${x.measure}, per_clean = ${x.perClean}, updated_at = now() WHERE account_id = 1 AND id = ${Number(x.it.id)}`;
  const mins = plan.filter(x => x.min !== undefined).map(x => ({ itemId: x.it.id, qty: x.min }));
  if (mins.length) await setMins(sql, by, place, mins);
}

/** Off the list everywhere (§150): switched off, never erased — its moves keep naming it. */
export async function removeItem(sql: SqlFn, itemId: unknown) {
  await sql`UPDATE inventory_items SET active = false, updated_at = now() WHERE account_id = 1 AND id = ${Number(itemId)}`;
}

/** "Not kept here" (§150): an item off a place's list — or back on it. */
export async function hideItem(sql: SqlFn, by: string, place: unknown, itemId: unknown, hide: boolean) {
  const p = findPlace(await supplyPlaces(sql), String(place ?? ''));
  if (!p) throw new Error('Which place?');
  if (hide) await sql`INSERT INTO inventory_place_hidden (account_id, place, item_id, hidden_by) VALUES (1, ${p.key}, ${Number(itemId)}, ${by})
                      ON CONFLICT DO NOTHING`;
  else await sql`DELETE FROM inventory_place_hidden WHERE account_id = 1 AND place = ${p.key} AND item_id = ${Number(itemId)}`;
}

/** A new supply added on the spot (§150, owner: onsite, like the inspection). */
export async function newItem(sql: SqlFn, b: Record<string, unknown>) {
  const name = String(b.name ?? '').trim().slice(0, 120);
  const measure = String(b.measure ?? 'unit').trim().slice(0, 20) || 'unit';
  const category = ['kitchen', 'bathroom', 'cleaning', 'linens', 'other'].includes(String(b.category)) ? String(b.category) : 'other';
  const size = String(b.size ?? '').trim().slice(0, 30) || null;
  if (!name) throw new Error('An item needs a name.');
  // The same thing under another spelling or plural is the item it already is (itemKey).
  const had = sameItem(await sql`SELECT id::text, name, size, active FROM inventory_items WHERE account_id = 1` as { id: string; name: string; size: string | null; active: boolean }[], name, size);
  if (had) {
    // Switched off once: switched back on rather than refused.
    if (!had.active) await sql`UPDATE inventory_items SET active = true, updated_at = now() WHERE id = ${Number(had.id)}`;
    return had.id;
  }
  // Owner, 2026-10-15: furniture goes to the house, supplies to the storage — a new item says which it is.
  const kind = b.kind === 'furniture' ? 'furniture' : 'supply';
  const [r] = await sql`INSERT INTO inventory_items (account_id, name, size, category, measure, kind) VALUES (1, ${name}, ${size}, ${category}, ${measure}, ${kind}) RETURNING id::text` as { id: string }[];
  return r!.id;
}

/**
 * Several new items at once (a pasted Slack order, 2026-10-15) — `newItem`'s rules (one with the same name and no
 * size is reused, switched back on if off) in two statements, not two per item: a request has 50 subrequests.
 * Returns the ids in the order given.
 */
export async function newItems(sql: SqlFn, list: { name: string; kind: 'supply' | 'furniture'; measure: string }[], known: InvItem[]): Promise<string[]> {
  const clean = list.map(n => ({ name: n.name.trim().slice(0, 120), kind: n.kind === 'furniture' ? 'furniture' : 'supply', measure: n.measure.trim().slice(0, 20) || 'unit' }));
  if (clean.some(n => !n.name)) throw new Error('An item needs a name.');
  const had = (name: string) => known.find(i => itemKey(i.baseName ?? i.name) === itemKey(name) && !i.size);
  const off = [...new Set(clean.map(n => had(n.name)).filter(i => i && !i.active).map(i => i!.id))];
  if (off.length) await sql`UPDATE inventory_items SET active = true, updated_at = now() WHERE account_id = 1 AND id::text = ANY(${off})`;
  const fresh = [...new Map(clean.filter(n => !had(n.name)).map(n => [itemKey(n.name), n])).values()];
  const made = fresh.length ? await sql`INSERT INTO inventory_items (account_id, name, size, category, measure, kind)
      SELECT 1, r.name, NULL, 'other', r.measure, r.kind FROM jsonb_to_recordset(${JSON.stringify(fresh)}::jsonb) AS r(name text, measure text, kind text)
      RETURNING id::text, name` as { id: string; name: string }[] : [];
  return clean.map(n => had(n.name)?.id ?? made.find(m => itemKey(m.name) === itemKey(n.name))!.id);
}

/**
 * A NEW item corrected where it was made (owner, 2026-10-15: "it comes by unit, by kit, by pods — the
 * person corrects what the AI saw"): name, size, measure and type. Only while nothing is recorded for it —
 * changing "pack" to "pod" under a stock already counted would change what every number means; an item
 * with a history is edited in Setup → Inventory.
 */
export async function editNewItem(sql: SqlFn, b: Record<string, unknown>) {
  const id = Number(b.itemId) || 0;
  const [it] = await sql`SELECT id FROM inventory_items WHERE account_id = 1 AND id = ${id} AND active` as { id: number }[];
  if (!it) throw new Error('Which item?');
  const [used] = await sql`SELECT 1 FROM inventory_moves WHERE account_id = 1 AND item_id = ${id} LIMIT 1`;
  if (used) throw new Error('This item already has a record — edit it in Setup → Inventory.');
  const name = String(b.name ?? '').trim().slice(0, 120);
  const size = String(b.size ?? '').trim().slice(0, 30) || null;
  const measure = String(b.measure ?? 'unit').trim().slice(0, 20) || 'unit';
  const kind = b.kind === 'furniture' ? 'furniture' : 'supply';
  if (!name) throw new Error('An item needs a name.');
  const [dup] = await sql`SELECT 1 FROM inventory_items WHERE account_id = 1 AND id <> ${id} AND lower(name) = lower(${name})
                            AND lower(coalesce(size, '')) = lower(${size ?? ''})`;
  if (dup) throw new Error(`There is already an item called "${itemLabel(name, size)}".`);
  await sql`UPDATE inventory_items SET name = ${name}, size = ${size}, measure = ${measure}, kind = ${kind}, updated_at = now()
             WHERE account_id = 1 AND id = ${id}`;
}

/**
 * A to-do's own order, saved as a draft from the to-do (§150, owner: "it may
 * not be finished — save it as a draft, but the to-do has that order"): the
 * lines REPLACE its order (saving twice never doubles it), noted in its log;
 * no lines = no order. 🧾 Record the purchase starts from it.
 */
export async function saveTodoOrder(sql: SqlFn, by: string, todoId: unknown, lines: OrderIn[]): Promise<string | null> {
  const [t] = await sql`SELECT id::text FROM todos WHERE account_id = 1 AND id = ${Number(todoId) || 0} AND parent_id IS NULL
                          AND status NOT IN ('completed', 'cancelled')` as { id: string }[];
  if (!t) throw new Error('That to-do is closed or gone.');
  const keep = orderLinesIn(lines);
  if (!keep.length) { await sql`DELETE FROM inventory_orders WHERE account_id = 1 AND todo_id = ${Number(t.id)}`; return null; }
  const named = await nameOrderLines(sql, keep);
  await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by) VALUES (1, ${Number(t.id)}, ${JSON.stringify(keep)}::jsonb, ${by})
            ON CONFLICT (account_id, todo_id) DO UPDATE SET lines = EXCLUDED.lines, created_by = EXCLUDED.created_by, created_at = now()`;
  const body = `Order draft saved:\n${orderList(named)!.items.map(i => i.replace(/^Buy: /, '• ')).join('\n')}`;
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t.id}, 'change', ${body}, ${by})`;
  return body;
}

type OrderIn = { itemId: string; place: string; qty: number; at?: string };
/**
 * An order's lines as kept (owner, 2026-10-15): a listing not set up yet keeps them with no place ('') — picked
 * when it is bought (Record the purchase asks for it); `at` = where it is bought when not its linked store.
 */
function orderLinesIn(lines: OrderIn[]) {
  return lines.filter(l => l.qty > 0).map(l => ({ itemId: String(l.itemId), place: l.place, qty: Math.ceil(l.qty), ...(l.at ? { at: l.at } : {}) }));
}
/** Each line checked (the item, its place if it has one, a supply never in a house) and said in words. */
async function nameOrderLines(sql: SqlFn, keep: ReturnType<typeof orderLinesIn>) {
  const [items, sp] = await Promise.all([invItems(sql), supplyPlaces(sql)]);
  return keep.map(l => {
    const item = items.find(i => i.id === l.itemId);
    const p = l.place ? findPlace(sp, l.place) : null;
    if (!item) throw new Error('Which item?');
    if (l.place && !p) throw new Error('Which place?');
    if (p && !fitsPlace(p, item.kind)) throw new Error(`${item.name}: ${NOT_IN_HOUSE}`);
    return { item, place: `${p ? placeWord(p) : 'no place yet'}${l.at ? ` · at ${l.at}` : ''}`, qty: l.qty };
  });
}

/**
 * What is left out of an order goes on a new one for later (owner, 2026-10-15: "generate a new purchase order for
 * later with the removed items"): items taken off the cart, or not bought when the purchase was recorded. A new
 * to-do for the same listing with those lines (place — or none yet — and store kept), noted on both, so nothing
 * ordered is lost when the first one closes.
 */
export async function laterOrder(sql: SqlFn, by: string, fromTodo: unknown, lines: OrderIn[]) {
  const [t] = await sql`SELECT id::text, title, unit_ids FROM todos WHERE account_id = 1 AND id = ${Number(fromTodo) || 0} AND parent_id IS NULL` as
    { id: string; title: string; unit_ids: string[] | null }[];
  if (!t) throw new Error('Which to-do?');
  const keep = orderLinesIn(lines);
  if (!keep.length) throw new Error('Nothing to order.');
  const named = await nameOrderLines(sql, keep);
  const list = orderList(named)!;
  const said = list.items.map(i => i.replace(/^Buy: /, '• ')).join('\n');
  const id = await newTodo(sql, `${list.title} (later)`, `Left for later from “${t.title}” (#${t.id}). When it is bought: Record the purchase on this to-do.\n${said}`,
                           t.unit_ids?.[0] ?? null, by);
  await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by) VALUES (1, ${Number(id)}, ${JSON.stringify(keep)}::jsonb, ${by})`;
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t.id}, 'change', ${`Moved to a new order for later (#${id}):\n${said}`}, ${by})`;
  return id;
}

/**
 * Where an item is bought, and its link (owner, 2026-10-15: "if there is a link, add where it is bought, or change
 * it"; a broken one is reported and replaced). A Walmart/Amazon product page takes the place of the item's store
 * product (one per item; its pack kept unless a new one is given); any other store's page is kept under that
 * store's name (Home Depot…), replacing the one of that name. No link = that one is removed. Other options stay.
 */
export async function setStoreLink(sql: SqlFn, b: Record<string, unknown>) {
  const url = String(b.url ?? '').trim();
  const label = String(b.label ?? '').trim().slice(0, 60);
  const [it] = await sql`SELECT buy_options FROM inventory_items WHERE account_id = 1 AND id = ${Number(b.itemId) || 0}` as { buy_options: BuyOption[] | null }[];
  if (!it) throw new Error('Which item?');
  const prod = url ? storeProduct(url) : null;
  if (url && !prod && !/^https?:\/\/\S+$/i.test(url)) throw new Error('Paste the product page link (https://…).');
  if (url && /^(walmart|amazon)$/i.test(label) && prod?.store.toLowerCase() !== label.toLowerCase()) throw new Error(`Paste a ${label} product page.`);
  const all = it.buy_options ?? [];
  const given = Number(b.pack) > 0 ? Math.round(Number(b.pack) * 100) / 100 : null;
  let next: BuyOption[];
  if (prod || (!url && (!label || /^(walmart|amazon)$/i.test(label)))) {
    const rest = all.filter(o => !storeProduct(o.url));
    next = prod ? withProduct(rest, url, given ?? all.find(o => storeProduct(o.url))?.pack ?? null) : rest;
  } else {
    if (!label) throw new Error('Which store?');
    const same = (o: BuyOption) => !storeProduct(o.url) && o.label.toLowerCase() === label.toLowerCase();
    const pack = given ?? all.find(same)?.pack ?? null;
    next = [...all.filter(o => !same(o)), ...(url ? [{ label, url, ...(pack ? { pack } : {}) }] : [])].slice(0, 10);
  }
  await sql`UPDATE inventory_items SET buy_options = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE account_id = 1 AND id = ${Number(b.itemId)}`;
}

/** Said on the to-do (owner, 2026-10-15): what was taken off its order on purpose — on hand, or another order buys it. */
export async function orderNote(sql: SqlFn, by: string, todoId: unknown, notes: unknown) {
  const list = (Array.isArray(notes) ? notes : []).map(n => String(n).trim().slice(0, 200)).filter(Boolean).slice(0, 30);
  if (!list.length) return;
  const [t] = await sql`SELECT id::text FROM todos WHERE account_id = 1 AND id = ${Number(todoId) || 0}` as { id: string }[];
  if (!t) throw new Error('Which to-do?');
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t.id}, 'note', ${`Not bought on this order:\n${list.map(n => `• ${n}`).join('\n')}`}, ${by})`;
}

/** The order being written, saved as a draft (§150): no to-do until it is created. Empty lines = discard. */
export async function saveDraft(sql: SqlFn, by: string, lines: OrderIn[], forTodo: string | null) {
  const keep = orderLinesIn(lines);
  if (!keep.length) { await sql`DELETE FROM inventory_order_drafts WHERE account_id = 1`; return; }
  await sql`INSERT INTO inventory_order_drafts (account_id, lines, for_todo, saved_by) VALUES (1, ${JSON.stringify(keep)}::jsonb, ${forTodo ? Number(forTodo) : null}, ${by})
            ON CONFLICT (account_id) DO UPDATE SET lines = EXCLUDED.lines, for_todo = EXCLUDED.for_todo, saved_by = EXCLUDED.saved_by, saved_at = now()`;
}

/**
 * Low stock → a to-do on its own (§150, owner; switched in Setup → Inventory).
 * For each of the given places that has been counted, the items now below
 * their minimum: one open "Low stock at <place>" to-do per place, a sub-task
 * per item (never twice while it is open), and its order filled in — what
 * "To order" would suggest — so Record a purchase can start from it.
 * Returns the to-dos made (to announce and mirror).
 */
export async function lowStock(sql: SqlFn, places: (string | null)[]): Promise<string[]> {
  const keys = [...new Set(places.filter((p): p is string => !!p))];
  if (!keys.length) return [];
  const [acc] = await sql`SELECT inventory_low_stock_tasks AS low FROM accounts WHERE id = 1` as { low: boolean }[];
  if (!acc?.low) return [];
  const inv = await overview(sql);
  const made: string[] = [];
  for (const key of keys) {
    const p = inv.places.find(x => x.place === key);
    if (!p) continue;
    const low = p.items.filter(l => l.countedAt && l.qty !== null && l.min !== null && l.qty < l.min);
    if (!low.length) continue;
    const name = placeWord({ name: p.name, self: p.self, house: p.view === 'house' });
    let [t] = await sql`SELECT id::text FROM todos WHERE account_id = 1 AND low_stock_place = ${key} AND parent_id IS NULL
                          AND status NOT IN ('completed', 'cancelled') ORDER BY id DESC LIMIT 1` as { id: string }[];
    // §162: what is low is listed in the order's description (and its lines), not as a sub-task per item —
    // read back from there (and from sub-tasks, for an order made before), so an item is listed once.
    const listed = t ? [
      ...((await sql`SELECT title FROM todos WHERE account_id = 1 AND parent_id = ${Number(t.id)}` as { title: string }[]).map(r => r.title)),
      ...(((await sql`SELECT description FROM todos WHERE account_id = 1 AND id = ${Number(t.id)}` as { description: string | null }[])[0]?.description ?? '')
        .split('\n').map(l => l.replace(/^• /, '')))
    ] : [];
    const item = (id: string) => inv.items.find(i => i.id === id)!;
    const fresh = low.filter(l => !listed.some(x => x.startsWith(`Low: ${item(l.itemId).name} —`)));
    if (!fresh.length) continue;
    if (!t) {
      const from = p.from ? inv.places.find(x => x.place === p.from)?.name ?? 'its storage' : null;
      const id = await newTodo(sql, `Low stock at ${name}`, (from
        ? `Below the minimum to keep — counted places only. Refill it from ${from}: Inventory → ${name} → ⇄ Refill (or send someone and record it there). `
        : `Below the minimum to keep — counted places only. Buy it: Inventory → 🧾 Record a purchase, starting from this order. `) +
        `Switch these to-dos off in Setup → Inventory.`, p.units.length === 1 && (p.self || p.view === 'house') ? p.units[0]!.id : null, 'Kaizen', 'high');
      await sql`UPDATE todos SET low_stock_place = ${key} WHERE account_id = 1 AND id = ${Number(id)}`;
      t = { id };
      made.push(id);
    }
    const said = fresh.map(l => `• Low: ${item(l.itemId).name} — ${l.qty} left, keep ${l.min}${l.toOrder ? `; buy ${l.toOrder}` : l.toRefill ? `; refill ${l.toRefill}` : ''}`).join('\n');
    await sql`UPDATE todos SET description = concat_ws(E'\n', NULLIF(description, ''), ${said}), updated_at = now() WHERE account_id = 1 AND id = ${Number(t.id)}`;
    const lines = fresh.filter(l => l.toOrder > 0).map(l => ({ itemId: l.itemId, place: key, qty: l.toOrder }));
    if (lines.length) await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by) VALUES (1, ${Number(t.id)}, ${JSON.stringify(lines)}::jsonb, 'Kaizen')
                                ON CONFLICT (account_id, todo_id) DO UPDATE SET lines = inventory_orders.lines || EXCLUDED.lines`;
  }
  return made;
}

/** Purchases someone paid with their own money and is not paid back yet (§150) — newest first. */
export async function toPayBack(sql: SqlFn) {
  return await sql`SELECT p.id::text, p.paid_by AS "paidBy", p.total::float AS total, p.note, t.title AS "todo",
                          to_char(p.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS at, p.photos
                     FROM inventory_purchases p LEFT JOIN todos t ON t.id = p.todo_id
                    WHERE p.account_id = 1 AND p.paid_by IS NOT NULL AND p.paid_back_at IS NULL ORDER BY p.created_at DESC` as
    { id: string; paidBy: string; total: number; note: string | null; todo: string | null; at: string; photos: { name: string; url: string }[] }[];
}

/** Paid back (§150): marked with who and when — it leaves the list. */
export async function paidBack(sql: SqlFn, by: string, id: unknown) {
  const r = await sql`UPDATE inventory_purchases SET paid_back_at = now(), paid_back_by = ${by}
                       WHERE account_id = 1 AND id = ${Number(id) || 0} AND paid_by IS NOT NULL AND paid_back_at IS NULL RETURNING id` as unknown[];
  if (!r.length) throw new Error('Already paid back, or not found.');
}

/** The field's open to-dos (§150) — what a purchase order can be attached to. */
export async function fieldTodos(sql: SqlFn) {
  return await sql`SELECT id::text, title, clean_group AS "group" FROM todos WHERE account_id = 1 AND clean_key IS NOT NULL AND parent_id IS NULL
                      AND clean_group IN ('problem', 'request') AND status NOT IN ('completed', 'cancelled') ORDER BY id DESC LIMIT 60` as
    { id: string; title: string; group: 'problem' | 'request' }[];
}

/** The orders not yet closed, with their lines — what a purchase can start from. */
// §159 (owner, 2026-10-14): what a cleaner or an inspector asks to buy IS a purchase order from the moment it is
// asked — listed with the orders even before it has lines (its description says what was asked; ✨ builds the cart,
// or the receipt's reading fills it). A to-do with lines is an order as before.
export async function openOrders(sql: SqlFn) {
  return await sql`SELECT o.todo_id::text AS "todoId", t.title, o.lines, to_char(o.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS at,
                          t.unit_ids AS "unitIds", t.description AS asked,
                          (SELECT count(*)::int FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = o.todo_id) AS purchases
                     FROM inventory_orders o JOIN todos t ON t.id = o.todo_id
                    WHERE o.account_id = 1 AND t.status NOT IN ('completed', 'cancelled') AND t.deleted_at IS NULL
                   UNION ALL
                   SELECT t.id::text, t.title, '[]'::jsonb, to_char(t.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD'), t.unit_ids, t.description,
                          (SELECT count(*)::int FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = t.id)
                     FROM todos t
                    WHERE t.account_id = 1 AND t.clean_group IN ('request', 'inspection') AND t.parent_id IS NULL AND t.deleted_at IS NULL
                      AND t.status NOT IN ('completed', 'cancelled')
                      AND NOT EXISTS (SELECT 1 FROM inventory_orders o WHERE o.account_id = 1 AND o.todo_id = t.id)
                    ORDER BY 4 DESC` as
    { todoId: string; title: string; lines: { itemId: string; place: string; qty: number }[]; at: string; unitIds: string[] | null; asked: string | null; purchases: number }[];
}

/**
 * A purchase that was made (§150): what was bought, where each part went, what
 * it cost. Every line is checked before anything is saved. It adds to each
 * place's stock (a `purchase` move per line), reaches Costs as one Restock
 * expense — a house's own if everything went to one closet, else shared — and
 * is noted on the order it executes; the team closes the order when it is all bought.
 */
export async function recordPurchase(sql: SqlFn, by: string, b: Record<string, unknown>, photos: { name: string; url: string }[] = [],
                                     fieldExpenseId: string | null = null) {
  return await writePurchase(sql, by, await checkPurchase(sql, b), photos, fieldExpenseId);
}

/**
 * One receipt paying for several orders (owner, 2026-10-14): one purchase per
 * order, each with its share of the total and the same receipt. Every part is
 * checked before any is saved — never half a receipt recorded.
 */
export async function recordPurchases(sql: SqlFn, by: string, b: Record<string, unknown>, photos: { name: string; url: string }[] = []) {
  const raw = typeof b.splits === 'string' ? JSON.parse(b.splits || '[]') : b.splits;
  const parts = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  if (parts.length < 2 || parts.length > 10) throw new Error('Split into 2 to 10 parts.');
  const checked = [];
  for (const [k, p] of parts.entries()) {
    const note = [String(b.note ?? '').trim(), `part ${k + 1} of ${parts.length} of one receipt`].filter(Boolean).join(' — ');
    checked.push(await checkPurchase(sql, { ...p, note, paidBy: b.paidBy, date: b.date, ownerCharge: b.ownerCharge }));
  }
  const ids: string[] = [];
  for (const c of checked) ids.push(await writePurchase(sql, by, c, photos, null));
  return { ids, todoIds: checked.map(c => c.todoId).filter((x): x is number => !!x).map(String) };
}

async function checkPurchase(sql: SqlFn, b: Record<string, unknown>) {
  const raw = typeof b.lines === 'string' ? JSON.parse(b.lines || '[]') : b.lines;
  const lines = (Array.isArray(raw) ? raw : []).map((l: { itemId?: unknown; place?: unknown; qty?: unknown }) =>
    ({ itemId: String(l.itemId ?? ''), place: String(l.place ?? ''), qty: Math.round(Number(l.qty) * 100) / 100 })).filter(l => l.qty > 0);
  if (!lines.length) throw new Error('What was bought?');
  const total = Math.round(Number(b.total) * 100) / 100;
  if (!(total > 0) || total > 100000) throw new Error('Write the total you paid.');
  const [items, sp] = await Promise.all([invItems(sql), supplyPlaces(sql)]);
  const named = lines.map(l => {
    const item = items.find(i => i.id === l.itemId && i.active);
    const place = findPlace(sp, l.place);
    if (!item) throw new Error('Which item?');
    if (!place) throw new Error(l.place ? 'Which place?' : `${item.name}: say which place it went to.`);
    if (!fitsPlace(place, item.kind)) throw new Error(`${item.name}: ${NOT_IN_HOUSE}`);
    if (!Number.isFinite(l.qty) || l.qty > 10000) throw new Error('How many?');
    return { ...l, item, place };
  });
  const todoId = b.todoId ? Number(b.todoId) : null;
  // §150: any open to-do can carry its purchase (a cleaner's request, a problem…), with or without an order first.
  if (todoId) {
    const [o] = await sql`SELECT 1 FROM todos WHERE account_id = 1 AND id = ${todoId}`;
    if (!o) throw new Error('Which to-do?');
  }
  const note = String(b.note ?? '').trim().slice(0, 500) || null;
  // §150, owner: who paid — blank = the company; a name = brought with their own money, to be paid back.
  const paidBy = String(b.paidBy ?? '').trim().slice(0, 120) || null;
  // Owner, 2026-10-15: the owner's expense — marked so someone tells / charges the owner (nothing is sent to Hostaway).
  const ownerCharge = b.ownerCharge === true || b.ownerCharge === 'true';
  // The receipt's date (read from it, 2026-10-14) dates the expense in Costs — never ahead, at most 60 days back.
  const today = todayIn(TZ), d = String(b.date ?? '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && d >= addDays(today, -60) ? d : today;
  return { named, total, todoId, note, paidBy, date, ownerCharge };
}

async function writePurchase(sql: SqlFn, by: string, c: Awaited<ReturnType<typeof checkPurchase>>, photos: { name: string; url: string }[],
                             fieldExpenseId: string | null) {
  const { named, total, todoId, note, paidBy, date, ownerCharge } = c;
  const [pu] = await sql`INSERT INTO inventory_purchases (account_id, todo_id, total, note, photos, by_name, field_expense_id, paid_by, owner_charge)
                         VALUES (1, ${todoId}, ${total}, ${note}, ${JSON.stringify(photos)}::jsonb, ${by}, ${fieldExpenseId ? Number(fieldExpenseId) : null}, ${paidBy}, ${ownerCharge})
                         RETURNING id::text` as { id: string }[];
  for (const l of named) await sql`INSERT INTO inventory_moves (account_id, item_id, place, kind, qty, note, by_name, source, purchase_id)
                                   VALUES (1, ${Number(l.itemId)}, ${l.place.key}, 'purchase', ${l.qty}, ${note}, ${by}, 'team', ${Number(pu!.id)})`;
  const what = orderList(named.map(l => ({ item: l.item, place: placeWord(l.place), qty: l.qty })))!;
  const places = new Set(named.map(l => l.place.key));
  const only = places.size === 1 ? named[0]!.place : null;
  // Into one house (its closet or the house itself): the expense is that unit's.
  const unit = only && (only.self || only.house) && only.units.length === 1 ? only.units[0]!.id : null;
  await sql`INSERT INTO expenses (account_id, unit_id, shared, start_date, category, frequency, amount, label, notes, source, external_ref, created_by)
            VALUES (1, ${unit}, ${!unit}, ${date}, 'Restock', 'One-time', ${total}, ${`${ownerCharge ? "Owner's expense — " : ''}${what.title.replace(/^Buy supplies/, 'Supplies bought')}`.slice(0, 120)},
                    ${[...(ownerCharge ? ["Owner's expense — to tell / charge the owner"] : []), ...(paidBy ? [`Paid by ${paidBy} — to pay back`] : []), ...what.items.map(i => i.replace(/^Buy: /, '')), ...photos.map(p => `Receipt: ${p.url}`)].join('\n')}, 'inventory', ${`purchase-${pu!.id}`}, ${by})
            ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL DO NOTHING`;
  if (todoId) await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                        VALUES (1, 'task', ${String(todoId)}, 'note', ${`Bought ($${total.toFixed(2)})${ownerCharge ? " — 💼 owner's expense: tell / charge the owner" : ''}:\n${what.items.map(i => i.replace(/^Buy: /, '• ')).join('\n')}`}, ${by})`;
  return pu!.id;
}

/**
 * Something moved from one place to another (owner, 2026-10-15: furniture goes between the house and a storage):
 * out of one, into the other — two `adjust` moves that say where. Never more than the record has, once counted;
 * a supply never into a house. The team only.
 */
export async function transfer(sql: SqlFn, by: string, b: Record<string, unknown>) {
  return moveLines(sql, by, b.from, b.to, [{ itemId: b.itemId, qty: b.qty }], b.note);
}

/**
 * A closet refilled from its storage (owner, 2026-10-15): the same two moves per item, from the storage the
 * Repository names for that closet — when a cleaner finds it short, the team moves stock (or sends someone)
 * and records it here.
 */
export async function refillCloset(sql: SqlFn, by: string, b: Record<string, unknown>) {
  const sp = await supplyPlaces(sql);
  const closet = sp.places.find(p => p.key === String(b.to ?? ''));
  if (!closet?.from) throw new Error('That closet is not refilled from a storage — set its Storage in the Repository.');
  const lines = (Array.isArray(b.lines) ? b.lines : []) as { itemId: unknown; qty: unknown }[];
  if (!lines.length) throw new Error('Nothing to move.');
  return moveLines(sql, by, closet.from, closet.key, lines, b.note ?? 'Refill', sp);
}

async function moveLines(sql: SqlFn, by: string, fromKey: unknown, toKey: unknown, lines: { itemId: unknown; qty: unknown }[], rawNote: unknown,
                         known?: Awaited<ReturnType<typeof supplyPlaces>>) {
  const [items, sp] = await Promise.all([invItems(sql), known ?? supplyPlaces(sql)]);
  const from = findPlace(sp, String(fromKey ?? '')), to = findPlace(sp, String(toKey ?? ''));
  if (!from || !to) throw new Error('Which place?');
  if (from.key === to.key) throw new Error('Pick another place to move it to.');
  const want = lines.map(x => {
    const qty = Math.round(Number(x.qty) * 100) / 100;
    if (!(qty > 0) || qty > 10000) throw new Error('How many?');
    const item = items.find(i => i.id === String(x.itemId) && i.active);
    if (!item) throw new Error('Which item?');
    if (!fitsPlace(to, item.kind)) throw new Error(NOT_IN_HOUSE);
    return { item, qty };
  });
  const ids = want.map(w => Number(w.item.id));
  const levels = stockLevels(await sql`SELECT item_id::text AS "itemId", place, unit_id AS "unitId", kind, qty::float AS qty,
                                             to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at
                                        FROM inventory_moves WHERE account_id = 1 AND item_id = ANY(${ids})` as Move[]);
  for (const w of want) {
    const have = levels.get(`${w.item.id}|${placeKey(from.key)}`)?.qty;
    if (have != null && w.qty > have) throw new Error(`${w.item.name}: ${placeWord(from)} has ${have} on record — count it first if there are more.`);
  }
  const note = String(rawNote ?? '').trim().slice(0, 300);
  for (const w of want)
    await sql`INSERT INTO inventory_moves (account_id, item_id, place, kind, qty, note, by_name, source)
              VALUES (1, ${Number(w.item.id)}, ${from.key}, 'adjust', ${-w.qty}, ${`Moved to ${placeWord(to)}${note ? ` — ${note}` : ''}`}, ${by}, 'team'),
                     (1, ${Number(w.item.id)}, ${to.key}, 'adjust', ${w.qty}, ${`Moved from ${placeWord(from)}${note ? ` — ${note}` : ''}`}, ${by}, 'team')`;
  return [from.key, to.key];
}

/** "Counted in" of any item (owner, 2026-10-15: fix it where it shows — an order, a purchase): the label only, no quantity changes. */
export async function setMeasure(sql: SqlFn, b: Record<string, unknown>) {
  const measure = String(b.measure ?? '').trim().slice(0, 20);
  if (!measure) throw new Error('Counted in what? (unit, pack, roll…)');
  const r = await sql`UPDATE inventory_items SET measure = ${measure}, updated_at = now() WHERE account_id = 1 AND id = ${Number(b.itemId)} RETURNING id` as unknown[];
  if (!r.length) throw new Error('Which item?');
}

/** The minimum to keep of items in one place (§150); a blank goes back to the item's own. */
export async function setMins(sql: SqlFn, by: string, place: unknown, mins: { itemId: unknown; qty: unknown }[]) {
  const p = findPlace(await supplyPlaces(sql), String(place ?? ''));
  if (!p) throw new Error('Which place?');
  for (const m of mins) {
    const itemId = Number(m.itemId);
    if (m.qty === '' || m.qty == null) {
      await sql`DELETE FROM inventory_place_mins WHERE account_id = 1 AND item_id = ${itemId} AND place = ${p.key}`;
      continue;
    }
    const qty = Math.round(Number(m.qty) * 100) / 100;
    if (!(qty >= 0) || qty > 10000) throw new Error('How many?');
    await sql`INSERT INTO inventory_place_mins (account_id, item_id, place, min_qty, updated_by) VALUES (1, ${itemId}, ${p.key}, ${qty}, ${by})
              ON CONFLICT (account_id, item_id, place) DO UPDATE SET min_qty = EXCLUDED.min_qty, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
}

export type PlaceLook = { note: string | null; photos: { name: string; url: string }[]; byName: string; counted: number; at: string };
/** How a place looked at a count (owner, 2026-10-14): photos and a note, kept apart from the per-item moves. */
export async function recordLook(sql: SqlFn, by: string, place: unknown, note: unknown, photos: { name: string; url: string }[], counted: number) {
  const n = String(note ?? '').trim().slice(0, 1000) || null;
  if (!photos.length && !n) return;
  if (!findPlace(await supplyPlaces(sql), String(place))) throw new Error('Which place?');
  await sql`INSERT INTO inventory_place_looks (place, note, photos, by_name, counted)
            VALUES (${String(place)}, ${n}, ${JSON.stringify(photos)}::jsonb, ${by}, ${counted})`;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Photos from the field to Drive, folder "Kaizen — field reports" (made on first use). */
export async function fieldPhotos(sql: SqlFn, encryptionKey: string, files: File[], label: string) {
  if (!files.length) return [];
  if (files.length > 5) throw new Error('At most 5 photos at a time.');
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new DriveError(`${f.name} is over 15 MB.`);
    // A Walmart/Amazon order saved as Markdown is a purchase's receipt too (owner, 2026-10-15).
    if (!/^(image\/|application\/pdf$|text\/markdown$)/.test(f.type || '')) throw new DriveError(`${f.name}: a photo or a PDF, please.`);
  }
  const token = await driveToken(sql, encryptionKey);
  const [acc] = await sql`SELECT field_reports_folder FROM accounts WHERE id = 1` as { field_reports_folder: string | null }[];
  let folder = acc?.field_reports_folder ?? null;
  if (!folder) {
    folder = (await createFolder(token, null, 'Kaizen — field reports')).id;
    await sql`UPDATE accounts SET field_reports_folder = ${folder} WHERE id = 1`;
    // Owner, 2026-10-14: the whole team opens what Kaizen keeps in Drive.
    await shareRoot(sql, token, folder).catch(() => []);
  }
  const out: { name: string; url: string }[] = [];
  for (const f of files) {
    const up = await uploadFile(token, folder, `${todayIn(TZ)} ${label} — ${f.name}`.slice(0, 200), f.type || 'application/octet-stream', await f.arrayBuffer());
    out.push({ name: f.name.slice(0, 120), url: up.webViewLink ?? `https://drive.google.com/file/d/${up.id}/view` });
  }
  return out;
}

/**
 * After the response: to-dos made here go where any work goes — announced in
 * Slack's tasks channel ("A task is created", with its ▲ priority) and
 * mirrored to Hostaway.
 */
export async function mirrorTodos(sql: SqlFn, encryptionKey: string, ids: (string | null)[], by = 'Kaizen', announce = true) {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  // §150: a sub-task added to a clean's open to-do is not a new task — mirrored, not announced again.
  if (announce) for (const id of list) await notifyTask(sql, encryptionKey, id, 'created', by).catch(() => {});
  if (!(await mirrorOn(sql))) return;
  const creds = await getCredentials(sql, encryptionKey);
  for (const id of list) await pushWork(sql, creds, id).catch(() => {});
}
