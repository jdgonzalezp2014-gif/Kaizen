# Module: slack

The Slack bot: daily messages, notifications, pop-ups for every section, @Kaizen, comments
both ways. Settings → Slack (`SlackPanel.tsx`). SOP id 8 "Kaizen in Slack" is its user guide
(also `/kaizen help`) — update it when behaviour changes.

## Files

- Pure: `src/lib/slack.ts` (all messages, modals, cards, parsers, clocks; tests in `slack.test.ts`).
- Server: `functions/_lib/slack.ts` (slackApi, verifySlack, postTo, notifyTask/Claim,
  tellOwner, rememberThread, commentToThread), `slack-digest.ts` (digestFacts, cleansFor),
  `slack-taskcheck.ts`.
- API: `functions/api/slack.ts` (events, commands, actions, shortcuts, submits; class `Kaizen`
  runs the app's own handlers as the member), `slack-cron.ts` (the clock), `slack-settings.ts`.
- `src/components/SlackPanel.tsx` (manifest, channels, events, hours, people, cleaner channels).
- The clock: **`clock/`** — Cloudflare Worker `kaizen-clock` (cron `*/5 * * * *` → POST
  `/api/slack-cron` with secret `KAIZEN_INGEST_TOKEN`); deploy `cd clock && npx wrangler deploy`,
  logs `cd clock && npx wrangler tail kaizen-clock --format json`. `.github/workflows/slack-cron.yml`
  stays as a backup (GitHub's schedule ran every 5–6 h).

## Tables / config

`accounts.slack_bot_token_enc`, `slack_signing_secret_enc`, `slack_config` (channels, events,
digest hours, taskCheck {tz, checkin null, checkout '23:55'}, people {hostawayUserId: slackId},
dm {mode test|on|off, testUser}, helpSopId '8', appUrl), `slack_sent` (dedup keys
`digest:<kind>:<day>`, `taskcheck:<kind>:<day>`, `overdue:<day>`), `slack_threads`
(channel+ts → task|claim).

## Workspace facts

Workspace "Kaizen"; bot U0C5NJS538B; Juan U0C5CQSSVQV. All topics → **#kaizen-ops**
(C0C72JDKZ53, the team). **#kaizen-task** (C0C5NL9H5UK, private) = tests. Manifest reinstalled
with im:write, app_mentions:read, reactions:write and the `app_mention` event. DM mode `test`.

## What it does

- Clock: 8 AM (day + tasks named + claims, Manage per section, 💬 menu), 3 PM (missing for
  tomorrow), 11:55 PM tasks check-out — Central. A stale morning is skipped after 3 PM.
- `/kaizen help|tasks|task|repair|claims|claim|today|cleans`; ⚡ New task / Report a repair /
  New claim; ⋯ Create task from message.
- `@Kaizen new|repair <words>` → made at once (listing guessed, ✎ Add details in the thread);
  `claim` → form; `tasks`, `claims`, `today` (private, in the asker's thread behind a
  "🔒 Answered privately" stub); `all` (public, in thread); `help` (buttons to every pop-up);
  in a task/claim thread: text = comment (✅), `comments` = the list.
- Cleans pop-up: each clean also says ↗ the stay leaving (guest, nights, guests, channel,
  total) and ↘ the next arrival (same day + time, or date + days empty; guest, nights, guests,
  total) — totals only for roles with `money` (§116). The board is read a week past the day.
- Task card and claim card (comments, Add comment with focus). Kaizen comments → thread.
- DMs to owners via People mapping; cleaner channels prepared, manual send only.

## Slack API rules that bite

- Web API **form-encoded** (read methods refuse JSON). ≤5 overflow options. **No duplicate
  action_id within a block** (`task_new_repair`). Modals need a trigger_id within 3 s →
  loading modal + `views.update`. Mentions carry no trigger_id → answer with buttons.
  An ephemeral reply shows in a thread only if the thread exists. Signature: HMAC
  `v0:ts:body`, 5-minute window. Retries (`X-Slack-Retry-Num`) are ignored.
- `/api/slack` and `/api/slack-cron` are SELF_AUTHENTICATING and behind the Access bypass app.
- A task button on a message **in the tasks channel** updates that message in place and sends
  `via: 'slack-message'`, so /api/todos does not post a second completed/started/reopened
  notice (it showed twice, 2026-10-07). From the app, pop-ups or DMs the notice still posts.
- `@Kaizen new` remembers two threads per task (the channel notice and the mention's thread) —
  that is expected, not a duplicate.

## Open items

- Clock moved to Cloudflare (2026-10-07) after GitHub sent the 8 AM at 12:19 PM and missed a
  check-out. Verified: runs every 5 min, 200, sends only what is due. Wrangler is logged in as
  jdgonzalezp2014@gmail.com (account d217bb2fee2ba40210af9e0dee4d45c2, Pages project `kaizen`).
- Hostaway AI escalations: no API; plan = notification email → Kaizen → task. Waiting for a
  sample email / rule screenshots. Nothing built.
- Offered: Slack Home tab.
- Threads exist only for messages posted since §107 (or tasks made from a message).

## History

§99–§102, §107–§116.
