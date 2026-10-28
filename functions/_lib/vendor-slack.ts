/**
 * A handyman's Slack channel (owner, 2026-10-27), as a cleaner's (§134): one line when new work reaches them, and a
 * summary each morning of how many they have — nothing more. In English, the handyman @-mentioned (a channel such as
 * #handyman may hold the team too). Only for a handyman whose channel is set (Operations → Handymen → Slack channel).
 * The new-work line goes after the response: a Slack hiccup never fails the save that gave the work.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt, encrypt } from './crypto.ts';
import { newToken, sha256 } from './crew.ts';
import { slackApi, slackSetup, type SlackSetup } from './slack.ts';
import { daySummary, newWorkMessage, type HandymanJob } from '../../src/lib/vendor-slack.ts';

/** The handyman's own page link (/crew#v=…) — the same one every time, so one already sent keeps working; "fresh" replaces it. */
export async function vendorOwnLink(sql: SqlFn, encryptionKey: string, name: string, origin: string, fresh = false): Promise<string> {
  const [v] = await sql`SELECT link_token_enc FROM vendors WHERE account_id = 1 AND lower(name) = lower(${name})` as { link_token_enc: string | null }[];
  let token = fresh || !v?.link_token_enc ? null : await decrypt(v.link_token_enc, encryptionKey).catch(() => null);
  if (!token) {
    token = newToken();
    await sql`UPDATE vendors SET link_token_hash = ${await sha256(token)}, link_token_enc = ${await encrypt(token, encryptionKey)}, updated_at = now()
               WHERE account_id = 1 AND lower(name) = lower(${name})`;
  }
  return `${origin}/crew#v=${token}`;
}

const chanOf = (s: SlackSetup, vendor: string) => {
  const key = Object.keys(s.config.handymen ?? {}).find(k => k.toLowerCase() === vendor.trim().toLowerCase());
  return key ? { name: key, ...s.config.handymen![key]! } : null;
};
const originOf = (s: SlackSetup, fallback: string) => s.config.appUrl?.replace(/\/+$/, '') || fallback;

/** One line in the channel of the vendor these work orders now have: the job, or how many and where. */
export async function tellHandyman(sql: SqlFn, encryptionKey: string, ids: string[], origin: string) {
  try {
    if (!ids.length) return;
    const s = await slackSetup(sql, encryptionKey);
    if (!s.token) return;
    const rows = await sql`
      SELECT t.title, btrim(t.vendor) AS vendor, u.name AS unit, coalesce(t.scheduled_on, p.scheduled_on)::text AS day
        FROM todos t
        LEFT JOIN todos p ON p.account_id = t.account_id AND p.id = t.parent_id AND p.kind = 'work_order' AND p.deleted_at IS NULL
        LEFT JOIN units u ON u.account_id = t.account_id AND u.id = coalesce(t.unit_ids[1], p.unit_ids[1])
       WHERE t.account_id = 1 AND t.id = ANY(${ids.map(Number)}::bigint[]) AND t.kind = 'work_order' AND t.deleted_at IS NULL
         AND t.status NOT IN ('completed', 'cancelled') AND btrim(coalesce(t.vendor, '')) <> ''
       ORDER BY t.id` as (HandymanJob & { vendor: string })[];
    const byVendor = new Map<string, HandymanJob[]>();
    for (const r of rows) byVendor.set(r.vendor.toLowerCase(), [...(byVendor.get(r.vendor.toLowerCase()) ?? []), r]);
    for (const [vendor, js] of byVendor) {
      const ch = chanOf(s, vendor);
      if (!ch) continue;
      const m = newWorkMessage(js, await vendorOwnLink(sql, encryptionKey, ch.name, originOf(s, origin)), ch.slackUserId);
      if (m) await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, ...m, unfurl_links: false });
    }
  } catch { /* a courtesy: the work is saved and on their page */ }
}

/** Their open work, as their page lists it (vendor-door.ts `mine`, open only). */
const openJobs = (sql: SqlFn, vendor: string) => sql`
  SELECT t.title, u.name AS unit, coalesce(t.scheduled_on, p.scheduled_on)::text AS day FROM todos t
    LEFT JOIN todos p ON p.account_id = t.account_id AND p.id = t.parent_id AND p.kind = 'work_order' AND p.deleted_at IS NULL
    LEFT JOIN units u ON u.account_id = t.account_id AND u.id = coalesce(t.unit_ids[1], p.unit_ids[1])
   WHERE t.account_id = 1 AND t.deleted_at IS NULL AND t.kind = 'work_order' AND lower(btrim(t.vendor)) = lower(btrim(${vendor}))
     AND t.status NOT IN ('completed', 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM todos c WHERE c.account_id = t.account_id AND c.parent_id = t.id AND c.kind = 'work_order' AND c.deleted_at IS NULL)
   ORDER BY t.id` as Promise<HandymanJob[]>;

/** The morning summary to each handyman with a channel — once a day (slack_sent), none when they have nothing open. */
export async function handymenDay(sql: SqlFn, s: SlackSetup, encryptionKey: string, today: string, origin: string): Promise<string[]> {
  const sent: string[] = [];
  if (!s.token) return sent;
  for (const name of Object.keys(s.config.handymen ?? {})) {
    const ch = chanOf(s, name)!;
    const key = `handyday:${name.toLowerCase()}:${today}`;
    if (!(await sql`INSERT INTO slack_sent (account_id, key) VALUES (1, ${key}) ON CONFLICT DO NOTHING RETURNING key`).length) continue;
    const m = daySummary(await openJobs(sql, name), await vendorOwnLink(sql, encryptionKey, name, originOf(s, origin)), today, ch.slackUserId);
    if (!m) continue;
    const r = await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, ...m, unfurl_links: false });
    if (r.ok) sent.push(`handyman ${name}`); else await sql`DELETE FROM slack_sent WHERE account_id = 1 AND key = ${key}`;
  }
  return sent;
}

/**
 * Where the bot tells a handyman: a channel that exists (owner: Tim's is #handyman) — or, with no name, a private
 * #handyman-<name> made for them. The handyman (by their vendor email) and whoever sets it are invited.
 */
export async function handymanChannel(sql: SqlFn, encryptionKey: string, name: string, byEmail: string, channelName?: string | null) {
  const s = await slackSetup(sql, encryptionKey);
  if (!s.token) throw new Error('Slack is not connected (Settings → Slack).');
  const [v] = await sql`SELECT email FROM vendors WHERE account_id = 1 AND lower(name) = lower(${name})` as { email: string | null }[];
  const email = v?.email?.trim().toLowerCase() || null;
  const found = email ? await slackApi<{ user?: { id: string } }>(s.token, 'users.lookupByEmail', { email }) : null;
  const want = channelName?.trim().replace(/^#/, '').toLowerCase() || null;
  let ch: { channelId: string; channelName: string } | null = null;
  if (want) {
    const list = await slackApi<{ channels?: { id: string; name: string; is_member?: boolean }[] }>(s.token, 'conversations.list',
      { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true });
    const c = list.channels?.find(x => x.name === want);
    // A private channel the bot is not in does not even list: it has to be invited first.
    if (!c) throw new Error(`#${want} is not there, or Kaizen is not in it — in Slack: /invite @Kaizen in #${want}, then try again.`);
    if (!c.is_member) await slackApi(s.token, 'conversations.join', { channel: c.id });
    ch = { channelId: c.id, channelName: c.name };
  } else {
    ch = s.config.handymen?.[name] ?? null;
    if (!ch) {
      const slug = `handyman-${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 80);
      const made = await slackApi<{ channel?: { id: string; name: string } }>(s.token, 'conversations.create', { name: slug, is_private: true });
      if (!made.ok || !made.channel) throw new Error(made.error === 'name_taken' ? `#${slug} already exists — type its name to use it.` : `Slack said: ${made.error}`);
      ch = { channelId: made.channel.id, channelName: made.channel.name };
      // A private channel is seen only by its members (§136): whoever makes it joins it.
      const me = await slackApi<{ user?: { id: string } }>(s.token, 'users.lookupByEmail', { email: byEmail });
      if (me.ok && me.user?.id) await slackApi(s.token, 'conversations.invite', { channel: ch.channelId, users: me.user.id });
    }
  }
  if (found?.user?.id) await slackApi(s.token, 'conversations.invite', { channel: ch.channelId, users: found.user.id });
  const saved = { ...ch, email, slackUserId: found?.user?.id ?? null };
  await sql`UPDATE accounts SET slack_config = jsonb_set(coalesce(slack_config, '{}'::jsonb), '{handymen}',
              coalesce(slack_config->'handymen', '{}'::jsonb) || jsonb_build_object(${name}::text, ${JSON.stringify(saved)}::jsonb)) WHERE id = 1`;
  return { channel: saved.channelName, inSlack: !!found?.user?.id, email };
}
