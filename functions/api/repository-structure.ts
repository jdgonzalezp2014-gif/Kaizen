/**
 * POST /api/repository-structure — sections, tables and columns.
 *
 *   { op: 'sections.create', title }
 *   { op: 'sections.rename', section, title }
 *   { op: 'tables.create', section, title, idPrefix? }
 *   { op: 'tables.rename', table, title }
 *   { op: 'tables.delete', table, confirm }               archived: hidden, nothing erased
 *   { op: 'columns.add', table, column: { title, type, group?, options?, required? } }
 *   { op: 'columns.update', table, columnKey, changes: { title?, type?, options?, group?, required? } }
 *   { op: 'columns.move', table, columnKey, direction: 'left' | 'right' }
 *   { op: 'columns.reorder', table, columnKey, toIndex }
 *   { op: 'columns.delete', table, columnKey, confirm }   confirm = the column's title
 *
 * `repository.structure` (roles.ts). Structure is data, as it was in the
 * old repository: an admin shapes it from the screen, never a migration.
 *
 * Deleting a column erases its values from every record, so it demands the
 * column's name typed back — a click cannot do it by accident — and the
 * audit row keeps what was erased (never a secret: those are dropped).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { KEY, SYSTEM_KEYS, audit, tableCols } from '../_lib/repo-store.ts';
import { CONVERTIBLE, coerce, slug, type ColumnType } from '../../src/lib/repo.ts';

const OPS = new Set(['sections.create', 'sections.rename', 'tables.create', 'tables.rename', 'tables.delete',
                     'columns.add', 'columns.update', 'columns.move', 'columns.reorder', 'columns.delete']);
/** What a person may create. `ref` comes only from the import, where the target is known. */
const NEW_TYPES = new Set<string>([...CONVERTIBLE, 'secret', 'doc']);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;

  const b = await request.json().catch(() => ({})) as Record<string, any>;
  const op = String(b.op ?? '');
  if (!OPS.has(op)) return fail(400, `"${op}" is not a structure change.`);
  const title = String(b.title ?? '').trim().slice(0, 80);
  const options = (raw: unknown) => Array.isArray(raw)
    ? [...new Set(raw.map(v => String(v).trim()).filter(Boolean))] : undefined;
  const log = (detail: string, table: string | null = null) => audit(sql, who.email, op, table, null, detail);

  try {
    /* ── sections ── */
    if (op === 'sections.create') {
      if (!title) return fail(400, 'A section needs a name.');
      const taken = (await sql`SELECT key FROM repo_sections WHERE account_id = 1`).map((r: any) => r.key);
      const key = slug(title, taken);
      await sql`INSERT INTO repo_sections (account_id, key, title, position)
                SELECT 1, ${key}, ${title}, COALESCE(MAX(position), 0) + 1 FROM repo_sections WHERE account_id = 1`;
      await log(title);
      return ok({ key });
    }
    if (op === 'sections.rename') {
      if (!KEY.test(String(b.section)) || !title) return fail(400, 'Which section, and its new name?');
      const r = await sql`UPDATE repo_sections SET title = ${title} WHERE account_id = 1 AND key = ${b.section} RETURNING key`;
      if (!r.length) return fail(404, 'No such section.');
      await log(`${b.section} → ${title}`);
      return ok({ key: b.section });
    }

    /* ── tables ── */
    if (op === 'tables.create') {
      if (!KEY.test(String(b.section)) || !title) return fail(400, 'A section and a table name.');
      const idPrefix = String(b.idPrefix ?? '').trim().toUpperCase().slice(0, 6);
      if (idPrefix && !/^[A-Z0-9]+$/.test(idPrefix)) return fail(400, 'The ID prefix is letters and digits, like UNI.');
      const sec = await sql`SELECT 1 FROM repo_sections WHERE account_id = 1 AND key = ${b.section} AND archived_at IS NULL`;
      if (!sec.length) return fail(404, 'No such section.');
      // Keys are unique across archived tables too: an archived table's
      // records still hold its key.
      const taken = (await sql`SELECT key FROM repo_tables WHERE account_id = 1`).map((r: any) => r.key);
      const key = slug(title, taken);
      await sql`INSERT INTO repo_tables (account_id, key, section_key, title, id_prefix, name_fields, position)
                SELECT 1, ${key}, ${b.section}, ${title}, ${idPrefix}, ${['name']}, COALESCE(MAX(position), 0) + 1
                  FROM repo_tables WHERE account_id = 1`;
      // Every table starts with the column that names its records.
      await sql`INSERT INTO repo_columns (account_id, table_key, key, title, type, required, position)
                VALUES (1, ${key}, 'name', 'Name', 'text', TRUE, 1)`;
      await log(`${b.section} / ${title}`, key);
      return ok({ key });
    }

    const table = String(b.table ?? '');
    if (!KEY.test(table)) return fail(400, 'Which table?');
    const t = await tableCols(sql, table);
    if (!t) return fail(404, 'That table does not exist, or was archived.');

    if (op === 'tables.rename') {
      if (!title) return fail(400, 'Its new name?');
      await sql`UPDATE repo_tables SET title = ${title} WHERE account_id = 1 AND key = ${table}`;
      await log(`→ ${title}`, table);
      return ok({ key: table });
    }
    if (op === 'tables.delete') {
      if (String(b.confirm ?? '').trim() !== t.table.title) return fail(400, `Type “${t.table.title}” to confirm.`);
      await sql`UPDATE repo_tables SET archived_at = now() WHERE account_id = 1 AND key = ${table}`;
      await log(`archived ${t.table.title}`, table);
      return ok({ key: table });
    }

    /* ── columns ── */
    if (op === 'columns.add') {
      const c = (b.column ?? {}) as Record<string, unknown>;
      const ct = String(c.title ?? '').trim().slice(0, 80);
      const type = String(c.type ?? 'text');
      if (!ct || !NEW_TYPES.has(type)) return fail(400, 'A column name and a type.');
      const opts = options(c.options);
      if (type === 'select' && !opts?.length) return fail(400, 'A dropdown needs its options.');
      const key = slug(ct, [...t.cols.map(x => x.key), ...SYSTEM_KEYS]);
      await sql`INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, required, options, position)
                SELECT 1, ${table}, ${key}, ${ct}, ${type}, ${String(c.group ?? '').trim() || 'Details'},
                       ${c.required === true && type !== 'checkbox'}, ${type === 'select' ? opts! : null},
                       COALESCE(MAX(position), 0) + 1
                  FROM repo_columns WHERE account_id = 1 AND table_key = ${table}`;
      await log(`+ ${ct} (${type})`, table);
      return ok({ key });
    }

    const columnKey = String(b.columnKey ?? '');
    const col = t.cols.find(c => c.key === columnKey);
    if (!col) return fail(404, 'No such column.');

    if (op === 'columns.update') {
      const ch = (b.changes ?? {}) as Record<string, unknown>;
      const next = { title: col.title, type: col.type, options: col.options, required: col.required, group: null as string | null };
      const said: string[] = [];
      if (typeof ch.title === 'string' && ch.title.trim()) { next.title = ch.title.trim().slice(0, 80); said.push(`title → ${next.title}`); }
      if (ch.options !== undefined) { next.options = options(ch.options) ?? null; said.push('options'); }
      if (typeof ch.group === 'string') { next.group = ch.group.trim() || 'Details'; said.push(`group → ${next.group}`); }
      if (typeof ch.required === 'boolean') { next.required = ch.required; said.push(ch.required ? 'required' : 'optional'); }
      let converted = 0, cleared = 0;
      if (typeof ch.type === 'string' && ch.type !== col.type) {
        // Only between the plain types. A secret, a reference or a
        // document column holds something else entirely — turning one into
        // text would put passwords in the clear.
        if (!CONVERTIBLE.includes(col.type) || !CONVERTIBLE.includes(ch.type as ColumnType)) {
          return fail(400, `A ${col.type} column keeps its type. Add a new column instead.`);
        }
        next.type = ch.type as ColumnType;
        said.push(`type ${col.type} → ${next.type}`);
      }
      if (next.type === 'select' && !next.options?.length) return fail(400, 'A dropdown needs its options.');

      if (next.type !== col.type) {
        // Values move with the column: what fits is converted, what does
        // not is cleared — and the count is said, not hidden.
        const recs = await sql`SELECT id, vals ->> ${columnKey} AS v, vals ? ${columnKey} AS has
                                 FROM repo_records WHERE account_id = 1 AND table_key = ${table}` as
          { id: string; v: string | null; has: boolean }[];
        const map: Record<string, unknown> = {};
        for (const r of recs) {
          if (!r.has) continue;
          const v = coerce({ type: next.type, options: next.options }, r.v);
          map[r.id] = v;
          if (r.v !== null && String(r.v).trim() !== '') { if (v === '') cleared++; else converted++; }
        }
        if (Object.keys(map).length) {
          await sql`UPDATE repo_records r SET vals = r.vals || jsonb_build_object(${columnKey}::text, m.value)
                      FROM jsonb_each(${JSON.stringify(map)}::jsonb) m
                     WHERE r.account_id = 1 AND r.table_key = ${table} AND r.id = m.key`;
        }
        said.push(`${converted} converted, ${cleared} cleared`);
      }
      if (!said.length) return fail(400, 'Nothing to change.');
      await sql`UPDATE repo_columns SET title = ${next.title}, type = ${next.type},
                       options = ${next.type === 'select' ? next.options : null},
                       required = ${next.required && next.type !== 'checkbox'},
                       grp = COALESCE(${next.group}, grp)
                 WHERE account_id = 1 AND table_key = ${table} AND key = ${columnKey}`;
      await log(`${columnKey}: ${said.join('; ')}`, table);
      return ok({ key: columnKey, converted, cleared });
    }

    if (op === 'columns.move' || op === 'columns.reorder') {
      const order = t.cols.map(c => c.key);
      const from = order.indexOf(columnKey);
      let to: number;
      if (op === 'columns.move') {
        if (!['left', 'right'].includes(b.direction)) return fail(400, 'Which way?');
        to = from + (b.direction === 'left' ? -1 : 1);
      } else {
        to = Number(b.toIndex);
        if (!Number.isInteger(to)) return fail(400, 'Where to?');
      }
      to = Math.max(0, Math.min(order.length - 1, to));
      if (to === from) return ok({ key: columnKey });
      order.splice(from, 1);
      order.splice(to, 0, columnKey);
      await sql`UPDATE repo_columns c SET position = o.n
                  FROM unnest(${order}::text[]) WITH ORDINALITY AS o(key, n)
                 WHERE c.account_id = 1 AND c.table_key = ${table} AND c.key = o.key`;
      await log(`${columnKey} → position ${to + 1}`, table);
      return ok({ key: columnKey });
    }

    // columns.delete
    if (String(b.confirm ?? '').trim() !== col.title) return fail(400, `Type “${col.title}” to confirm.`);
    if (t.cols.length === 1) return fail(400, 'A table keeps at least one column.');
    const erased = col.type === 'secret' ? [] : await sql`
      SELECT id, vals -> ${columnKey} AS v FROM repo_records
       WHERE account_id = 1 AND table_key = ${table} AND vals ? ${columnKey}
         AND COALESCE(vals ->> ${columnKey}, '') <> ''` as { id: string; v: unknown }[];
    await sql`UPDATE repo_records SET vals = vals - ${columnKey}::text WHERE account_id = 1 AND table_key = ${table}`;
    await sql`DELETE FROM repo_secrets WHERE account_id = 1 AND table_key = ${table} AND column_key = ${columnKey}`;
    await sql`UPDATE repo_files SET removed_at = now(), removed_by = ${who.email}
               WHERE account_id = 1 AND table_key = ${table} AND column_key = ${columnKey} AND removed_at IS NULL`;
    await sql`DELETE FROM repo_columns WHERE account_id = 1 AND table_key = ${table} AND key = ${columnKey}`;
    await sql`UPDATE repo_tables SET name_fields = array_remove(name_fields, ${columnKey})
               WHERE account_id = 1 AND key = ${table}`;
    await log(`deleted column ${col.title} (${col.type}); erased: ` +
              (col.type === 'secret' ? 'secrets, not recorded' : JSON.stringify(Object.fromEntries(erased.map(r => [r.id, r.v])))), table);
    return ok({ key: columnKey });
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
};

const ok = (data: unknown) => Response.json({ ok: true, data });
function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository', message }, { status });
}
