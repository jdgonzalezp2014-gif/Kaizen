/**
 * The Data Repository, through its own JSON API.
 *
 * The repository is an Apps Script engine over one Google Sheet (its
 * database) and one Drive folder (its files). Kaizen OS is the screen and
 * the access control in front of it (§66): records are read and edited
 * here, documents uploaded here, and the engine still does what makes a
 * write safe — validation, row folders, encryption of secrets.
 *
 * The allow-lists below are the whole surface, one per permission; an
 * action not on them is refused before any request leaves. Left out on
 * purpose: sections.delete (archives every table in it at once), hard
 * row deletes, users.* (access is Kaizen's roles now) and import.*.
 *
 * columns.delete IS here, as the repository's own app offered it, but it
 * erases that column's values from the sheet — the route demands the
 * column's name typed back, and the sheet's version history is the undo.
 */

export const READ = new Set(['meta', 'list', 'get', 'docs.list', 'docs.batch', 'reveal']);
export const EDIT = new Set(['create', 'update', 'delete', 'docs.upload', 'docs.create', 'docs.rename', 'docs.delete']);
export const STRUCTURE = new Set(['sections.create', 'sections.rename', 'tables.create', 'tables.rename',
                                  'tables.delete', 'columns.add', 'columns.update', 'columns.move',
                                  'columns.reorder', 'columns.delete']);
const ALLOWED = new Set([...READ, ...EDIT, ...STRUCTURE]);

/** What the API returns in place of a secret. Writing it back would encrypt the mask. */
export const SECRET_MASK = '••••••••';

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

  // The deployment exists but only for signed-in visitors, and Kaizen is
  // not a Google account. A GET is redirected to Google's sign-in page; a
  // POST gets a 401 with an HTML "page not found". The one cause worth
  // naming exactly, because it is a setting, not a bug.
  if (res.status === 401 || res.status === 403 || /accounts\.google\.com/.test(res.url)) {
    throw new RepoError('The repository asked for a Google sign-in. In its Apps Script editor: Deploy → ' +
      'Manage deployments → the API deployment → ✏️ → Who has access: "Anyone" (not "Anyone with ' +
      'Google account") → Version: New version → Deploy. The link stays the same.');
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
