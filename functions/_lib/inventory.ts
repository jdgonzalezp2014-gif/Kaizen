/**
 * Inventory, server side (§134): the overview per place with what to order,
 * recording moves (from the team, a cleaner's page, or a shared report link),
 * and turning an order into one to-do — a shopping list with a sub-task per
 * line, mirrored to Hostaway like any work.
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { DriveError, createFolder, driveToken, uploadFile } from './gdrive.ts';
import { mirrorOn, pushWork } from './hostaway-tasks.ts';
import { notifyTask } from './slack.ts';
import { addFieldExpense } from './field-costs.ts';
import type { Priority } from '../../src/lib/todos.ts';

const FIELD_PRIORITY = new Set(['urgent', 'high', 'low']);
import { todayIn, addDays } from '../../src/lib/dates.ts';
import { needByPlace, orderList, perClean, placeKey, stockLevels, toOrder, unitUses, type InvItem, type Move, type MoveKind } from '../../src/lib/inventory.ts';
import { supplyPlaces } from './unit-access.ts';

const TZ = 'America/New_York';
const WINDOW_DAYS = 60, AHEAD_DAYS = 14;

export async function invItems(sql: SqlFn): Promise<InvItem[]> {
  const rows = await sql`SELECT id::text, name, category, measure, per_clean::float AS per_clean, reorder_at::float AS reorder_at, active
                           FROM inventory_items WHERE account_id = 1 ORDER BY active DESC, category, lower(name)` as
    { id: string; name: string; category: string; measure: string; per_clean: number | null; reorder_at: number | null; active: boolean }[];
  return rows.map(r => ({ id: r.id, name: r.name, category: r.category, measure: r.measure, perClean: r.per_clean, reorderAt: r.reorder_at, active: r.active }));
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
  const [items, sp, units, moveRows, aheadCleans, minRows, answeredRows] = await Promise.all([
    invItems(sql), supplyPlaces(sql), activeUnits(sql),
    sql`SELECT item_id::text AS "itemId", place, unit_id AS "unitId", kind, qty::float AS qty, cleaning_key AS "cleaningKey",
               to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI:SS') AS at, by_name AS "byName", source
          FROM inventory_moves WHERE account_id = 1 ORDER BY created_at`,
    sql`SELECT unit_id, count(*)::int AS n FROM cleanings WHERE account_id = 1 AND void_reason IS NULL AND assignment <> 'not_needed'
           AND checkout_on > ${today}::date AND checkout_on <= ${addDays(today, AHEAD_DAYS)}::date GROUP BY unit_id`,
    sql`SELECT item_id::text AS "itemId", place, min_qty::float AS min FROM inventory_place_mins WHERE account_id = 1`,
    // The cleans that said what they took (lines or "nothing"): the average per clean is over these.
    sql`SELECT unit_id, cleaning_key FROM clean_records WHERE account_id = 1 AND supplies_at IS NOT NULL AND unit_id IS NOT NULL
           AND clean_date >= ${addDays(today, -WINDOW_DAYS)}::date`
  ]) as [InvItem[], Awaited<ReturnType<typeof supplyPlaces>>, { id: string; name: string }[], Move[], { unit_id: string; n: number }[],
         { itemId: string; place: string; min: number }[], { unit_id: string; cleaning_key: string }[]];
  const answered = new Map<string, string[]>();
  for (const r of answeredRows) answered.set(r.unit_id, [...answered.get(r.unit_id) ?? [], r.cleaning_key]);
  const levels = stockLevels(moveRows);
  const ahead = new Map(aheadCleans.map(r => [r.unit_id, r.n]));
  const since = addDays(today, -WINDOW_DAYS);
  const mins = new Map(minRows.map(m => [`${m.itemId}|${m.place}`, m.min]));
  // Places the Repository no longer lists (renamed, archived, or "no place") still show while their moves say something.
  const rows: { key: string | null; name: string; self: boolean; units: { id: string; name: string; recordId: string | null }[] }[] =
    sp.places.map(p => ({ key: p.key as string | null, name: p.name, self: p.self, units: p.units }));
  for (const k of new Set(moveRows.map(m => m.place))) if (!rows.some(r => r.key === k))
    rows.push({ key: k, name: k ? `${sp.names.get(k) ?? k} (no longer a place)` : '▲ No place', self: false, units: [] });
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
  const places = rows.map(p => ({
    place: p.key, name: p.name, self: p.self,
    units: p.units.map(u => ({ ...u, cleansAhead: ahead.get(u.id) ?? 0 })),
    items: active.map(i => {
      const l = levels.get(`${i.id}|${placeKey(p.key)}`);
      const own = p.key ? mins.get(`${i.id}|${p.key}`) : undefined;
      const min = own ?? i.reorderAt;
      const need = p.key ? needs.get(i.id)!.get(p.key) ?? 0 : 0;
      const r = placeRate(i, p.units.map(u => u.id));
      return { itemId: i.id, qty: l?.qty ?? null, countedAt: l?.countedAt ?? null, missingSince: l?.missingSince ?? null,
               perClean: r.rate, learned: r.learned, reportedCleans: r.cleans, need: Math.ceil(need), min, minOwn: own !== undefined,
               // Only a counted place is ordered for: a never-counted record is not a stock (§134).
               toOrder: p.key ? toOrder(l?.countedAt ? l.qty : null, need, min) : 0 };
    })
  }));
  const recent = (await sql`
    SELECT m.id::text, i.name AS item, m.place, u.name AS unit, m.kind, m.qty::float AS qty, m.note, m.by_name AS "byName",
           m.source, m.photos, to_char(m.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
      FROM inventory_moves m JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN units u ON u.account_id = m.account_id AND u.id = m.unit_id
     WHERE m.account_id = 1 ORDER BY m.id DESC LIMIT 100` as { place: string | null }[])
    .map(m => ({ ...m, place: m.place ? sp.names.get(m.place) ?? m.place : null }));
  const unassigned = sp.unassigned.map(u => ({ ...u, cleansAhead: ahead.get(u.id) ?? 0 }));
  return { items, places, unassigned, recent, orders: await openOrders(sql), aheadDays: AHEAD_DAYS, windowDays: WINDOW_DAYS };
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

/**
 * Where a move happens (§150). The team names the place (a count, a purchase
 * into a storage); the field never does — a cleaner's take comes out of the
 * place the unit is assigned to in the Repository at that moment. A unit with
 * no place still records (null, shown ▲): the cleaner's step is never blocked.
 */
function placeOf(sp: Places, who: Who, unitId: string | null, unit: string | null, asked: unknown) {
  if (who.source === 'team' && asked) {
    const p = sp.places.find(x => x.key === String(asked));
    if (!p) throw new Error('Which place?');
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

async function newTodo(sql: SqlFn, title: string, description: string | null, unitId: string | null, by: string, sub: string[] = [],
                       priority: Priority = 'none') {
  const [t] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority)
                        VALUES (1, ${title.slice(0, 300)}, ${description}, ${unitId ? [unitId] : []}, ${by}, 'task', 'pending', ${priority})
                        RETURNING id::text` as { id: string }[];
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t!.id}, 'status', ${`To-do created by ${by}.`}, ${by})`;
  for (const s of sub) {
    await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, priority, parent_id)
              VALUES (1, ${s.slice(0, 300)}, ${unitId ? [unitId] : []}, ${by}, 'task', 'pending', 'none', ${Number(t!.id)})`;
  }
  return t!.id;
}

const RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };
/**
 * What a cleaner reports on one clean — a need, something missing, something
 * bought — is ONE to-do for that clean, each report a sub-task (§150, owner):
 * the team sees a clean's asks together. The to-do takes the most urgent
 * priority of its sub-tasks. `fresh`: the to-do was just made (announce it);
 * else a sub-task was added to the open one. Null when the clean is unknown.
 */
async function cleanTodo(sql: SqlFn, who: Who, cleaningKey: unknown, title: string, description: string | null, priority: Priority) {
  if (!cleaningKey) return null;
  const [c] = await sql`SELECT unit_id, unit_name, clean_date::text AS date FROM clean_records WHERE account_id = 1 AND cleaning_key = ${String(cleaningKey)}` as
    { unit_id: string | null; unit_name: string; date: string }[];
  if (!c) return null;
  const by = who.email ?? who.name;
  let [t] = await sql`SELECT id::text, priority FROM todos WHERE account_id = 1 AND clean_key = ${String(cleaningKey)} AND parent_id IS NULL
                         AND status NOT IN ('completed', 'cancelled') ORDER BY id DESC LIMIT 1` as { id: string; priority: string }[];
  const fresh = !t;
  if (!t) {
    const id = await newTodo(sql, `From the clean of ${c.unit_name} on ${c.date}`, `What ${who.name} reported on this clean — each one is a sub-task.`,
                             c.unit_id, by, [], priority);
    await sql`UPDATE todos SET clean_key = ${String(cleaningKey)} WHERE account_id = 1 AND id = ${Number(id)}`;
    t = { id, priority };
  }
  await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, parent_id)
            VALUES (1, ${title.slice(0, 300)}, ${description}, ${c.unit_id ? [c.unit_id] : []}, ${by}, 'task', 'pending', ${priority}, ${Number(t.id)})`;
  if ((RANK[priority] ?? 0) > (RANK[t.priority] ?? 0)) await sql`UPDATE todos SET priority = ${priority}, updated_at = now() WHERE account_id = 1 AND id = ${Number(t.id)}`;
  if (!fresh) await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                        VALUES (1, 'task', ${t.id}, 'change', ${`${who.name} added: ${title}`.slice(0, 4000)}, ${by})`;
  return { todoId: t.id, fresh };
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
  const [item] = await sql`SELECT id, name, measure FROM inventory_items WHERE account_id = 1 AND id = ${Number(b.itemId)} AND active` as
    { id: number; name: string; measure: string }[];
  if (!item) throw new Error('Which item?');
  const unitId = b.unitId ? String(b.unitId) : null;
  const unit = unitId ? await unitName(sql, unitId) : null;
  const at = placeOf(known ?? await supplyPlaces(sql), who, unitId, unit, b.place);
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
    const ct = who.source !== 'team' ? await cleanTodo(sql, who, b.cleaningKey, title, description, 'medium') : null;
    if (ct) ({ todoId, fresh } = ct);
    else todoId = await newTodo(sql, title, description, unitId, who.email ?? who.name, [], 'medium');
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
  return lines.length;
}

/** "Nothing from the storage" — said, not skipped: the step is answered. */
export async function nothingTaken(sql: SqlFn, who: Who, cleaningKey: string) {
  await sql`UPDATE clean_records SET supplies_at = now(), supplies_by = ${who.name},
                   supplies_none = NOT EXISTS (SELECT 1 FROM inventory_moves WHERE account_id = 1 AND cleaning_key = ${cleaningKey} AND kind = 'taken')
             WHERE account_id = 1 AND cleaning_key = ${cleaningKey}`;
}

/** A problem or a request from the field: a to-do for the team. */
export async function fieldTodo(sql: SqlFn, who: Who, b: Record<string, unknown>, photos: { name: string; url: string }[] = []) {
  const what = b.kind === 'request' ? 'Request' : 'Problem';
  const text = String(b.text ?? '').trim().slice(0, 300);
  if (!text) throw new Error('Say what it is.');
  const unitId = b.unitId ? String(b.unitId) : null;
  const place = unitId ? await unitName(sql, unitId) : null;
  // §134: the reporter says how urgent (required on the form); urgent = before the next guest.
  const priority = FIELD_PRIORITY.has(String(b.priority)) ? String(b.priority) as Priority : 'medium';
  const description = `Reported by ${who.name}.${photos.map(p => `\nPhoto: ${p.url}`).join('')}`;
  // §150: a need joins its clean's to-do as a sub-task; "something is wrong" is always its own to-do.
  if (b.kind === 'request') {
    const ct = await cleanTodo(sql, who, b.cleaningKey, `${what}: ${text}`, description, priority);
    if (ct) return ct;
  }
  return { todoId: await newTodo(sql, place ? `${what} at ${place}: ${text}` : `${what}: ${text}`, description, unitId, who.email ?? who.name, [], priority), fresh: true };
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
  const ct = await cleanTodo(sql, who, b.cleaningKey, title, description, 'medium');
  return { fieldExpense: id, todoId: ct?.todoId ?? null, fresh: ct?.fresh ?? false };
}

/** What to order, as one to-do with a line per item and the place it goes to. */
export async function createOrder(sql: SqlFn, by: string, lines: { itemId: string; place: string; qty: number }[]) {
  const [items, sp] = await Promise.all([invItems(sql), supplyPlaces(sql)]);
  const named = lines.filter(l => l.qty > 0).flatMap(l => {
    const item = items.find(i => i.id === String(l.itemId));
    const p = sp.places.find(x => x.key === l.place);
    if (!p) throw new Error('Which place?');
    return item ? [{ item, place: p.self ? `${p.name} closet` : p.name, qty: Math.ceil(l.qty) }] : [];
  });
  const list = orderList(named);
  if (!list) throw new Error('Nothing to order.');
  const id = await newTodo(sql, list.title, `From Operations → Inventory, ${todayIn(TZ)}. When it is bought: Inventory → 🧾 Record a purchase.`, null, by, list.items);
  // The lines as data: the purchase that executes this order starts from them.
  await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by)
            VALUES (1, ${Number(id)}, ${JSON.stringify(lines.filter(l => l.qty > 0).map(l => ({ itemId: String(l.itemId), place: l.place, qty: Math.ceil(l.qty) })))}::jsonb, ${by})`;
  return id;
}

/** The orders not yet closed, with their lines — what a purchase can start from. */
export async function openOrders(sql: SqlFn) {
  return await sql`SELECT o.todo_id::text AS "todoId", t.title, o.lines, to_char(o.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS at,
                          (SELECT count(*)::int FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = o.todo_id) AS purchases
                     FROM inventory_orders o JOIN todos t ON t.id = o.todo_id
                    WHERE o.account_id = 1 AND t.status NOT IN ('completed', 'cancelled') ORDER BY o.created_at DESC` as
    { todoId: string; title: string; lines: { itemId: string; place: string; qty: number }[]; at: string; purchases: number }[];
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
  const raw = typeof b.lines === 'string' ? JSON.parse(b.lines || '[]') : b.lines;
  const lines = (Array.isArray(raw) ? raw : []).map((l: { itemId?: unknown; place?: unknown; qty?: unknown }) =>
    ({ itemId: String(l.itemId ?? ''), place: String(l.place ?? ''), qty: Math.round(Number(l.qty) * 100) / 100 })).filter(l => l.qty > 0);
  if (!lines.length) throw new Error('What was bought?');
  const total = Math.round(Number(b.total) * 100) / 100;
  if (!(total > 0) || total > 100000) throw new Error('Write the total you paid.');
  const [items, sp] = await Promise.all([invItems(sql), supplyPlaces(sql)]);
  const named = lines.map(l => {
    const item = items.find(i => i.id === l.itemId && i.active);
    const place = sp.places.find(p => p.key === l.place);
    if (!item) throw new Error('Which item?');
    if (!place) throw new Error('Which place?');
    if (!Number.isFinite(l.qty) || l.qty > 10000) throw new Error('How many?');
    return { ...l, item, place };
  });
  const todoId = b.todoId ? Number(b.todoId) : null;
  if (todoId) {
    const [o] = await sql`SELECT 1 FROM inventory_orders WHERE account_id = 1 AND todo_id = ${todoId}`;
    if (!o) throw new Error('Which order?');
  }
  const note = String(b.note ?? '').trim().slice(0, 500) || null;
  const [pu] = await sql`INSERT INTO inventory_purchases (account_id, todo_id, total, note, photos, by_name, field_expense_id)
                         VALUES (1, ${todoId}, ${total}, ${note}, ${JSON.stringify(photos)}::jsonb, ${by}, ${fieldExpenseId ? Number(fieldExpenseId) : null})
                         RETURNING id::text` as { id: string }[];
  for (const l of named) await sql`INSERT INTO inventory_moves (account_id, item_id, place, kind, qty, note, by_name, source, purchase_id)
                                   VALUES (1, ${Number(l.itemId)}, ${l.place.key}, 'purchase', ${l.qty}, ${note}, ${by}, 'team', ${Number(pu!.id)})`;
  const what = orderList(named.map(l => ({ item: l.item, place: l.place.self ? `${l.place.name} closet` : l.place.name, qty: l.qty })))!;
  const places = new Set(named.map(l => l.place.key));
  const only = places.size === 1 ? named[0]!.place : null;
  const unit = only?.self && only.units.length === 1 ? only.units[0]!.id : null;
  await sql`INSERT INTO expenses (account_id, unit_id, shared, start_date, category, frequency, amount, label, notes, source, external_ref, created_by)
            VALUES (1, ${unit}, ${!unit}, ${todayIn(TZ)}, 'Restock', 'One-time', ${total}, ${what.title.replace(/^Buy supplies/, 'Supplies bought').slice(0, 120)},
                    ${[...what.items.map(i => i.replace(/^Buy: /, '')), ...photos.map(p => `Receipt: ${p.url}`)].join('\n')}, 'inventory', ${`purchase-${pu!.id}`}, ${by})
            ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL DO NOTHING`;
  if (todoId) await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                        VALUES (1, 'task', ${String(todoId)}, 'note', ${`Bought ($${total.toFixed(2)}):\n${what.items.map(i => i.replace(/^Buy: /, '• ')).join('\n')}`}, ${by})`;
  return pu!.id;
}

/** The minimum to keep of items in one place (§150); a blank goes back to the item's own. */
export async function setMins(sql: SqlFn, by: string, place: unknown, mins: { itemId: unknown; qty: unknown }[]) {
  const sp = await supplyPlaces(sql);
  const p = sp.places.find(x => x.key === String(place ?? ''));
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

const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Photos from the field to Drive, folder "Kaizen — field reports" (made on first use). */
export async function fieldPhotos(sql: SqlFn, encryptionKey: string, files: File[], label: string) {
  if (!files.length) return [];
  if (files.length > 5) throw new Error('At most 5 photos at a time.');
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new DriveError(`${f.name} is over 15 MB.`);
    if (!/^(image\/|application\/pdf$)/.test(f.type || '')) throw new DriveError(`${f.name}: a photo or a PDF, please.`);
  }
  const token = await driveToken(sql, encryptionKey);
  const [acc] = await sql`SELECT field_reports_folder FROM accounts WHERE id = 1` as { field_reports_folder: string | null }[];
  let folder = acc?.field_reports_folder ?? null;
  if (!folder) {
    folder = (await createFolder(token, null, 'Kaizen — field reports')).id;
    await sql`UPDATE accounts SET field_reports_folder = ${folder} WHERE id = 1`;
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
