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

`/guest/<id>.<sig>` reads the stay from Hostaway, saves the check-in on the server (`guest_checkins`), releases the
door code by rule, turns "Request a change" into a to-do, and the stay host shows only the portal. Depends on Phase 0.
Hostaway writes (extend a stay, add a fee) stay behind the owner's OK.

## Phase 3 — one AI for everything (module: platform)

1. **Providers**: one layer (`ai.ts`) for Claude · Gemini · **Grok** (xAI, OpenAI-compatible) · Workers AI; the
   account picks the order in Settings → Integrations → AI; each use (guest replies, assistant, receipts) names a
   tier, never a vendor.
2. **Knowledge**: the Repository record of the listing (whole, minus codes), published SOPs, the stay's facts
   (payment, check-in state, to-dos), and a **saved-answers** list (question → approved answer, per listing or all)
   fed by what the team sends after editing a draft.
3. Guest AI modes: off · suggest · (later) auto for high-confidence answers from saved answers only.

## Phase 4 — the assistant (modules: slack + platform)

One brain, two doors: a chat panel in Kaizen OS and `@Kaizen` in Slack. Tools: read (Repository, SOPs, to-dos,
stays, costs of a month) and act with a confirmation step (record an expense from an uploaded invoice — reusing
`receipt-read.ts` — create a to-do). Answers in plain language ("how is the month going"). Acts as the person
asking: their role decides what it may read or do.

## Phase 5 — audit and reorganise (one module per session)

- **Guest Experience**: check-in guides builder (from Repository), online check-in status per stay, listing ratings
  (the price-monitor Apps Script feed) — out of Finance.
- **Tasks ↔ Finance**: one path from a closed task / repair / purchase to Costs; find what is typed twice.
- Workflows that are broken or half-wired: each module doc's Open items, oldest first.
- Access JWT validation (platform), Web Push for a closed browser, per-account time zone (product debt).
