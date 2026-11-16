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
      const call = (job = '') => fetch(`${env.KAIZEN_URL}/api/slack-cron${job}`, { method: 'POST', headers: { 'X-Kaizen-Ingest': env.KAIZEN_INGEST_TOKEN } });
      // Two calls, each with its own budget: Slack's messages, then the guests' scheduled messages (Guest Services →
      // Inbox, 2026-11-16). One failing never stops the other; either failing marks the run failed.
      const [slack, guests] = await Promise.allSettled([call(), call('?job=messages')]);
      const failed: string[] = [];
      for (const [name, r] of [['slack-cron', slack], ['guest messages', guests]] as const) {
        if (r.status === 'rejected') { failed.push(`${name}: ${String(r.reason)}`); continue; }
        // Seen in `wrangler tail` and the Worker's logs; a failure throws so Cloudflare marks the run failed.
        console.log(name, r.value.status, (await r.value.text()).slice(0, 300));
        if (!r.value.ok) failed.push(`${name} answered ${r.value.status}`);
      }
      if (failed.length) throw new Error(failed.join(' · '));
    })());
  }
};
