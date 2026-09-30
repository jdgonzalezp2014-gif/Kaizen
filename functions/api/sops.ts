/**
 * /api/sops — the SOP library (§92).
 *
 *   GET                      sections, and every SOP the reader may see
 *                            (drafts only for `sops.edit`)
 *   GET ?versions=<id>       what an SOP said, version by version
 *   POST { action: 'save', … }            create, or update — a new version
 *                                          only when what it SAYS changed
 *   POST { action: 'review', id }          "still right": restarts the review clock
 *   POST { action: 'delete' | 'restore', id }
 *   POST { action: 'section', key?, label, description }   add or rename a section
 *   POST { action: 'sectionRemove', key }  only an empty section
 *
 * Reading is its own permission (`sops`), writing another (`sops.edit`);
 * the middleware enforces GET vs POST, and drafts are filtered here.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { can } from '../_lib/roles.ts';
import { cleanSteps, contentChanged, FEATURE_KEYS, type Sop, type SopContent } from '../../src/lib/sops.ts';

const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toSop = (r: any): Sop => ({
  id: String(r.id), sectionKey: r.section_key, kind: r.kind, title: r.title, status: r.status,
  purpose: r.purpose, trigger: r.trigger, owner: r.owner, doneWhen: r.done_when,
  steps: Array.isArray(r.steps) ? r.steps : [], body: r.body, features: r.features ?? [],
  reviewDays: r.review_days, reviewedAt: iso(r.reviewed_at), reviewedBy: r.reviewed_by, version: r.version,
  createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedBy: r.updated_by, updatedAt: iso(r.updated_at)!
});
const contentOf = (s: SopContent): SopContent => ({
  title: s.title, kind: s.kind, purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen,
  steps: s.steps, body: s.body
});

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const access = await accessOf(sql as unknown as SqlFn, who);
  const canEdit = can(access.permissions, 'sops.edit');

  const versions = new URL(request.url).searchParams.get('versions');
  if (versions) {
    const rows = await sql`SELECT v.version, v.snapshot, v.note, v.edited_by, v.edited_at
                             FROM sop_versions v JOIN sops s ON s.id = v.sop_id
                            WHERE v.account_id = 1 AND v.sop_id::text = ${versions} AND s.deleted_at IS NULL
                              AND (${canEdit} OR s.status <> 'draft')
                            ORDER BY v.version DESC LIMIT 100`;
    return Response.json({ ok: true, versions: rows.map((r: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      version: r.version, snapshot: r.snapshot, note: r.note, editedBy: r.edited_by, editedAt: iso(r.edited_at) })) });
  }

  const [sections, sops] = await Promise.all([
    sql`SELECT key, label, description, sort FROM sop_sections WHERE account_id = 1 AND deleted_at IS NULL ORDER BY sort, label`,
    sql`SELECT * FROM sops WHERE account_id = 1 AND deleted_at IS NULL AND (${canEdit} OR status <> 'draft')
         ORDER BY section_key, (status = 'archived'), title`
  ]);
  return Response.json({ ok: true, canEdit, sections, sops: sops.map(toSop) });
};

interface Body {
  action?: string; id?: string; note?: string;
  sectionKey?: string; kind?: string; title?: string; status?: string;
  purpose?: string | null; trigger?: string | null; owner?: string | null; doneWhen?: string | null;
  steps?: unknown; body?: string | null; features?: unknown; reviewDays?: number;
  key?: string; label?: string; description?: string | null;
}
const bad = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
const text = (v: unknown, max: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const b = await request.json().catch(() => ({})) as Body;
  const id = String(b.id ?? '');

  if (b.action === 'section') {
    const label = text(b.label, 80);
    if (!label) return bad('A section needs a name.');
    const description = text(b.description, 300);
    if (b.key) {
      const rows = await sql`UPDATE sop_sections SET label = ${label}, description = ${description}
                              WHERE account_id = 1 AND key = ${b.key} AND deleted_at IS NULL RETURNING key`;
      return rows.length ? Response.json({ ok: true, key: b.key }) : bad('No such section.', 404);
    }
    const base = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34) || 'section';
    const taken = new Set((await sql`SELECT key FROM sop_sections WHERE account_id = 1`).map((r: any) => r.key)); // eslint-disable-line @typescript-eslint/no-explicit-any
    let key = base.length < 2 ? `${base}-s` : base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    await sql`INSERT INTO sop_sections (account_id, key, label, description, sort, created_by)
              VALUES (1, ${key}, ${label}, ${description},
                      (SELECT COALESCE(max(sort), 0) + 10 FROM sop_sections WHERE account_id = 1), ${who.email})`;
    return Response.json({ ok: true, key });
  }

  if (b.action === 'sectionRemove') {
    const n = (await sql`SELECT count(*)::int AS n FROM sops WHERE account_id = 1 AND section_key = ${String(b.key ?? '')} AND deleted_at IS NULL` as { n: number }[])[0]?.n ?? 0;
    if (n) return bad(`Move or remove its ${n} SOP${n === 1 ? '' : 's'} first.`, 409);
    await sql`UPDATE sop_sections SET deleted_at = now() WHERE account_id = 1 AND key = ${String(b.key ?? '')}`;
    return Response.json({ ok: true });
  }

  if (b.action === 'review') {
    const rows = await sql`UPDATE sops SET reviewed_at = now(), reviewed_by = ${who.email}
                            WHERE account_id = 1 AND id::text = ${id} AND status = 'published' AND deleted_at IS NULL RETURNING *`;
    return rows.length ? Response.json({ ok: true, sop: toSop(rows[0]) }) : bad('Only a published SOP is reviewed.', 409);
  }

  if (b.action === 'delete' || b.action === 'restore') {
    const rows = b.action === 'delete'
      ? await sql`UPDATE sops SET deleted_at = now(), deleted_by = ${who.email}
                   WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL RETURNING id`
      : await sql`UPDATE sops SET deleted_at = NULL, deleted_by = NULL
                   WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NOT NULL RETURNING id`;
    return rows.length ? Response.json({ ok: true }) : bad('Nothing to change.', 404);
  }

  if (b.action !== 'save') return bad('Unknown action.');

  // ── save ──
  const title = text(b.title, 160);
  if (!title) return bad('An SOP needs a title.');
  const kind = b.kind === 'article' ? 'article' : 'sop';
  const status = ['draft', 'published', 'archived'].includes(String(b.status)) ? String(b.status) : 'draft';
  const sectionKey = String(b.sectionKey ?? '');
  const [section] = await sql`SELECT key FROM sop_sections WHERE account_id = 1 AND key = ${sectionKey} AND deleted_at IS NULL`;
  if (!section) return bad('Pick a section.');
  const features = [...new Set((Array.isArray(b.features) ? b.features : []).map(String))].filter(f => FEATURE_KEYS.has(f));
  const reviewDays = Math.min(1095, Math.max(7, Math.round(Number(b.reviewDays) || 180)));
  const content: SopContent = {
    title, kind, purpose: text(b.purpose, 2000), trigger: text(b.trigger, 1000), owner: text(b.owner, 120),
    doneWhen: text(b.doneWhen, 1000), steps: kind === 'sop' ? cleanSteps(b.steps) : [], body: text(b.body, 50000)
  };
  if (kind === 'sop' && !content.steps.length && status === 'published') return bad('A published SOP needs at least one step.');
  const note = text(b.note, 300);
  const steps = JSON.stringify(content.steps);

  if (!id) {
    const [row] = await sql`
      INSERT INTO sops (account_id, section_key, kind, title, status, purpose, trigger, owner, done_when, steps, body,
                        features, review_days, reviewed_at, reviewed_by, created_by, updated_by)
      VALUES (1, ${sectionKey}, ${kind}, ${title}, ${status}, ${content.purpose}, ${content.trigger}, ${content.owner},
              ${content.doneWhen}, ${steps}::jsonb, ${content.body}, ${features}::text[], ${reviewDays},
              ${status === 'published' ? new Date().toISOString() : null}, ${status === 'published' ? who.email : null},
              ${who.email}, ${who.email})
      RETURNING *`;
    if (!row) return bad('Not saved.', 500);
    await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
              VALUES (1, ${row.id}, 1, ${JSON.stringify(content)}::jsonb, ${note ?? 'Created'}, ${who.email})`;
    return Response.json({ ok: true, sop: toSop(row) });
  }

  const [cur] = await sql`SELECT * FROM sops WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL`;
  if (!cur) return bad('No such SOP.', 404);
  const before = toSop(cur);
  const changed = contentChanged(contentOf(before), content);
  const version = changed ? before.version + 1 : before.version;
  // Whoever edits a published SOP, or publishes it, has just reviewed it.
  const reviewed = status === 'published' && (changed || before.status !== 'published');
  const [row] = await sql`
    UPDATE sops SET section_key = ${sectionKey}, kind = ${kind}, title = ${title}, status = ${status},
                    purpose = ${content.purpose}, trigger = ${content.trigger}, owner = ${content.owner},
                    done_when = ${content.doneWhen}, steps = ${steps}::jsonb, body = ${content.body},
                    features = ${features}::text[], review_days = ${reviewDays}, version = ${version},
                    reviewed_at = CASE WHEN ${reviewed} THEN now() ELSE reviewed_at END,
                    reviewed_by = CASE WHEN ${reviewed} THEN ${who.email} ELSE reviewed_by END,
                    updated_by = ${who.email}, updated_at = now()
     WHERE account_id = 1 AND id = ${cur.id}
     RETURNING *`;
  if (changed) {
    await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
              VALUES (1, ${cur.id}, ${version}, ${JSON.stringify(content)}::jsonb, ${note}, ${who.email})`;
  }
  return Response.json({ ok: true, sop: toSop(row), newVersion: changed });
};
