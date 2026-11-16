# Module: inbox (Guest Services → Inbox, the CRM)

One reservation, everything about its guest (owner, 2026-11-16): the conversation (Hostaway), SMS (Quo), the to-dos
tied to the stay, scheduled and automatic messages, the guest portal link, and an AI draft written from the Repository
and the SOPs. Hostaway and Quo keep the conversations; Kaizen keeps only its own outbox, templates and settings.

## Files

- Screen: `src/screens/Inbox.tsx` (three panes: list · thread · stay; `Conversation`, `Bubbles`, `Composer`, `StayPanel`,
  `TemplatesDialog`). Settings panel: `src/components/GuestAiPanel.tsx` (Settings → Integrations → Guest messages & AI).
- Pure: `src/lib/inbox.ts` (+ test) — stages, filters, templates and `{{blanks}}`, when a template is due (`dueAt`,
  `planFor`, `zonedInstant`), the thread's order (`mergeThread`), the AI prompt (`aiPrompt`, `guideFacts`,
  `suggestionFromAi`), the AI settings (`guestAiFrom`), the portal link (`portalLink`).
- API: `functions/api/inbox.ts` (GET list / thread / `?sms=`; POST send · schedule · cancel · retry · suggest),
  `functions/api/inbox-settings.ts` (templates, AI, live switch, portal address).
- Server: `functions/_lib/hostaway-messages.ts` (conversations client), `guest-outbox.ts` (the outbox: `deliver`,
  `runDue`), `guest-ai.ts` (`suggestReply`), `guest-link.ts` (`signGuest` / `verifyGuest`), `quo.ts` (`quoThread`).
- Clock: `clock/index.ts` calls `/api/slack-cron?job=messages` every 5 minutes (a call of its own, beside Slack's).

## Tables (migration 116)

`guest_messages` (the outbox: scheduled · staged · sent · failed · cancelled; `source` manual · scheduled · auto;
`ai_draft`; unique per stay + template when `auto`), `message_templates`, and on `accounts`: `guest_ai` (jsonb),
`guest_messages_live`, `guest_portal_url`.

## Permissions

`messages` (tab `inbox`, GET `/api/inbox`) · `messages.send` (POST `/api/inbox`) · `messages.setup`
(`/api/inbox-settings`). New: only admin has them until a role is ticked in Settings → Roles. To-dos in the stay panel
need `todos` (the same `/api/todos` create as everywhere — the Hostaway task mirror applies).

## Rules that bite

- **Staged by default.** While `accounts.guest_messages_live` is false, `deliver()` runs the whole path and does not
  send: the row says `staged`. Hostaway's automations stay ON (owner, 2026-11-15: guest messages must never fail) until
  the staged rows have been read beside what Hostaway sent. The switch is in Settings → Integrations.
- **Every message is a row first**, then goes out. A failed scheduled/automatic one is retried 3 times, 10 minutes
  apart, by the clock; one typed now fails at once with the reason and a Retry. `retry` claims the row
  (`failed|staged → scheduled`) before sending, so two clicks send once.
- **Automatic templates go once per stay** (unique index), only for confirmed bookings (`new`, `modified`), inside a
  6-hour grace after their moment (`GRACE_HOURS`) — a stay booked after the moment has passed is `missed`, not sent late.
- A message with an unfilled `{{blank}}` is refused (`{{portal_link}}` is empty until the portal address is set).
- **"Needs reply" = the guest wrote last** (`lastIncoming`), not Hostaway's unread flag (42 of 50 were "unread" there).
- The list's preview of a Hostaway automated message is the raw template; the guest got it filled (`plain()` fills the
  name for the row). Hostaway's dates are UTC.
- The guest's phone never reaches the browser: masked in the stay panel, resolved on the server for SMS.
- **The AI drafts, a person sends.** It asks exactly the provider + model in `accounts.guest_ai` (no chain), with the
  account's own key; facts = `guestHouse()` (what the guest portal shows — door and lockbox codes excluded) + the 5
  best-matching published SOPs + the last 12 messages. A low-confidence answer is a handoff. Conversation text is
  treated as the guest speaking, never as instructions. Claude Opus/Sonnet 5.5 calls carry `fallbacks: "default"`.
- The portal link is `accounts.guest_portal_url` + `/guest/<reservation>.<sig>` (`signGuest`, HMAC with
  ENCRYPTION_KEY). **The portal moves to its own domain** — nothing else may build that link.
- Times: `GUEST_TZ` = America/Chicago for check-in/out moments (per-account zone is product debt).

## Not verified yet (no way to without a real guest or a key)

- `sendMessage` (POST `/conversations/<id>/messages` `{ body, communicationType }`) — written from Hostaway's API,
  never run. Watch the first live send.
- `quoThread` / guest SMS — written from Quo's reference; the account has no Quo key. `quo.ts` still uses
  `api.openphone.com` (Quo's docs now show `api.quo.com`).
- The AI suggestion on a real thread — mode is off until 116 runs.

## Open items

- **Deploy:** `npm run migrate` (116) → push → `npx wrangler deploy -c clock/wrangler.toml` (the clock's second call)
  → `node --env-file=.env.local .sop-116.mjs` (SOP draft) → tick `messages*` for the roles that need it.
- Then: turn the AI to Suggest, read drafts for a few days; write the templates; read the staged rows beside Hostaway;
  only then turn sending ON and switch Hostaway's automations off one at a time (arrival instructions first).
- Conditions on templates ("only if online check-in is not done") — waits for the guest portal to record check-ins.
- The portal's real door (`/guest/<id>.<sig>` → `verifyGuest`) and its events (check-in done, extras, payments) feeding
  the stay panel — today the panel shows Hostaway's paid / agreement / ID.
- Hostaway webhooks for new messages (today: reload every 2 minutes while open). Mark-as-read is not written back.
- Answering on its own ("auto") — not built; `guestAiFrom` reads it as suggest. `ai_draft` vs the sent text is the
  evidence for when to build it.
- Claims & upselling still lives in Operations → To-do; Guest Services has a door to it.
