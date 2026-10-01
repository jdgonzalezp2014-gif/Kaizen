/**
 * POST /api/slack-cron — the reservations reminder on a clock (§99).
 *
 * Called hourly by the scheduler (.github/workflows/slack-cron.yml) with
 * the ingest token, or by a signed-in admin. Sends each reminder (morning,
 * afternoon) once a day, at or after its New York hour: the hour is the
 * earliest it goes, and `slack_sent` makes a second run that day silent.
 * Outside Cloudflare Access (SELF_AUTHENTICATING) — the token is the check.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify } from '../_lib/auth.ts';
import { decrypt } from '../_lib/crypto.ts';
import { can } from '../_lib/roles.ts';
import { postTo, slackSetup } from '../_lib/slack.ts';
import { digestFacts } from '../_lib/slack-digest.ts';
import { digestMessage, dueDigests } from '../../src/lib/slack.ts';
import { todayIn } from '../../src/lib/dates.ts';

const TZ = 'America/New_York';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const who = identify(request, env);
  if (who) {
    if (!can((await accessOf(sql, who)).permissions, 'settings')) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  } else {
    const [a] = await sql`SELECT ingest_token_enc FROM accounts WHERE id = 1` as { ingest_token_enc: string | null }[];
    const expected = a?.ingest_token_enc ? await decrypt(a.ingest_token_enc, env.ENCRYPTION_KEY) : null;
    if (!expected || (request.headers.get('X-Kaizen-Ingest') ?? '') !== expected) {
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 403 });
    }
  }
  const s = await slackSetup(sql, env.ENCRYPTION_KEY);
  if (!s.token || !s.config.channels?.reservations) return Response.json({ ok: true, sent: [], skipped: 'slack not set up' });

  const today = todayIn(TZ);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const sent = new Set((await sql`SELECT key FROM slack_sent WHERE account_id = 1 AND key LIKE ${`digest:%:${today}`}` as { key: string }[]).map(r => r.key));
  const due = dueDigests(hour, today, s.config, sent);
  if (!due.length) return Response.json({ ok: true, sent: [], hour });

  const facts = await digestFacts(sql, await getCredentials(sql, env.ENCRYPTION_KEY), env.ENCRYPTION_KEY);
  const out: string[] = [];
  for (const kind of due) {
    // Claimed first: two runs at once never send it twice.
    const claimed = await sql`INSERT INTO slack_sent (account_id, key) VALUES (1, ${`digest:${kind}:${today}`}) ON CONFLICT DO NOTHING RETURNING key`;
    if (!claimed.length) continue;
    const r = await postTo(s, 'reservations', digestMessage(facts, kind, s.config.appUrl));
    if (!r?.ok) await sql`DELETE FROM slack_sent WHERE account_id = 1 AND key = ${`digest:${kind}:${today}`}`;
    else out.push(kind);
  }
  return Response.json({ ok: true, sent: out, hour });
};
