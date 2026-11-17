/**
 * /api/inbox-settings — how the Inbox behaves for this account (permission `messages.setup`):
 *   GET  → the message templates, the guest AI's settings, whether Kaizen really sends, the portal's address
 *   POST { action: template | removeTemplate | settings }
 * The AI names a provider and a model; the key is the account's own Claude / Gemini key (Settings → Integrations → AI).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { readGuestAi } from '../_lib/guest-ai.ts';
import { readWatch } from '../_lib/guest-events.ts';
import { hookSecret } from '../_lib/guest-link.ts';
import { guestLive, loadTemplates } from '../_lib/guest-outbox.ts';
import { watchFrom } from '../../src/lib/guest-watch.ts';
import { MAX_BODY, MAX_OFFSET_HOURS, ONLY_IF, TRIGGERS, guestAiFrom, isEvent, isModel, isPortalUrl, type Trigger } from '../../src/lib/inbox.ts';

const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
const needs116 = (e: unknown) => /guest_watch/i.test(String(e)) ? bad('The database needs migration 117 first (npm run migrate).', 409)
  : /message_templates|guest_ai|guest_messages_live|guest_portal_url|does not exist/i.test(String(e))
  ? bad('The database needs migration 116 first (npm run migrate).', 409) : bad(String(e), 500);

async function state(sql: SqlFn, env: Env, origin: string) {
  const [templates, ai, live, watch, hook, slack, seen, rows] = await Promise.all([
    loadTemplates(sql), readGuestAi(sql), guestLive(sql), readWatch(sql), hookSecret(env.ENCRYPTION_KEY),
    (sql`SELECT slack_config->'channels'->'escalations'->>'name' AS name FROM accounts WHERE id = 1` as Promise<{ name: string | null }[]>).catch(() => []),
    // Has Hostaway's webhook ever reached Kaizen? The newest event says so — null before migration 117 or before the first one.
    (sql`SELECT max(created_at) AS at FROM guest_events WHERE account_id = 1` as Promise<{ at: string | Date | null }[]>).catch(() => null),
    sql`SELECT claude_api_key_enc IS NOT NULL AS claude, gemini_api_key_enc IS NOT NULL AS gemini FROM accounts WHERE id = 1` as Promise<{ claude: boolean; gemini: boolean }[]>,
  ]);
  const portal = await (sql`SELECT guest_portal_url AS url FROM accounts WHERE id = 1` as Promise<{ url: string | null }[]>).then(r => ({ url: r[0]?.url ?? null, ready: true }), () => ({ url: null, ready: false }));
  return { ok: true, templates, ai, live, portalUrl: portal.url, migrated: portal.ready, hasClaudeKey: rows[0]?.claude === true, hasGeminiKey: rows[0]?.gemini === true,
    watch, watchChannel: slack[0]?.name ?? null, migrated117: seen !== null, lastEventAt: seen?.[0]?.at ? new Date(seen[0].at).toISOString() : null,
    // Shown only here, to whoever may set the Inbox up: the address Hostaway calls. Its secret is derived, never stored.
    hookUrl: `${origin}/api/slack-cron?job=guest-event&k=${hook}` };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  return Response.json(await state(db(env) as unknown as SqlFn, env, new URL(request.url).origin), { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!b) return bad('Nothing was sent.');
  try {
    if (b.action === 'template') {
      const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
      const body = typeof b.body === 'string' ? b.body.trim() : '';
      const trigger = (TRIGGERS.some(t => t[0] === b.trigger) ? String(b.trigger) : 'manual') as Trigger;
      const offset = Math.round(Number(b.offsetHours) || 0);
      if (!name) return bad('Give the template a name.');
      if (!body) return bad('Write the message.');
      if (body.length > MAX_BODY) return bad(`Too long — ${MAX_BODY} characters at most.`);
      if (offset < 0 || offset > MAX_OFFSET_HOURS) return bad('The time before or after is between 0 and 30 days.');
      const channel = b.channel === 'sms' ? 'sms' : 'hostaway';
      const active = b.active !== false;
      // Migration 117: which listings, a condition, and — for what goes when something happens — the earliest it may go.
      const listings = Array.isArray(b.listingIds) ? [...new Set(b.listingIds.map(String).filter(x => /^\d{1,20}$/.test(x)))].slice(0, 500) : [];
      const onlyIf = ONLY_IF.some(o => o[0] === b.onlyIf) ? String(b.onlyIf) : 'always';
      const hold = b.holdHours == null || b.holdHours === '' || !isEvent(trigger) ? null : Math.round(Number(b.holdHours));
      if (hold != null && (!Number.isFinite(hold) || hold < 0 || hold > MAX_OFFSET_HOURS)) return bad('"Not before" is between 0 and 30 days ahead of check-in.');
      const extra = listings.length > 0 || onlyIf !== 'always' || hold != null || trigger === 'checkin_done';
      let id = b.id ? String(b.id) : '';
      if (id) {
        const done = await sql`UPDATE message_templates SET name = ${name}, body = ${body}, channel = ${channel}, trigger = ${trigger},
                                      offset_hours = ${offset}, active = ${active}, updated_at = now()
                                WHERE account_id = 1 AND id = ${id} AND deleted_at IS NULL RETURNING id`;
        if (!done.length) return bad('That template is gone.', 404);
      } else {
        const [row] = await sql`INSERT INTO message_templates (account_id, name, body, channel, trigger, offset_hours, active, created_by)
                  VALUES (1, ${name}, ${body}, ${channel}, ${trigger}, ${offset}, ${extra ? false : active}, ${who.email}) RETURNING id::text AS id` as { id: string }[];
        id = row!.id;
      }
      // Its own statement, so the plain fields still save before migration 117. A new automation that NEEDS these is
      // created paused and only switched on once they are stored — it must never run as "all listings, always" by accident.
      try {
        await sql`UPDATE message_templates SET listing_ids = ${listings.length ? listings : null}, only_if = ${onlyIf}, hold_hours = ${hold},
                         active = ${active} WHERE account_id = 1 AND id = ${id}`;
      } catch (e) {
        if (extra) return bad(`Saved without its listings / condition, and paused: the database needs migration 117 first (npm run migrate). ${String(e).slice(0, 80)}`, 409);
      }
    } else if (b.action === 'removeTemplate') {
      await sql`UPDATE message_templates SET deleted_at = now() WHERE account_id = 1 AND id = ${String(b.id ?? '')} AND deleted_at IS NULL`;
    } else if (b.action === 'settings') {
      if (b.ai !== undefined) {
        const raw = (b.ai && typeof b.ai === 'object' ? b.ai : {}) as Record<string, unknown>;
        if (typeof raw.model === 'string' && raw.model.trim() && !isModel(raw.model.trim())) return bad('That does not look like a model id (e.g. claude-opus-5-5).');
        await sql`UPDATE accounts SET guest_ai = ${JSON.stringify(guestAiFrom(raw))}::jsonb WHERE id = 1`;
      }
      if (typeof b.live === 'boolean') await sql`UPDATE accounts SET guest_messages_live = ${b.live} WHERE id = 1`;
      if (b.watch !== undefined) await sql`UPDATE accounts SET guest_watch = ${JSON.stringify(watchFrom(b.watch))}::jsonb WHERE id = 1`;
      if (typeof b.portalUrl === 'string') {
        const url = b.portalUrl.trim().replace(/\/+$/, '');
        if (!isPortalUrl(url)) return bad('The portal address starts with https:// — e.g. https://stay.yourcompany.com');
        await sql`UPDATE accounts SET guest_portal_url = ${url || null} WHERE id = 1`;
      }
    } else return bad('Unknown action.');
  } catch (e) { return needs116(e); }
  return Response.json(await state(sql, env, new URL(request.url).origin), { headers: { 'Cache-Control': 'no-store' } });
};
