/**
 * /api/slack-settings — Slack, set up from Kaizen (§99). `settings` only.
 *
 *   GET                                      what is set (never the secrets)
 *   POST { action: 'save', botToken?, signingSecret?, config? }
 *   POST { action: 'test' }                  who the bot is, in which workspace
 *   POST { action: 'channels' }              the channels the bot can see
 *   POST { action: 'sendTest', topic }       a hello in a topic's channel
 *   POST { action: 'digestNow', kind }       the reservations reminder, now
 *   POST { action: 'cleanerChannel', name, email }   a private channel for a cleaner, with them in it
 *   POST { action: 'cleanerPreview' | 'cleanerSend', name }   their next cleans — shown, or sent by hand
 *   POST { action: 'people' }               Hostaway users, Slack people, the links and suggestions (§100)
 *
 * The bot token and signing secret are written only when typed (a masked
 * value is never written back) and encrypted like every credential here.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { encrypt } from '../_lib/crypto.ts';
import { postTo, slackApi, slackSetup } from '../_lib/slack.ts';
import { cleanerSchedule, digestFacts } from '../_lib/slack-digest.ts';
import { cleanerMessage, digestMessage, helpUrlOf, suggestPeople, TOPICS, type SlackConfig, type Topic } from '../../src/lib/slack.ts';

const bad = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const s = await slackSetup(sql, env.ENCRYPTION_KEY);
  return Response.json({ ok: true, hasToken: !!s.token, hasSecret: !!s.secret, config: s.config });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const s = await slackSetup(sql, env.ENCRYPTION_KEY);
  const saveConfig = async (c: SlackConfig) => { await sql`UPDATE accounts SET slack_config = ${JSON.stringify(c)}::jsonb WHERE id = 1`; };

  if (b.action === 'save') {
    if (typeof b.botToken === 'string' && b.botToken.trim()) {
      if (!/^xoxb-/.test(b.botToken.trim())) return bad('The bot token starts with xoxb- (Slack → your app → OAuth & Permissions).');
      await sql`UPDATE accounts SET slack_bot_token_enc = ${await encrypt(b.botToken.trim(), env.ENCRYPTION_KEY)} WHERE id = 1`;
    }
    if (typeof b.signingSecret === 'string' && b.signingSecret.trim()) {
      if (!/^[0-9a-f]{32}$/i.test(b.signingSecret.trim())) return bad('The signing secret is 32 letters and digits (Slack → your app → Basic Information).');
      await sql`UPDATE accounts SET slack_signing_secret_enc = ${await encrypt(b.signingSecret.trim(), env.ENCRYPTION_KEY)} WHERE id = 1`;
    }
    if (b.config && typeof b.config === 'object') {
      const c = b.config as SlackConfig;
      const channels: SlackConfig['channels'] = {};
      for (const t of TOPICS) {
        const ch = c.channels?.[t.key];
        if (ch?.id && /^[CG][A-Z0-9]+$/.test(ch.id)) channels[t.key] = { id: ch.id, name: String(ch.name ?? '').slice(0, 80) };
      }
      const hour = (v: unknown) => v === null || v === '' ? null : Math.min(23, Math.max(0, Math.round(Number(v)))) ;
      await saveConfig({ ...s.config, channels,
        events: Object.fromEntries(Object.entries(c.events ?? {}).map(([k, v]) => [k, !!v])),
        digest: { morning: hour(c.digest?.morning ?? 8), afternoon: hour(c.digest?.afternoon ?? 15) },
        appUrl: typeof c.appUrl === 'string' && /^https:\/\//.test(c.appUrl) ? c.appUrl.replace(/\/+$/, '') : s.config.appUrl,
        // §100: who is who, and whether people get direct messages yet.
        people: c.people && typeof c.people === 'object'
          ? Object.fromEntries(Object.entries(c.people).filter(([h, u]) => /^\d+$/.test(h) && /^[UW][A-Z0-9]+$/.test(String(u))).map(([h, u]) => [h, String(u)]))
          : s.config.people,
        dm: c.dm && ['off', 'test', 'on'].includes(c.dm.mode)
          ? { mode: c.dm.mode, testUser: c.dm.mode === 'test' ? (c.dm.testUser && /^[UW][A-Z0-9]+$/.test(c.dm.testUser) ? c.dm.testUser : await tester(s.token, who.email) ?? s.config.dm?.testUser ?? null) : null }
          : s.config.dm });
    }
    const n = await slackSetup(sql, env.ENCRYPTION_KEY);
    return Response.json({ ok: true, hasToken: !!n.token, hasSecret: !!n.secret, config: n.config });
  }

  if (!s.token) return bad('Add the bot token first.', 409);

  if (b.action === 'test') {
    const r = await slackApi<{ team?: string; user?: string; bot_id?: string; url?: string }>(s.token, 'auth.test');
    if (!r.ok) return bad(`Slack said: ${r.error}`);
    await saveConfig({ ...s.config, team: r.team });
    return Response.json({ ok: true, team: r.team, bot: r.user, url: r.url });
  }

  if (b.action === 'channels') {
    const out: { id: string; name: string; private: boolean; member: boolean }[] = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const r = await slackApi<{ channels?: { id: string; name: string; is_private: boolean; is_member: boolean }[]; response_metadata?: { next_cursor?: string } }>(
        s.token, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!r.ok) return bad(`Slack said: ${r.error}`);
      out.push(...(r.channels ?? []).map(c => ({ id: c.id, name: c.name, private: c.is_private, member: c.is_member })));
      cursor = r.response_metadata?.next_cursor ?? '';
      if (!cursor) break;
    }
    return Response.json({ ok: true, channels: out.sort((x, y) => x.name.localeCompare(y.name)) });
  }

  if (b.action === 'people') {
    const hostaway = await sql`SELECT id, name, email FROM hostaway_users WHERE account_id = 1 ORDER BY name` as { id: number; name: string; email: string | null }[];
    const r = await slackApi<{ members?: { id: string; name: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string; real_name?: string } }[] }>(
      s.token, 'users.list', { limit: 500 });
    if (!r.ok) return bad(`Slack said: ${r.error}`);
    const slack = (r.members ?? []).filter(m => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT')
      .map(m => ({ id: m.id, name: m.profile?.real_name || m.real_name || m.name, email: m.profile?.email ?? null }));
    return Response.json({ ok: true, hostaway, slack, links: s.config.people ?? {}, suggested: suggestPeople(hostaway, slack), dm: s.config.dm ?? { mode: 'test' } });
  }

  if (b.action === 'sendTest') {
    const topic = String(b.topic) as Topic;
    if (!s.config.channels?.[topic]) return bad('Pick a channel for it first.');
    const r = await postTo(s, topic, { text: 'Kaizen OS is connected ✓', blocks: [{ type: 'section', text: { type: 'mrkdwn',
      text: `✓ *Kaizen OS is connected.* This channel gets *${TOPICS.find(t => t.key === topic)?.label}*.` } }] });
    return r?.ok ? Response.json({ ok: true }) : bad(r?.error === 'not_in_channel' ? 'The bot is not in that private channel — type /invite @Kaizen there.' : `Slack said: ${r?.error ?? 'no channel'}`);
  }

  if (b.action === 'digestNow') {
    if (!s.config.channels?.reservations) return bad('Pick a channel for Reservations first.');
    const m = digestMessage(await digestFacts(sql, await getCredentials(sql, env.ENCRYPTION_KEY), env.ENCRYPTION_KEY),
                            b.kind === 'afternoon' ? 'afternoon' : 'morning', s.config.appUrl, helpUrlOf(s.config));
    const r = await postTo(s, 'reservations', m);
    return r?.ok ? Response.json({ ok: true, missing: m.missing }) : bad(`Slack said: ${r?.error}`);
  }

  // ── cleaners' channels: prepared — nothing is sent on a clock ──
  const name = String(b.name ?? '').trim();
  if (b.action === 'cleanerChannel') {
    if (!name) return bad('Which cleaner?');
    const email = String(b.email ?? '').trim().toLowerCase();
    const found = email ? await slackApi<{ user?: { id: string } }>(s.token, 'users.lookupByEmail', { email }) : null;
    if (email && !found?.ok) return bad(found?.error === 'users_not_found' ? `${email} is not in your Slack workspace yet — invite them to Slack first.` : `Slack said: ${found?.error}`);
    const slug = `cleaning-${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 80);
    let ch = s.config.cleaners?.[name];
    if (!ch) {
      const made = await slackApi<{ channel?: { id: string; name: string } }>(s.token, 'conversations.create', { name: slug, is_private: true });
      if (!made.ok && made.error !== 'name_taken') return bad(`Slack said: ${made.error}`);
      if (made.ok && made.channel) ch = { channelId: made.channel.id, channelName: made.channel.name };
      else return bad(`A channel named #${slug} already exists — rename or archive it in Slack, or pick another name.`);
    }
    if (found?.user?.id) {
      const inv = await slackApi(s.token, 'conversations.invite', { channel: ch.channelId, users: found.user.id });
      if (!inv.ok && inv.error !== 'already_in_channel') return bad(`Channel ready, but the invite failed: ${inv.error}`);
    }
    await saveConfig({ ...s.config, cleaners: { ...(s.config.cleaners ?? {}), [name]: { ...ch, email: email || ch.email || null, slackUserId: found?.user?.id ?? ch.slackUserId ?? null } } });
    return Response.json({ ok: true, channel: ch });
  }
  if (b.action === 'cleanerPreview' || b.action === 'cleanerSend') {
    const ch = s.config.cleaners?.[name];
    const m = cleanerMessage(name, await cleanerSchedule(sql, await getCredentials(sql, env.ENCRYPTION_KEY), name));
    if (b.action === 'cleanerPreview') return Response.json({ ok: true, message: m });
    if (!ch) return bad('Create the cleaner’s channel first.');
    const r = await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, text: m.text, blocks: m.blocks });
    return r.ok ? Response.json({ ok: true }) : bad(`Slack said: ${r.error}`);
  }

  return bad('Unknown action.');
};

/** Test mode's stand-in: the Slack account of whoever turns it on. */
async function tester(token: string | null, email: string): Promise<string | null> {
  if (!token || !email.includes('@')) return null;
  const r = await slackApi<{ user?: { id: string } }>(token, 'users.lookupByEmail', { email });
  return r.ok ? r.user?.id ?? null : null;
}
