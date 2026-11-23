/**
 * The Repository as the help assistant reads it — Ask Kaizen (/api/assistant) and "@Kaizen <question>" in Slack (owner, 2026-11-23:
 * "connect it as it works in the system") share it, so a Wi-Fi asked in Slack is found exactly as on the web. Secrets come back
 * as column keys only; their values go through repository-reveal (web) or the logged Slack reveal.
 */
import type { SqlFn } from './accounts.ts';
import { recName, type RepoRec } from '../../src/lib/assistant.ts';

export async function repoRecords(sql: SqlFn): Promise<RepoRec[]> {
  const [tables, columns, records, secrets] = await Promise.all([
    sql`SELECT key, title, name_fields FROM repo_tables WHERE account_id = 1 AND archived_at IS NULL` as Promise<{ key: string; title: string; name_fields: string[] | null }[]>,
    sql`SELECT table_key, key, title FROM repo_columns WHERE account_id = 1 ORDER BY table_key, position` as Promise<{ table_key: string; key: string; title: string }[]>,
    sql`SELECT table_key, id, vals FROM repo_records WHERE account_id = 1 AND archived_at IS NULL` as Promise<{ table_key: string; id: string; vals: Record<string, unknown> }[]>,
    sql`SELECT table_key, record_id, column_key FROM repo_secrets WHERE account_id = 1` as Promise<{ table_key: string; record_id: string; column_key: string }[]>,
  ]);
  const byTable = new Map(tables.map(t => [t.key, t]));
  return records.filter(r => byTable.has(r.table_key)).map(r => {
    const t = byTable.get(r.table_key)!;
    return { table: r.table_key, tableTitle: t.title, id: r.id, name: recName(r.vals ?? {}, t.name_fields, r.id), vals: r.vals ?? {},
      columns: columns.filter(c => c.table_key === r.table_key).map(c => ({ key: c.key, title: c.title })),
      secrets: secrets.filter(s => s.table_key === r.table_key && s.record_id === r.id).map(s => s.column_key) };
  });
}
