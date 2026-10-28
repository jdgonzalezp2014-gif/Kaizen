/**
 * A handyman's own Slack channel (owner, 2026-10-27), as a cleaner's (§134): the bot tells them of new work there —
 * "New work at <house>", the jobs, the day, and the link to their page. In English (the handymen's language so far).
 * Only to a handyman whose channel the team made (Operations → Handymen → Slack channel). After the response:
 * a Slack hiccup never fails the save that gave the work.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt, encrypt } from './crypto.ts';
import { newToken, sha256 } from './crew.ts';
import { slackApi, slackSetup } from './slack.ts';
import { dayLabel } from '../../src/lib/crew-i18n.ts';

/** The handyman's own page link (/crew#v=…) — the same one every time, so one already sent keeps working; "new" replaces it. */
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "New work" for these work orders, one message per house, in the channel of the vendor they now have. */
export async function tellHandyman(sql: SqlFn, encryptionKey: string, ids: string[], origin: string) {
  try {
    if (!ids.length) return;
    const s = await slackSetup(sql, encryptionKey);
    if (!s.token) return;
    const rows = await sql`
      SELECT t.id::text, t.title, btrim(t.vendor) AS vendor, u.name AS unit, coalesce(t.scheduled_on, p.scheduled_on)::text AS day
        FROM todos t
        LEFT JOIN todos p ON p.account_id = t.account_id AND p.id = t.parent_id AND p.kind = 'work_order' AND p.deleted_at IS NULL
        LEFT JOIN units u ON u.account_id = t.account_id AND u.id = coalesce(t.unit_ids[1], p.unit_ids[1])
       WHERE t.account_id = 1 AND t.id = ANY(${ids.map(Number)}::bigint[]) AND t.kind = 'work_order' AND t.deleted_at IS NULL
         AND t.status NOT IN ('completed', 'cancelled') AND btrim(coalesce(t.vendor, '')) <> ''
       ORDER BY t.id` as { id: string; title: string; vendor: string; unit: string | null; day: string | null }[];
    const byVendor = new Map<string, typeof rows>();
    for (const r of rows) byVendor.set(r.vendor, [...(byVendor.get(r.vendor) ?? []), r]);
    for (const [vendor, works] of byVendor) {
      const key = Object.keys(s.config.handymen ?? {}).find(k => k.toLowerCase() === vendor.toLowerCase());
      const ch = key ? s.config.handymen![key] : undefined;
      if (!ch) continue;
      const link = await vendorOwnLink(sql, encryptionKey, key!, s.config.appUrl?.replace(/\/+$/, '') || origin);
      const houses = new Map<string, typeof works>();
      for (const w of works) houses.set(w.unit ?? 'No listing', [...(houses.get(w.unit ?? 'No listing') ?? []), w]);
      for (const [house, ws] of houses) {
        const days = [...new Set(ws.map(w => w.day).filter((d): d is string => !!d))].sort();
        const head = `🔧 *New work at ${esc(house)}* — ${ws.length} job${ws.length === 1 ? '' : 's'}`;
        const body = [head, ...ws.map(w => `• ${esc(w.title)}`),
          days.length ? `📅 ${days.map(d => dayLabel('en', d)).join(', ')} — accept the day on your page` : '📅 No day set yet — the team will set it',
          `<${link}|Open your page ›>`].join('\n');
        await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, text: `New work at ${house}: ${ws.length} job${ws.length === 1 ? '' : 's'}`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } }], unfurl_links: false });
      }
    }
  } catch { /* a courtesy: the work is saved and on their page */ }
}

/** The handyman's private channel (#handyman-<name>), the handyman and whoever makes it invited — as a cleaner's. */
export async function handymanChannel(sql: SqlFn, encryptionKey: string, name: string, byEmail: string) {
  const s = await slackSetup(sql, encryptionKey);
  if (!s.token) throw new Error('Slack is not connected (Settings → Slack).');
  const [v] = await sql`SELECT email FROM vendors WHERE account_id = 1 AND lower(name) = lower(${name})` as { email: string | null }[];
  const email = v?.email?.trim().toLowerCase() || null;
  const found = email ? await slackApi<{ user?: { id: string } }>(s.token, 'users.lookupByEmail', { email }) : null;
  let ch = s.config.handymen?.[name];
  if (!ch) {
    const slug = `handyman-${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 80);
    const made = await slackApi<{ channel?: { id: string; name: string } }>(s.token, 'conversations.create', { name: slug, is_private: true });
    if (!made.ok || !made.channel) throw new Error(made.error === 'name_taken' ? `A channel named #${slug} already exists — rename or archive it in Slack.` : `Slack said: ${made.error}`);
    ch = { channelId: made.channel.id, channelName: made.channel.name };
  }
  if (found?.user?.id) await slackApi(s.token, 'conversations.invite', { channel: ch.channelId, users: found.user.id });
  // A private channel is seen only by its members (§136): whoever makes it joins it.
  const me = await slackApi<{ user?: { id: string } }>(s.token, 'users.lookupByEmail', { email: byEmail });
  if (me.ok && me.user?.id) await slackApi(s.token, 'conversations.invite', { channel: ch.channelId, users: me.user.id });
  const saved = { ...ch, email, slackUserId: found?.user?.id ?? ch.slackUserId ?? null };
  await sql`UPDATE accounts SET slack_config = jsonb_set(coalesce(slack_config, '{}'::jsonb), '{handymen}',
              coalesce(slack_config->'handymen', '{}'::jsonb) || jsonb_build_object(${name}::text, ${JSON.stringify(saved)}::jsonb)) WHERE id = 1`;
  return { channel: saved.channelName, inSlack: !!found?.user?.id, email };
}
