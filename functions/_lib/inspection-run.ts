/**
 * An inspection run (§133), server side: start it, save each answer as it is
 * given (a phone that loses signal loses nothing), keep photos in Drive, and
 * at the end turn what needs attention into work.
 *
 *   repair    → a work order, unassigned, with an "Assign and schedule" sub-task
 *   purchase  → a to-do "Buy: …"
 *   clean_next→ a task on the unit's next clean (board row + the cleaner's page)
 *   clean_new → one new clean for the unit, unassigned, carrying those tasks
 *   none      → kept in the report only
 *
 * Work made here is mirrored to Hostaway like any other (pushWork, after the
 * response).
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { DriveError, createFolder, driveToken, uploadFile } from './gdrive.ts';
import { mirrorOn, pushWork } from './hostaway-tasks.ts';
import { opsConfig } from './ops.ts';
import { todayIn, addDays } from '../../src/lib/dates.ts';
import { eligibleInspectors } from '../../src/lib/operations.ts';
import { supplyPlaces, unitTypes } from './unit-access.ts';
import { invItems } from './inventory.ts';
import {
  ASSIGN_SUBTASK, areaTitle, checklistFor, cleanTaskText, overallResult, purchaseList, readyToFinish, repairList, roomsOf, suggestedOutcome,
  type Area, type AreaDef, type Check, type CheckResult, type InspectionItem, type Outcome, type UnitShape
} from '../../src/lib/inspection.ts';

const TZ = 'America/New_York';
const RESULTS = new Set(['ok', 'attention', 'na']);
const OUTCOMES = new Set(['repair', 'purchase', 'clean_next', 'clean_new', 'none']);

export async function templateItems(sql: SqlFn): Promise<InspectionItem[]> {
  const rows = await sql`SELECT id::text, area, label, default_outcome, applies_to, unit_ids, position, active FROM inspection_items
                          WHERE account_id = 1 ORDER BY area, position, id` as
    { id: string; area: Area; label: string; default_outcome: InspectionItem['defaultOutcome']; applies_to: InspectionItem['appliesTo'];
      unit_ids: string[] | null; position: number; active: boolean }[];
  return rows.map(r => ({ id: r.id, area: r.area, label: r.label, defaultOutcome: r.default_outcome, appliesTo: r.applies_to,
                          unitIds: r.unit_ids ?? [], position: r.position, active: r.active }));
}

/** The areas, in walking order — the team's own included (§138); switched-off ones too (the setup shows them). */
export async function inspectionAreas(sql: SqlFn): Promise<AreaDef[]> {
  const rows = await sql`SELECT key, label, per_room, position, active FROM inspection_areas WHERE account_id = 1 ORDER BY position, key` as
    { key: string; label: string; per_room: boolean; position: number; active: boolean }[];
  return rows.map(r => ({ key: r.key, label: r.label, perRoom: r.per_room, position: r.position, active: r.active }));
}

/** The unit as the checklist needs it: its rooms, and house or apartment from the Repository. */
async function unitShape(sql: SqlFn, ins: { unit_id: string | null; bedrooms: number | null; bathrooms: number | null }): Promise<UnitShape> {
  const type = ins.unit_id ? (await unitTypes(sql)).get(ins.unit_id)?.type ?? null : null;
  return { id: ins.unit_id ?? '', type, bedrooms: ins.bedrooms, bathrooms: ins.bathrooms };
}

type CheckRow = Check & { id: string; todoId: string | null; cleanTaskId: string | null };
async function checksOf(sql: SqlFn, inspectionId: string): Promise<CheckRow[]> {
  const rows = await sql`SELECT id::text, item_id::text, area, area_n, label, result, note, photos, outcome, todo_id::text, clean_task_id::text
                           FROM inspection_checks WHERE account_id = 1 AND inspection_id = ${Number(inspectionId)} ORDER BY id` as
    { id: string; item_id: string | null; area: Area; area_n: number; label: string; result: CheckResult | null; note: string | null;
      photos: { name: string; url: string }[]; outcome: Outcome | null; todo_id: string | null; clean_task_id: string | null }[];
  return rows.map(r => ({ id: r.id, itemId: r.item_id, area: r.area, n: r.area_n, label: r.label, result: r.result, note: r.note,
                          photos: r.photos ?? [], outcome: r.outcome, todoId: r.todo_id, cleanTaskId: r.clean_task_id } as CheckRow));
}

async function inspectionRow(sql: SqlFn, id: string) {
  const [r] = await sql`SELECT i.id::text, i.unit_id, i.unit_name, i.inspected_on::text AS date, i.inspector, i.result, i.notes,
                               i.started_at IS NOT NULL AS started, i.finished_at, u.bedrooms, u.bathrooms
                          FROM inspections i
                          LEFT JOIN units u ON u.account_id = i.account_id AND u.id = i.unit_id
                         WHERE i.account_id = 1 AND i.id = ${Number(id)}` as
    { id: string; unit_id: string | null; unit_name: string; date: string; inspector: string | null; result: string | null; notes: string | null;
      started: boolean; finished_at: string | null; bedrooms: number | null; bathrooms: number | null }[];
  return r ?? null;
}

/** The unit's next clean from today, as the record has it — where "for the next clean" tasks go. */
async function nextClean(sql: SqlFn, unitId: string | null, from: string) {
  if (!unitId) return null;
  const [c] = await sql`SELECT key, checkout_on::text AS date, cleaner FROM cleanings
                         WHERE account_id = 1 AND unit_id = ${unitId} AND checkout_on >= ${from}::date
                           AND void_reason IS NULL AND assignment <> 'not_needed'
                         ORDER BY checkout_on, key LIMIT 1` as { key: string; date: string; cleaner: string | null }[];
  return c ?? null;
}

/** Everything the pop-up needs for one inspection. */
export async function loadRun(sql: SqlFn, id: string) {
  const ins = await inspectionRow(sql, id);
  if (!ins) return null;
  const [items, areas, unit] = await Promise.all([templateItems(sql), inspectionAreas(sql), unitShape(sql, ins)]);
  const today = todayIn(TZ);
  const cfg = await opsConfig(sql);
  return {
    inspection: { id: ins.id, unitId: ins.unit_id, unit: ins.unit_name, date: ins.date, inspector: ins.inspector,
                  result: ins.result, notes: ins.notes, finished: !!ins.result },
    sections: checklistFor(items, unit, areas),
    rooms: { bedrooms: roomsOf(unit, 'bedroom'), bathrooms: roomsOf(unit, 'bathroom') },
    checks: await checksOf(sql, id),
    nextClean: await nextClean(sql, ins.unit_id, today),
    inspectors: eligibleInspectors(cfg.roster, cfg.extraInspectors, null),
    // §150: the supplies list, for the 🔍 on a purchase — the inspection's order comes filled in.
    supplies: (await invItems(sql)).filter(i => i.active).map(i => ({ id: i.id, name: i.name, measure: i.measure })),
    today
  };
}

/** Start one: a scheduled inspection, or a new one for a unit and day (one per unit per day). */
/** The inspector is never who cleaned the unit last, on or before the day — an inspection audits the clean. */
async function auditsOwnClean(sql: SqlFn, unitId: string | null, date: string, inspector: string | null) {
  if (!unitId || !inspector) return;
  const [c] = await sql`SELECT cleaner FROM cleanings WHERE account_id = 1 AND unit_id = ${unitId} AND checkout_on <= ${date}::date
                          AND assignment = 'assigned' AND void_reason IS NULL ORDER BY checkout_on DESC LIMIT 1` as { cleaner: string | null }[];
  if (c?.cleaner && c.cleaner === inspector) throw new Error(`${inspector} cleaned this unit last, so cannot inspect it — an inspection audits the clean.`);
}

export async function startRun(sql: SqlFn, who: string, b: { inspectionId?: unknown; unitId?: unknown; date?: unknown; inspector?: unknown }) {
  const inspector = String(b.inspector ?? '').trim() || null;
  if (b.inspectionId) {
    // A plan imported from the daily file has the unit's name only: found by name, so the checklist
    // gets its real bedrooms and bathrooms and its next clean.
    await sql`UPDATE inspections i SET unit_id = u.id FROM units u
               WHERE i.account_id = 1 AND i.id = ${Number(b.inspectionId)} AND i.unit_id IS NULL AND u.account_id = 1
                 AND lower(regexp_replace(u.name, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(i.unit_name, '[^a-zA-Z0-9]', '', 'g'))`;
    const [plan] = await sql`SELECT unit_id, inspected_on::text AS date, inspector FROM inspections WHERE account_id = 1 AND id = ${Number(b.inspectionId)}` as
      { unit_id: string | null; date: string; inspector: string | null }[];
    if (plan) await auditsOwnClean(sql, plan.unit_id, plan.date, inspector ?? plan.inspector);
    const done = await sql`UPDATE inspections SET started_at = COALESCE(started_at, now()), inspector = COALESCE(${inspector}, inspector),
                                  updated_at = now()
                            WHERE account_id = 1 AND id = ${Number(b.inspectionId)} AND result IS NULL RETURNING id::text` as { id: string }[];
    if (!done.length) throw new Error('That inspection is finished or gone.');
    return done[0]!.id;
  }
  const unitId = String(b.unitId ?? '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? '')) ? String(b.date) : todayIn(TZ);
  const [unit] = await sql`SELECT id, name FROM units WHERE account_id = 1 AND id = ${unitId}` as { id: string; name: string }[];
  if (!unit) throw new Error('Which unit?');
  await auditsOwnClean(sql, unit.id, date, inspector);
  const [row] = await sql`
    INSERT INTO inspections (account_id, unit_id, unit_name, inspected_on, inspector, started_at, created_by)
    VALUES (1, ${unit.id}, ${unit.name}, ${date}, ${inspector}, now(), ${who})
    ON CONFLICT (account_id, lower(unit_name), inspected_on) DO UPDATE SET
      started_at = COALESCE(inspections.started_at, now()), inspector = COALESCE(EXCLUDED.inspector, inspections.inspector),
      unit_id = COALESCE(inspections.unit_id, EXCLUDED.unit_id), updated_at = now()
    RETURNING id::text, result` as { id: string; result: string | null }[];
  if (row!.result) throw new Error(`${unit.name} was already inspected on ${date}.`);
  return row!.id;
}

async function openRun(sql: SqlFn, id: string) {
  const ins = await inspectionRow(sql, id);
  if (!ins) throw new Error('That inspection is gone.');
  if (ins.result) throw new Error('This inspection is finished — it is part of the record now.');
  return ins;
}

/** One answer, saved as it is given. Returns the check. */
export async function saveCheck(sql: SqlFn, who: string, b: Record<string, unknown>) {
  const id = String(b.inspectionId ?? '');
  await openRun(sql, id);
  const result = b.result == null ? null : String(b.result);
  if (result !== null && !RESULTS.has(result)) throw new Error('OK, needs attention, or not applicable.');
  const outcome = b.outcome == null ? undefined : String(b.outcome);
  if (outcome !== undefined && !OUTCOMES.has(outcome)) throw new Error('Unknown outcome.');
  const note = b.note === undefined ? undefined : (String(b.note ?? '').trim().slice(0, 1000) || null);

  if (b.checkId) {
    const [c] = await sql`UPDATE inspection_checks SET
        result = COALESCE(${result}, result), note = CASE WHEN ${note !== undefined} THEN ${note ?? null} ELSE note END,
        outcome = CASE WHEN ${outcome !== undefined} THEN ${outcome ?? null} ELSE outcome END,
        updated_by = ${who}, updated_at = now()
      WHERE account_id = 1 AND id = ${Number(b.checkId)} AND inspection_id = ${Number(id)} RETURNING id::text` as { id: string }[];
    if (!c) throw new Error('That finding is gone.');
    return c.id;
  }
  const itemId = String(b.itemId ?? '');
  const [item] = await sql`SELECT id, area, label, default_outcome FROM inspection_items WHERE account_id = 1 AND id = ${Number(itemId)}` as
    { id: string; area: Area; label: string; default_outcome: InspectionItem['defaultOutcome'] }[];
  if (!item) throw new Error('That checklist item is gone.');
  const n = Math.max(1, Math.min(20, Number(b.n) || 1));
  // A finding gets the item's usual outcome until the inspector picks another.
  const firstOutcome = outcome ?? (result === 'attention' ? suggestedOutcome(item.default_outcome) : null);
  const [c] = await sql`
    INSERT INTO inspection_checks (account_id, inspection_id, item_id, area, area_n, label, result, note, outcome, updated_by)
    VALUES (1, ${Number(id)}, ${Number(itemId)}, ${item.area}, ${n}, ${item.label}, ${result}, ${note ?? null}, ${firstOutcome}, ${who})
    ON CONFLICT (inspection_id, item_id, area_n) WHERE item_id IS NOT NULL DO UPDATE SET
      result = COALESCE(EXCLUDED.result, inspection_checks.result),
      note = CASE WHEN ${note !== undefined} THEN EXCLUDED.note ELSE inspection_checks.note END,
      outcome = CASE WHEN ${outcome !== undefined} THEN EXCLUDED.outcome
                     WHEN EXCLUDED.result = 'attention' THEN COALESCE(inspection_checks.outcome, EXCLUDED.outcome)
                     ELSE inspection_checks.outcome END,
      updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING id::text` as { id: string }[];
  return c!.id;
}

/** "Every item in this room is fine": the ones not answered yet become OK. */
export async function allOk(sql: SqlFn, who: string, b: Record<string, unknown>) {
  const id = String(b.inspectionId ?? '');
  const ins = await openRun(sql, id);
  const area = String(b.area ?? ''), n = Number(b.n) || 1;
  const areas = await inspectionAreas(sql);
  if (!areas.some(a => a.key === area)) throw new Error('Which room?');
  const sec = checklistFor(await templateItems(sql), await unitShape(sql, ins), areas)
    .find(s => s.area === area && s.n === n);
  if (!sec) return 0;
  const ids = sec.items.map(i => Number(i.id));
  const r = await sql`
    INSERT INTO inspection_checks (account_id, inspection_id, item_id, area, area_n, label, result, updated_by)
    SELECT 1, ${Number(id)}, i.id, i.area, ${n}, i.label, 'ok', ${who} FROM inspection_items i
     WHERE i.account_id = 1 AND i.id = ANY(${ids}::bigint[])
    ON CONFLICT (inspection_id, item_id, area_n) WHERE item_id IS NOT NULL DO NOTHING RETURNING id` as unknown[];
  return r.length;
}

/** A finding added on the spot — the fixed Cleaning / Repair / Purchase buttons. */
export async function addFinding(sql: SqlFn, who: string, b: Record<string, unknown>) {
  const id = String(b.inspectionId ?? '');
  await openRun(sql, id);
  const kind = String(b.kind ?? '');
  const outcome: Outcome = kind === 'purchase' ? 'purchase' : kind === 'clean' ? 'clean_next' : 'repair';
  // §150: a purchase can be a supply from the list (🔍) and how many — it goes on the order filled in.
  let supply: { id: number; name: string } | undefined, supplyQty: number | null = null;
  if (outcome === 'purchase' && b.supplyId) {
    [supply] = await sql`SELECT id, name FROM inventory_items WHERE account_id = 1 AND id = ${Number(b.supplyId)} AND active` as { id: number; name: string }[];
    if (!supply) throw new Error('Which item?');
    supplyQty = Math.ceil(Number(b.supplyQty) || 1);
    if (supplyQty < 1 || supplyQty > 10000) throw new Error('How many?');
  }
  const label = (supply ? `${supply.name} × ${supplyQty}` : String(b.label ?? '').trim()).slice(0, 200);
  if (!label) throw new Error('Say what it is.');
  const area = (await inspectionAreas(sql)).some(a => a.key === String(b.area)) ? String(b.area) : 'general';
  const n = Math.max(1, Number(b.n) || 1);
  const [c] = await sql`
    INSERT INTO inspection_checks (account_id, inspection_id, item_id, area, area_n, label, result, note, outcome, updated_by, supply_id, supply_qty)
    VALUES (1, ${Number(id)}, NULL, ${area}, ${n}, ${label}, 'attention', ${String(b.note ?? '').trim().slice(0, 1000) || null}, ${outcome}, ${who},
            ${supply?.id ?? null}, ${supplyQty})
    RETURNING id::text` as { id: string }[];
  return c!.id;
}

export async function removeFinding(sql: SqlFn, b: Record<string, unknown>) {
  const id = String(b.inspectionId ?? '');
  await openRun(sql, id);
  const r = await sql`DELETE FROM inspection_checks WHERE account_id = 1 AND inspection_id = ${Number(id)}
                        AND id = ${Number(b.checkId)} AND item_id IS NULL RETURNING id` as unknown[];
  if (!r.length) throw new Error('Only a finding added on the spot can be removed; a checklist item is answered instead.');
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Photos to Drive, folder "Kaizen — inspections" (made on first use), onto one finding. */
export async function addPhotos(sql: SqlFn, encryptionKey: string, who: string, inspectionId: string, checkId: string, files: File[]) {
  const ins = await openRun(sql, inspectionId);
  if (!files.length) throw new Error('No photo.');
  if (files.length > 5) throw new Error('At most 5 photos at a time.');
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new DriveError(`${f.name} is over 15 MB.`);
    if (!/^(image\/|application\/pdf$)/.test(f.type || '')) throw new DriveError(`${f.name}: a photo, please.`);
  }
  const [c] = await sql`SELECT area, area_n, label FROM inspection_checks WHERE account_id = 1 AND id = ${Number(checkId)}
                          AND inspection_id = ${Number(inspectionId)}` as { area: Area; area_n: number; label: string }[];
  if (!c) throw new Error('That finding is gone.');
  const token = await driveToken(sql, encryptionKey);
  const [acc] = await sql`SELECT inspection_photos_folder FROM accounts WHERE id = 1` as { inspection_photos_folder: string | null }[];
  let folder = acc?.inspection_photos_folder ?? null;
  if (!folder) {
    folder = (await createFolder(token, null, 'Kaizen — inspections')).id;
    await sql`UPDATE accounts SET inspection_photos_folder = ${folder} WHERE id = 1`;
  }
  const added: { name: string; url: string; driveId: string }[] = [];
  for (const f of files) {
    const up = await uploadFile(token, folder, `${ins.date} ${ins.unit_name} — ${c.label}`.slice(0, 150) + ` — ${f.name}`.slice(0, 50),
                                f.type || 'application/octet-stream', await f.arrayBuffer());
    added.push({ name: f.name.slice(0, 120), url: up.webViewLink ?? `https://drive.google.com/file/d/${up.id}/view`, driveId: up.id });
  }
  await sql`UPDATE inspection_checks SET photos = photos || ${JSON.stringify(added)}::jsonb, updated_by = ${who}, updated_at = now()
             WHERE account_id = 1 AND id = ${Number(checkId)}`;
  return added;
}

async function nextManualKey(sql: SqlFn) {
  return `MAN-${(await sql`SELECT nextval('manual_clean_seq') AS n`)[0].n}`;
}

/**
 * Finish: every finding has a decision (readyToFinish; photos are optional), then the
 * work is made, the inspection is closed with its overall result, and a
 * summary of what was made comes back. Pushes to Hostaway are returned for
 * the caller to run after the response.
 */
export async function finishRun(sql: SqlFn, who: string, b: Record<string, unknown>) {
  const id = String(b.inspectionId ?? '');
  const ins = await openRun(sql, id);
  // The review's cleaning step decides for the whole group: the next clean, or one new clean.
  if (b.cleanMode === 'next' || b.cleanMode === 'new') {
    await sql`UPDATE inspection_checks SET outcome = ${b.cleanMode === 'next' ? 'clean_next' : 'clean_new'}
               WHERE account_id = 1 AND inspection_id = ${Number(id)} AND result = 'attention'
                 AND outcome IN ('clean_next', 'clean_new') AND clean_task_id IS NULL`;
  }
  const checks = await checksOf(sql, id);
  const ready = readyToFinish(checks);
  if (!ready.ok) {
    throw new Error(`Choose what ${ready.undecided.length === 1 ? 'one finding' : `${ready.undecided.length} findings`} become${ready.undecided.length === 1 ? 's' : ''}.`);
  }
  const today = todayIn(TZ);
  // Everything is checked BEFORE anything is made: a finish that fails half way must not leave
  // work behind that a second try would make again.
  const cleanNextAll = checks.filter(x => x.result === 'attention' && x.outcome === 'clean_next' && !x.cleanTaskId);
  const nc = cleanNextAll.length ? await nextClean(sql, ins.unit_id, today) : null;
  if (cleanNextAll.length && !nc) throw new Error(`${ins.unit_name} has no clean coming up in the record — choose "a new clean" for those findings.`);
  const unit = { id: ins.unit_id ?? '', bedrooms: ins.bedrooms, bathrooms: ins.bathrooms };
  const areas = await inspectionAreas(sql);
  const count = (area: Area) => roomsOf(unit, area);
  const title = (c: Check) => areaTitle(c.area, c.n, count(c.area), areas);
  const inspector = ins.inspector ?? '';
  const made: { kind: string; title: string; id?: string }[] = [];
  const toPush: string[] = [];

  // A finding that already made its work (a finish retried) makes nothing again.
  // Repairs: ONE work order for all of them (§146 — easier to split one apart after than
  // to always juggle several). Purchases: one shopping list for all of them, below.
  const reps = checks.filter(x => x.result === 'attention' && x.outcome === 'repair' && !x.todoId);
  const repWork = repairList(reps, { unit: ins.unit_name, date: ins.date, inspector }, title);
  if (repWork) {
    const [t] = await sql`
      INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, inspection_id)
      VALUES (1, ${repWork.title}, ${repWork.description}, ${ins.unit_id ? [ins.unit_id] : []}, ${who}, 'work_order', 'pending', 'none', ${Number(id)})
      RETURNING id::text` as { id: string }[];
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'task', ${t!.id}, 'status', ${`Work order created from the inspection of ${ins.unit_name} on ${ins.date}${repWork.items.length ? ` — ${repWork.items.length} repairs` : ''}.`}, ${who})`;
    for (const item of repWork.items) {
      await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, priority, parent_id, inspection_id)
                VALUES (1, ${item}, ${ins.unit_id ? [ins.unit_id] : []}, ${who}, 'task', 'pending', 'none', ${Number(t!.id)}, ${Number(id)})`;
    }
    // Nobody is on a repair yet: its first step is to find someone and a day.
    await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, priority, parent_id, inspection_id)
              VALUES (1, ${ASSIGN_SUBTASK}, ${ins.unit_id ? [ins.unit_id] : []}, ${who}, 'task', 'pending', 'none', ${Number(t!.id)}, ${Number(id)})`;
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'task', ${t!.id}, 'change', ${`Sub-task added: ${ASSIGN_SUBTASK}`}, ${who})`;
    await sql`UPDATE inspection_checks SET todo_id = ${Number(t!.id)} WHERE account_id = 1 AND id = ANY(${reps.map(c => Number(c.id))}::bigint[])`;
    toPush.push(t!.id);
    made.push({ kind: 'repair', title: repWork.title, id: t!.id });
  }

  // Purchases: ONE to-do for all of them, an item per sub-task to tick off as it is bought.
  const buys = checks.filter(x => x.result === 'attention' && x.outcome === 'purchase' && !x.todoId);
  const list = purchaseList(buys, { unit: ins.unit_name, date: ins.date, inspector }, title);
  if (list) {
    const [t] = await sql`
      INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, inspection_id)
      VALUES (1, ${list.title}, ${list.description}, ${ins.unit_id ? [ins.unit_id] : []}, ${who}, 'task', 'pending', 'none', ${Number(id)})
      RETURNING id::text` as { id: string }[];
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'task', ${t!.id}, 'status', ${`To-do created from the inspection of ${ins.unit_name} on ${ins.date} — ${list.items.length} item${list.items.length === 1 ? '' : 's'} to buy.`}, ${who})`;
    for (const item of list.items) {
      await sql`INSERT INTO todos (account_id, title, unit_ids, created_by, kind, status, priority, parent_id, inspection_id)
                VALUES (1, ${item}, ${ins.unit_id ? [ins.unit_id] : []}, ${who}, 'task', 'pending', 'none', ${Number(t!.id)}, ${Number(id)})`;
    }
    await sql`UPDATE inspection_checks SET todo_id = ${Number(t!.id)} WHERE account_id = 1 AND id = ANY(${buys.map(c => Number(c.id))}::bigint[])`;
    // §150: the supplies chosen from the list make it an order filled in — to the unit's place — that
    // Inventory → 🧾 Record a purchase starts from. Free-text lines stay on the to-do only.
    const supplies = await sql`SELECT supply_id::text AS "itemId", supply_qty::float AS qty FROM inspection_checks
                                WHERE account_id = 1 AND id = ANY(${buys.map(c => Number(c.id))}::bigint[]) AND supply_id IS NOT NULL` as { itemId: string; qty: number }[];
    if (supplies.length) {
      const place = ins.unit_id ? (await supplyPlaces(sql)).byUnit.get(ins.unit_id)?.key ?? '' : '';
      await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by)
                VALUES (1, ${Number(t!.id)}, ${JSON.stringify(supplies.map(s => ({ itemId: s.itemId, place, qty: s.qty })))}::jsonb, ${who})`;
    }
    toPush.push(t!.id);
    made.push({ kind: 'purchase', title: list.title, id: t!.id });
  }

  // For a clean: the unit's next clean, or one new clean for all of them.
  const cleanNext = cleanNextAll;
  const cleanNew = checks.filter(x => x.result === 'attention' && x.outcome === 'clean_new' && !x.cleanTaskId);
  if (cleanNext.length && nc) {
    for (const c of cleanNext) {
      const [ct] = await sql`INSERT INTO clean_tasks (account_id, cleaning_key, unit_id, unit_name, clean_on, text, photos, inspection_id, created_by)
                             VALUES (1, ${nc.key}, ${ins.unit_id}, ${ins.unit_name}, ${nc.date}, ${cleanTaskText(c, title(c))},
                                     ${JSON.stringify(c.photos)}::jsonb, ${Number(id)}, ${who}) RETURNING id::text` as { id: string }[];
      await sql`UPDATE inspection_checks SET clean_task_id = ${Number(ct!.id)} WHERE account_id = 1 AND id = ${Number(c.id)}`;
      made.push({ kind: 'clean_next', title: `${nc.date}${nc.cleaner ? ` (${nc.cleaner})` : ''}: ${cleanTaskText(c, title(c))}` });
    }
  }
  if (cleanNew.length) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.cleanDate ?? '')) ? String(b.cleanDate) : addDays(today, 1);
    const [u] = await sql`SELECT bedrooms FROM units WHERE account_id = 1 AND id = ${ins.unit_id}` as { bedrooms: number | null }[];
    const key = await nextManualKey(sql);
    await sql`
      INSERT INTO cleanings (account_id, key, unit_id, unit_name, checkout_on, cleaner, assignment, price, deep,
                             reservation_note, beds, source, decided_by, kind, created_by)
      VALUES (1, ${key}, ${ins.unit_id}, ${ins.unit_name}, ${date}, NULL, 'tbd', NULL, false,
              ${`From the inspection of ${ins.date}`}, ${u?.bedrooms ?? null}, 'manual', ${`inspection:${who}`}, 'extra', ${who})`;
    for (const c of cleanNew) {
      const [ct] = await sql`INSERT INTO clean_tasks (account_id, cleaning_key, unit_id, unit_name, clean_on, text, photos, inspection_id, created_by)
                             VALUES (1, ${key}, ${ins.unit_id}, ${ins.unit_name}, ${date}, ${cleanTaskText(c, title(c))},
                                     ${JSON.stringify(c.photos)}::jsonb, ${Number(id)}, ${who}) RETURNING id::text` as { id: string }[];
      await sql`UPDATE inspection_checks SET clean_task_id = ${Number(ct!.id)} WHERE account_id = 1 AND id = ${Number(c.id)}`;
    }
    made.push({ kind: 'clean_new', title: `New clean on ${date} (unassigned) with ${cleanNew.length} task${cleanNew.length === 1 ? '' : 's'}`, id: key });
  }

  const result = typeof b.result === 'string' && b.result.trim() ? b.result.trim().slice(0, 60) : overallResult(checks);
  // The report lists every finding and what it became — including work a retried finish made earlier.
  const ICON: Record<string, string> = { repair: '🔧', purchase: '🛒', clean_next: '🧽 next clean:', clean_new: '🧽 new clean:', none: '—' };
  const findings = checks.filter(x => x.result === 'attention');
  const notes = [String(b.notes ?? '').trim().slice(0, 1500) || null,
                 findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}: ` +
                   findings.map(c => `${ICON[c.outcome ?? 'none']} ${title(c)} — ${c.label}${c.note ? ` (${c.note})` : ''}`).join(' · ')
                 : 'Everything checked OK.']
    .filter(Boolean).join('\n').slice(0, 3000);
  // Work a retried finish had already made is still listed on the done screen.
  for (const c of findings) if (c.todoId && !made.some(m => m.id === c.todoId)) {
    made.unshift({ kind: c.outcome === 'repair' ? 'repair' : 'purchase', title: `${title(c)}: ${c.label}`, id: c.todoId });
  }
  await sql`UPDATE inspections SET result = ${result}, notes = ${notes}, finished_at = now(), updated_at = now(),
                   inspected_on = LEAST(inspected_on, ${today}::date)
             WHERE account_id = 1 AND id = ${Number(id)}`;
  return { result, made, toPush };
}

/** After the response: the new work to Hostaway, as any work made in Kaizen. */
export async function pushMade(sql: SqlFn, encryptionKey: string, ids: string[]) {
  if (!ids.length || !(await mirrorOn(sql))) return;
  const creds = await getCredentials(sql, encryptionKey);
  for (const id of ids) await pushWork(sql, creds, id).catch(() => {});
}
