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
import { todayIn, addDays } from '../../src/lib/dates.ts';
import { orderList, perClean, placeKey, stockLevels, toOrder, type InvItem, type Move, type MoveKind } from '../../src/lib/inventory.ts';

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

/** Every place's stock, use per clean, coming cleans and what to order. */
export async function overview(sql: SqlFn) {
  const today = todayIn(TZ);
  const [items, units, moveRows, aheadCleans] = await Promise.all([
    invItems(sql), activeUnits(sql),
    sql`SELECT item_id::text AS "itemId", unit_id AS "unitId", kind, qty::float AS qty, cleaning_key AS "cleaningKey",
               to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI:SS') AS at, by_name AS "byName", source
          FROM inventory_moves WHERE account_id = 1 ORDER BY created_at`,
    sql`SELECT unit_id, count(*)::int AS n FROM cleanings WHERE account_id = 1 AND void_reason IS NULL AND assignment <> 'not_needed'
           AND checkout_on > ${today}::date AND checkout_on <= ${addDays(today, AHEAD_DAYS)}::date GROUP BY unit_id`
  ]) as [InvItem[], { id: string; name: string }[], Move[], { unit_id: string; n: number }[]];
  const levels = stockLevels(moveRows);
  const ahead = new Map(aheadCleans.map(r => [r.unit_id, r.n]));
  const since = addDays(today, -WINDOW_DAYS);
  const places = [{ id: null as string | null, name: 'Storage' }, ...units.map(u => ({ id: u.id as string | null, name: u.name }))];
  const rows = places.map(p => {
    const cleansAhead = p.id ? ahead.get(p.id) ?? 0 : 0;
    return {
      unitId: p.id, place: p.name, cleansAhead,
      items: items.filter(i => i.active).map(i => {
        const l = levels.get(`${i.id}|${placeKey(p.id)}`);
        const uses = moveRows.filter(m => m.itemId === i.id && placeKey(m.unitId) === placeKey(p.id) && m.kind === 'used' && m.at >= since);
        const cleansWithUses = new Set(uses.map(u => u.cleaningKey ?? u.at.slice(0, 10))).size;
        const r = perClean(i, uses.reduce((a, u) => a + u.qty, 0), cleansWithUses);
        return { itemId: i.id, qty: l?.qty ?? null, countedAt: l?.countedAt ?? null, missingSince: l?.missingSince ?? null,
                 perClean: r.rate, learned: r.learned,
                 // Only a counted record is trusted: uses reported in a never-counted unit floor at 0 and would order everything.
                 toOrder: p.id ? toOrder(l?.countedAt ? l.qty : null, r.rate, cleansAhead, i.reorderAt) : 0 };
      })
    };
  });
  const recent = (await sql`
    SELECT m.id::text, i.name AS item, COALESCE(u.name, 'Storage') AS place, m.kind, m.qty::float AS qty, m.note, m.by_name AS "byName",
           m.source, m.photos, to_char(m.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
      FROM inventory_moves m JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN units u ON u.account_id = m.account_id AND u.id = m.unit_id
     WHERE m.account_id = 1 ORDER BY m.id DESC LIMIT 100`);
  return { items, places: rows, recent, aheadDays: AHEAD_DAYS, windowDays: WINDOW_DAYS };
}

/** The messages a field reporter can get, in Spanish (§129: the crew page and the report link speak the cleaner's language). */
const ES: Record<string, string> = {
  'Count, used, bought, adjust or missing.': 'Usado, comprado o falta.',
  'Counts and corrections are the team’s.': 'Los conteos y correcciones los hace el equipo.',
  'How many?': '¿Cuántos?',
  'Which item?': '¿Cuál artículo?',
  'Which unit?': '¿Cuál unidad?',
  'The cost is a number.': 'El costo es un número.',
  'Say what it is.': 'Di qué es.',
  'At most 5 photos at a time.': 'Máximo 5 fotos a la vez.'
};
export const esMessage = (m: string) => ES[m] ?? m.replace(/ is over 15 MB\.$/, ' pesa más de 15 MB.').replace(/: a photo or a PDF, please\.$/, ': una foto o un PDF, por favor.');

const KINDS = new Set(['count', 'used', 'purchase', 'adjust', 'missing']);
export type Who = { name: string; source: 'team' | 'cleaner' | 'link'; email?: string };

async function unitName(sql: SqlFn, unitId: string | null) {
  if (!unitId) return 'Storage';
  const [u] = await sql`SELECT name FROM units WHERE account_id = 1 AND id = ${unitId}` as { name: string }[];
  if (!u) throw new Error('Which unit?');
  return u.name;
}

async function newTodo(sql: SqlFn, title: string, description: string | null, unitId: string | null, by: string, sub: string[] = []) {
  const [t] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority)
                        VALUES (1, ${title.slice(0, 300)}, ${description}, ${unitId ? [unitId] : []}, ${by}, 'task', 'pending', 'none')
                        RETURNING id::text` as { id: string }[];
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t!.id}, 'status', ${`To-do created by ${by}.`}, ${by})`;
  for (const s of sub) {
    await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, priority, parent_id)
              VALUES (1, ${s.slice(0, 300)}, ${unitId ? [unitId] : []}, ${by}, 'task', 'pending', 'none', ${Number(t!.id)})`;
  }
  return t!.id;
}

/**
 * One move. A "missing" report also makes a to-do to count the item there —
 * one person not finding something is a reason to look, not to zero the record.
 * Returns the to-do to mirror, if one was made.
 */
export async function recordMove(sql: SqlFn, who: Who, b: Record<string, unknown>, photos: { name: string; url: string }[] = []) {
  const kind = String(b.kind ?? '') as MoveKind;
  if (!KINDS.has(kind)) throw new Error('Count, used, bought, adjust or missing.');
  if (who.source !== 'team' && (kind === 'count' || kind === 'adjust')) throw new Error('Counts and corrections are the team’s.');
  const qty = Math.round(Number(b.qty) * 100) / 100;
  if (!Number.isFinite(qty) || (kind === 'adjust' ? qty === 0 : qty < 0) || Math.abs(qty) > 10000) throw new Error('How many?');
  if ((kind === 'used' || kind === 'purchase') && qty === 0) throw new Error('How many?');
  const [item] = await sql`SELECT id, name, measure FROM inventory_items WHERE account_id = 1 AND id = ${Number(b.itemId)} AND active` as
    { id: number; name: string; measure: string }[];
  if (!item) throw new Error('Which item?');
  const unitId = b.unitId ? String(b.unitId) : null;
  const place = await unitName(sql, unitId);
  const note = String(b.note ?? '').trim().slice(0, 500) || null;
  const cost = b.cost == null || b.cost === '' ? null : Math.round(Number(b.cost) * 100) / 100;
  if (cost !== null && !(cost >= 0)) throw new Error('The cost is a number.');
  let todoId: string | null = null;
  if (kind === 'missing') {
    const levels = stockLevels(await sql`SELECT item_id::text AS "itemId", unit_id AS "unitId", kind, qty::float AS qty,
                                               to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at
                                          FROM inventory_moves WHERE account_id = 1 AND item_id = ${item.id}` as Move[]);
    const said = levels.get(`${item.id}|${placeKey(unitId)}`)?.qty;
    todoId = await newTodo(sql, `Check stock: ${item.name} at ${place}`,
      `${who.name} found ${qty} ${item.measure}${qty === 1 ? '' : 's'}${said != null ? `; the record says ${said}` : ''}.${note ? `\nNote: ${note}` : ''}` +
      photos.map(p => `\nPhoto: ${p.url}`).join('') + `\nCount it in Operations → Inventory to set the record right.`,
      unitId, who.email ?? who.name);
  }
  await sql`INSERT INTO inventory_moves (account_id, item_id, unit_id, kind, qty, cleaning_key, cost, note, photos, by_name, source, todo_id)
            VALUES (1, ${item.id}, ${unitId}, ${kind}, ${qty}, ${b.cleaningKey ? String(b.cleaningKey) : null}, ${cost}, ${note},
                    ${JSON.stringify(photos)}::jsonb, ${who.name}, ${who.source}, ${todoId ? Number(todoId) : null})`;
  return { todoId, place, item: item.name };
}

/** A problem or a request from the field: a to-do for the team. */
export async function fieldTodo(sql: SqlFn, who: Who, b: Record<string, unknown>, photos: { name: string; url: string }[] = []) {
  const what = b.kind === 'request' ? 'Request' : 'Problem';
  const text = String(b.text ?? '').trim().slice(0, 300);
  if (!text) throw new Error('Say what it is.');
  const unitId = b.unitId ? String(b.unitId) : null;
  const place = unitId ? await unitName(sql, unitId) : null;
  return newTodo(sql, place ? `${what} at ${place}: ${text}` : `${what}: ${text}`,
    `Reported by ${who.name}.${photos.map(p => `\nPhoto: ${p.url}`).join('')}`, unitId, who.email ?? who.name);
}

/** What to order, as one to-do with a line per item. */
export async function createOrder(sql: SqlFn, by: string, lines: { itemId: string; unitId: string | null; qty: number }[]) {
  const items = await invItems(sql);
  const units = await activeUnits(sql);
  const named = lines.filter(l => l.qty > 0).flatMap(l => {
    const item = items.find(i => i.id === String(l.itemId));
    return item ? [{ item, place: l.unitId ? units.find(u => u.id === l.unitId)?.name ?? l.unitId : 'Storage', qty: Math.ceil(l.qty) }] : [];
  });
  const list = orderList(named);
  if (!list) throw new Error('Nothing to order.');
  return newTodo(sql, list.title, `From Operations → Inventory, ${todayIn(TZ)}.`, null, by, list.items);
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

/** After the response: to-dos made here to Hostaway, as any work. */
export async function mirrorTodos(sql: SqlFn, encryptionKey: string, ids: (string | null)[]) {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length || !(await mirrorOn(sql))) return;
  const creds = await getCredentials(sql, encryptionKey);
  for (const id of list) await pushWork(sql, creds, id).catch(() => {});
}
