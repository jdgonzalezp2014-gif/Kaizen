# Roadmap (owner's brief, 2026-11-16)

One phase per session, in this order; each ends with tests, the module doc, its SOP and a commit. A phase is done
when it was seen working on real data, not when it deploys. Facts below were checked on 2026-11-16.

## Where things stand

- Inbox (migration 116) is live and **sending is ON** (`guest_messages_live = true`, 2 messages sent). No templates
  yet, the guest AI is off, no Quo key, no portal address.
- Hostaway conversations: `communicationType` seen on real threads = `channel`, `email`, `emailFormatted`, `sms`
  (no WhatsApp message in the account). Unified webhooks exist and are already used by PriceLabs:
  `reservation.created`, `reservation.updated`, `message.received`, `task.created`, `task.updated` (URL + basic auth).
- The guest portal's real door (`/guest/<id>.<sig>`) is a placeholder: the online check-in lives only in the
  guest's browser (demo). Nothing on the server knows a check-in was finished.
- `stay.kaizenguestproperties.com` → the Pages project (DNS at Wix, so no Cloudflare Access on that host).
  `identify()` trusts the Access header only on Access-guarded hosts since 5e9ab1f.

## Phase 0 — the portal's domain (owner steps)

Push 5e9ab1f **before** the domain turns Active → set the portal address (Settings → Integrations → Guest messages
& AI) → register the domain in Stripe (wallets) → later: the stay host serves only the portal (Phase 2).

## Phase 1 — Inbox: automations, channels, live messages (module: inbox)

**Built 2026-11-16, not deployed** (migration 117 written, not applied — see `docs/modules/inbox.md`). Owner's answers that
shaped it: SMS only through Quo (Hostaway's SMS costs — never sent from Kaizen); email through Hostaway; calls later; the door code
comes from Hostaway and goes in the message *and* stays in the online check-in; no Slack line per message — a watch that reports a
guest who is coming or in the house and still unanswered, with a light model deciding whether the message needs an answer at all.

1. **Automations** (migration 117): a template gets *which listings* (all or chosen), *only if* (always · online
   check-in not done · done), a new trigger **After online check-in**, and *hold until N hours before check-in* (for
   door codes). New blanks: `door_code`, `wifi_network`, `wifi_password`, `address`. An automatic message is dropped
   if the booking was cancelled meanwhile. Own screen (Guest Services → Automations): cards with when · who · channel ·
   counts, starter recipes (door code after check-in, check-in reminder, check-out reminder, review ask).
2. **`guest_checkins`**: the record "online check-in done" (written by the portal in Phase 2; until then a person
   marks it from the stay panel) — it is what fires "After online check-in".
3. **Channels as tabs**: All · Chat (Airbnb/Vrbo/…) · Email · SMS · WhatsApp (only when the thread has it) · Stay.
   The reply goes out the way of the open tab (`guest_messages.via`). SMS = Quo when connected, else Hostaway SMS.
4. **Live messages**: Hostaway webhook → `/api/slack-cron?job=guest-event` (own secret) → `guest_events` → Slack
   line in a chosen channel + badge on the rail + browser notification; `reservation.created` fires "After booking"
   at once. The webhook is a hint: the truth is always re-read from Hostaway.
5. **Calls (Quo)**: Quo's API cannot place a call; it lists calls, recordings, summaries. Call log tab once the
   account has a Quo key (nothing can be verified before).

## Phase 2 — the portal's real door (module: guests)

Owner, 2026-11-16: build it so the team can open it and play — Stripe stays in **test mode**, but payments must really
confirm (webhook or session check) and be recorded, so the whole flow can be tried before going live.

`/guest/<id>.<sig>` reads the stay from Hostaway, saves the check-in on the server (`guest_checkins`), releases the
door code by rule, turns "Request a change" into a to-do, and the stay host shows only the portal. Depends on Phase 0.
Hostaway writes (extend a stay, add a fee) stay behind the owner's OK.

**Built 2026-11-23 (owner: "create it"), migration 123 — see guests.md "The real door".** Not done: the stay host serving only
the portal; extending the reservation in Hostaway after paid nights (a to-do for now).

## Phase 3 — one AI for everything (module: platform)

Owner, 2026-11-16: use ONE provider now and keep the keys of all of them; which use cases deserve AI is decided later.
So: the layer + keys + one chosen provider first; saved answers and "auto" wait for that review.

1. **Providers**: one layer (`ai.ts`) for Claude · Gemini · **Grok** (xAI, OpenAI-compatible) · Workers AI; the
   account picks the order in Settings → Integrations → AI; each use (guest replies, assistant, receipts) names a
   tier, never a vendor.
2. **Knowledge**: the Repository record of the listing (whole, minus codes), published SOPs, the stay's facts
   (payment, check-in state, to-dos), and a **saved-answers** list (question → approved answer, per listing or all)
   fed by what the team sends after editing a draft.
3. Guest AI modes: off · suggest · (later) auto for high-confidence answers from saved answers only.

## Phase 4 — the assistant (modules: slack + platform)

**First piece built 2026-11-17** (`docs/modules/platform.md` → Ask Kaizen): the in-app panel, Repository by rules, SOPs by a light
model, reveal of secrets through the Repository's own door. Still to do: the same brain in Slack, tools that act, "how is the month".

One brain, two doors: a chat panel in Kaizen OS and `@Kaizen` in Slack. Tools: read (Repository, SOPs, to-dos,
stays, costs of a month) and act with a confirmation step (record an expense from an uploaded invoice — reusing
`receipt-read.ts` — create a to-do). Answers in plain language ("how is the month going"). Acts as the person
asking: their role decides what it may read or do.

## Phase 5 — audit and reorganise (one module per session)

Owner, 2026-11-17 — first in this phase: **listing health in Guest Experience** = (1) are the listings connected on each channel
(`ChannelStatus` in hostaway.ts already reads it — find where it is shown today and move it), (2) the reviews / stars per listing from
the Google Apps Script scraper (`../price-monitor`, the ratings feed in finance.md) — rescue it and show the trend.

- **Guest Experience**: check-in guides builder (from Repository), online check-in status per stay, listing ratings
  (the price-monitor Apps Script feed) — out of Finance.
- **Tasks ↔ Finance**: one path from a closed task / repair / purchase to Costs; find what is typed twice.
- Workflows that are broken or half-wired: each module doc's Open items, oldest first.
- Access JWT validation (platform), Web Push for a closed browser, per-account time zone (product debt).
