/**
 * The Data Repository, through its own JSON API.
 *
 * The repository is an Apps Script app over one Google Sheet and one
 * Drive folder. It already has a key-protected API deployment that runs
 * as its owner; this is a client for it, and nothing more. The data stays
 * where it is maintained — a copy in Postgres would be a second version
 * of every login and every unit record, stale from the first edit.
 *
 * Deliberately READ-ONLY from here, with one exception: revealing a
 * secret, which is a read that is logged. Structure, imports, edits and
 * access stay in the repository's own app, which has the validation,
 * the Drive folders and the audit stamps that make those safe. The
 * allow-list below is the whole surface; an action not on it is refused
 * before any request leaves.
 */

const ALLOWED = new Set(['meta', 'list', 'get', 'docs.list', 'reveal']);

export class RepoError extends Error {}

/**
 * One API call.
 *
 * POST with a JSON body, because a GET puts the key in a URL, and URLs
 * end up in logs. Apps Script answers a web-app POST with a 302 to a
 * one-time googleusercontent URL; `fetch` follows it as a GET, which is
 * exactly what that URL expects.
 */
export async function repoCall<T>(
  creds: { url: string; key: string }, action: string, params: Record<string, unknown> = {}
): Promise<T> {
  if (!ALLOWED.has(action)) throw new RepoError(`"${action}" is not available from Kaizen OS.`);

  let res: Response;
  try {
    res = await fetch(creds.url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...params, action, key: creds.key })
    });
  } catch (e) {
    throw new RepoError(`The repository did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  // A deployment that is not public, or a URL for the wrong deployment,
  // answers with Google's sign-in page — a 200 with HTML. Parsing that as
  // "no records" would be the worst reading of it.
  if (/^\s*</.test(text)) {
    throw new RepoError('The repository answered with a web page, not data. Check that the URL is ' +
      'the API deployment (Execute as: Me, access: Anyone) and ends in /exec.');
  }
  let body: { ok?: boolean; data?: T; error?: string };
  try { body = JSON.parse(text); } catch {
    throw new RepoError(`The repository answered HTTP ${res.status} with something that is not JSON.`);
  }
  if (!body.ok) throw new RepoError(body.error || 'The repository refused the request.');
  return body.data as T;
}

/* ── shapes, as the repository's API returns them ─────────────────── */

export interface RepoColumn {
  key: string; title: string; type: string; group: string;
  required: boolean; unique: boolean; options: string[] | null;
  reference: { table: string; column: string } | null;
  editable: boolean; system: boolean;
}
export interface RepoTable {
  key: string; title: string; section: string; idPrefix: string;
  nameFields: string[]; columns: RepoColumn[];
}
export interface RepoSection { key: string; title: string; tables: RepoTable[] }
export interface RepoMeta { sections: RepoSection[] }
export type RepoRow = Record<string, string | number | boolean>;
export interface RepoFile {
  fileId: string; name: string; mimeType: string; size: number;
  url: string; updatedAt: string;
}

/** What the browser needs of the structure, and nothing it does not. */
export function trimMeta(meta: RepoMeta): RepoMeta {
  return {
    sections: (meta.sections ?? []).map(s => ({
      key: s.key, title: s.title,
      tables: (s.tables ?? []).map(t => ({
        key: t.key, title: t.title, section: t.section, idPrefix: t.idPrefix,
        nameFields: t.nameFields ?? [],
        columns: (t.columns ?? []).map(c => ({
          key: c.key, title: c.title, type: c.type, group: c.group,
          required: c.required, unique: c.unique, options: c.options,
          reference: c.reference, editable: c.editable, system: c.system
        }))
      }))
    }))
  };
}

/**
 * Case-insensitive match across every value of every row.
 *
 * Secrets are masked before they get here — the API returns `••••••••` —
 * so a search can never match on a password, which is the point.
 */
export function searchRows(rows: RepoRow[], q: string): RepoRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(needle)));
}
