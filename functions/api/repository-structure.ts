/**
 * POST /api/repository-structure — sections, tables and columns.
 *
 *   { op: 'sections.create', title }
 *   { op: 'sections.rename', section, title }
 *   { op: 'tables.create', section, title, idPrefix? }
 *   { op: 'tables.rename', table, title }
 *   { op: 'columns.add', table, column: { title, type, group?, options?, required? } }
 *   { op: 'columns.update', table, columnKey, changes: { title?, type?, options?, group?, required? } }
 *   { op: 'columns.move', table, columnKey, direction: 'left' | 'right' }
 *
 *   { op: 'columns.reorder', table, columnKey, toIndex }
 *   { op: 'columns.delete', table, columnKey, confirm }   confirm = the column's title
 *   { op: 'tables.delete', table, confirm }               the sheet is hidden, the folder archived
 *
 * `repository.structure` (roles.ts). Deleting a column erases its values
 * from the sheet, so it demands the column's name typed back — a click
 * cannot do it by accident — and the sheet's version history is the undo.
 */
import { db, type Env } from '../_lib/db.ts';
import { getRepoCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { STRUCTURE, RepoError, repoCall } from '../_lib/repository.ts';

const KEY = /^[a-z0-9_]{1,64}$/;
/** What a person may type; `id`, `folder`, `auto` are the engine's own. */
const TYPES = new Set(['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'email', 'url', 'ref', 'secret', 'doc']);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const creds = await getRepoCredentials(sql, env.ENCRYPTION_KEY);
  if (!creds) return fail(409, 'The Data Repository is not connected.');

  const b = await request.json().catch(() => ({})) as Record<string, any>;
  const op = String(b.op ?? '');
  if (!STRUCTURE.has(op)) return fail(400, `"${op}" is not a structure change.`);
  const title = String(b.title ?? '').trim().slice(0, 80);
  const options = (raw: unknown) => Array.isArray(raw)
    ? [...new Set(raw.map(v => String(v).trim()).filter(Boolean))] : undefined;

  let params: Record<string, unknown>;
  let detail: string;
  if (op === 'sections.create') {
    if (!title) return fail(400, 'A section needs a name.');
    params = { title }; detail = title;
  } else if (op === 'sections.rename') {
    if (!KEY.test(String(b.section)) || !title) return fail(400, 'Which section, and its new name?');
    params = { section: b.section, title }; detail = `${b.section} → ${title}`;
  } else if (op === 'tables.create') {
    if (!KEY.test(String(b.section)) || !title) return fail(400, 'A section and a table name.');
    const idPrefix = String(b.idPrefix ?? '').trim().toUpperCase().slice(0, 6);
    if (idPrefix && !/^[A-Z0-9]+$/.test(idPrefix)) return fail(400, 'The ID prefix is letters and digits, like UNI.');
    params = { section: b.section, title, options: idPrefix ? { idPrefix } : {} }; detail = `${b.section} / ${title}`;
  } else if (op === 'tables.rename') {
    if (!KEY.test(String(b.table)) || !title) return fail(400, 'Which table, and its new name?');
    params = { table: b.table, title }; detail = `→ ${title}`;
  } else if (op === 'columns.add') {
    const c = (b.column ?? {}) as Record<string, unknown>;
    const ct = String(c.title ?? '').trim().slice(0, 80);
    const type = String(c.type ?? 'text');
    if (!KEY.test(String(b.table)) || !ct || !TYPES.has(type)) return fail(400, 'A table, a column name and a type.');
    const opts = options(c.options);
    if (type === 'select' && !opts?.length) return fail(400, 'A dropdown needs its options.');
    params = { table: b.table, column: { title: ct, type, group: String(c.group ?? '').trim() || undefined,
                                         options: opts, required: c.required === true } };
    detail = `+ ${ct} (${type})`;
  } else if (op === 'columns.update') {
    const ch = (b.changes ?? {}) as Record<string, unknown>;
    if (!KEY.test(String(b.table)) || !KEY.test(String(b.columnKey))) return fail(400, 'Which column?');
    const changes: Record<string, unknown> = {};
    if (typeof ch.title === 'string' && ch.title.trim()) changes.title = ch.title.trim().slice(0, 80);
    if (typeof ch.type === 'string') { if (!TYPES.has(ch.type)) return fail(400, 'Unknown type.'); changes.type = ch.type; }
    if (ch.options !== undefined) changes.options = options(ch.options) ?? null;
    if (typeof ch.group === 'string') changes.group = ch.group.trim();
    if (typeof ch.required === 'boolean') changes.required = ch.required;
    if (!Object.keys(changes).length) return fail(400, 'Nothing to change.');
    params = { table: b.table, columnKey: b.columnKey, changes };
    detail = `${b.columnKey}: ${Object.keys(changes).join(', ')}`;
  } else if (op === 'columns.reorder') {
    const to = Number(b.toIndex);
    if (!KEY.test(String(b.table)) || !KEY.test(String(b.columnKey)) || !Number.isInteger(to) || to < 0) {
      return fail(400, 'Which column, and where to?');
    }
    params = { table: b.table, columnKey: b.columnKey, toIndex: to };
    detail = `${b.columnKey} → position ${to + 1}`;
  } else if (op === 'columns.delete' || op === 'tables.delete') {
    if (!KEY.test(String(b.table))) return fail(400, 'Which table?');
    if (op === 'columns.delete' && !KEY.test(String(b.columnKey))) return fail(400, 'Which column?');
    // The title typed back, checked against the repository's own record of it.
    const meta = await repoCall<{ sections: { tables: { key: string; title: string; columns: { key: string; title: string }[] }[] }[] }>(creds, 'meta');
    const t = meta.sections.flatMap(s => s.tables).find(x => x.key === b.table);
    const name = op === 'tables.delete' ? t?.title : t?.columns.find(c => c.key === b.columnKey)?.title;
    if (!name) return fail(404, 'Not found.');
    if (String(b.confirm ?? '').trim() !== name) return fail(400, `Type “${name}” to confirm.`);
    params = op === 'tables.delete' ? { table: b.table } : { table: b.table, columnKey: b.columnKey };
    detail = op === 'tables.delete' ? `archived ${name}` : `deleted column ${name}`;
  } else {
    if (!KEY.test(String(b.table)) || !KEY.test(String(b.columnKey)) || !['left', 'right'].includes(b.direction)) {
      return fail(400, 'Which column, and which way?');
    }
    params = { table: b.table, columnKey: b.columnKey, direction: b.direction };
    detail = `${b.columnKey} ${b.direction}`;
  }

  try {
    const data = await repoCall<unknown>(creds, op, { ...params, actor: who.email });
    await sql`INSERT INTO repo_audit (account_id, actor, action, table_key, detail)
              VALUES (1, ${who.email}, ${op}, ${String(b.table ?? b.section ?? '') || null}, ${detail})`;
    return Response.json({ ok: true, data });
  } catch (e) {
    return fail(e instanceof RepoError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository', message }, { status });
}
