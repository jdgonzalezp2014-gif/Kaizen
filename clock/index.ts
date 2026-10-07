/**
 * kaizen-clock — the Slack messages' clock (docs/modules/slack.md).
 *
 * GitHub's scheduled workflows ran every 5–6 hours instead of hourly, so the
 * 8 AM message went out at 12:19 PM and a check-out never went. A Cloudflare
 * cron trigger fires on the minute. Every 5 minutes it asks Kaizen to send
 * whatever is due; Kaizen records each send (`slack_sent`), so the calls in
 * between send nothing.
 */
interface Env { KAIZEN_URL: string; KAIZEN_INGEST_TOKEN: string }

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const r = await fetch(`${env.KAIZEN_URL}/api/slack-cron`, { method: 'POST', headers: { 'X-Kaizen-Ingest': env.KAIZEN_INGEST_TOKEN } });
      const body = await r.text();
      // Seen in `wrangler tail` and the Worker's logs; a failure throws so Cloudflare marks the run failed.
      console.log(r.status, body.slice(0, 300));
      if (!r.ok) throw new Error(`slack-cron answered ${r.status}`);
    })());
  }
};
