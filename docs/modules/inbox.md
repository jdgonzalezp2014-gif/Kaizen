# Module: inbox (Guest Services → Inbox, the CRM)

One reservation, everything about its guest (owner, 2026-11-16): the conversation (Hostaway), SMS (Quo), the to-dos
tied to the stay, scheduled and automatic messages, the guest portal link, and an AI draft written from the Repository
and the SOPs. Hostaway and Quo keep the conversations; Kaizen keeps only its own outbox, templates and settings.

Phase 1 of `docs/roadmap.md` (2026-11-16, migration 117): automations per listing / event / condition, the online
check-in mark, one tab per channel, Hostaway's live webhook and the unanswered-guest watch.

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
- Clock: `clock/index.ts` calls `/api/slack-cron?job=messages` every 5 minutes (a call of its own, beside Slack's):
  `runDue` (the outbox) and then `watchPass` (who is still waiting).
- Automations screen: `src/screens/Automations.tsx` (the bolt in the Inbox head, `?v=auto`): cards, starter `RECIPES`, quick replies, the editor.
- Live: `src/lib/guest-watch.ts` (+ test, pure: `eventFrom`, `triagePrompt`/`triageFrom`, `toCheck`, `watchMessage`),
  `functions/_lib/guest-events.ts` (`takeEvent`, `watchPass`, `openEvents`), `src/components/GuestPing.tsx` (the menu's count + `useGuestFeed` → the bell, which rings/notifies — platform.md → "The bell";
  one poll of `/api/inbox?events=` per open app), the webhook door `POST /api/slack-cron?job=guest-event&k=<hookSecret>` (guest-link.ts).

## Tables (migration 116)

`guest_messages` (the outbox: scheduled · staged · sent · failed · cancelled; `source` manual · scheduled · auto;
`ai_draft`; unique per stay + template when `auto`), `message_templates`, and on `accounts`: `guest_ai` (jsonb),
`guest_messages_live`, `guest_portal_url`.

Migration 117: `message_templates.listing_ids` (NULL = all) · `only_if` (always | checkin_pending | checkin_done) · `hold_hours`;
`guest_messages.via` (email | channel, NULL = the thread's own way); `guest_checkins` (one row per stay: the online check-in is done —
`source` portal | team); `guest_events` (what the webhook reported: one row per guest message with `needs_reply`, `urgent`, `answered_at`,
`reminded_at`); `accounts.guest_watch` ({ watch, waitMinutes }). Every read and write of these degrades without 117 (the old columns still work).

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
- **The AI drafts, a person sends** — one exception, urgent check-in (below). It asks the **Guest replies** chain of AI tasks (2026-11-23, platform.md; unset = `accounts.guest_ai`'s provider + model, then the other provider), with the
  account's own key. A low-confidence answer is a handoff. Conversation text is treated as the guest speaking, never as
  instructions. Claude Opus/Sonnet 5.5 calls carry `fallbacks: "default"`. What it reads — see "The guest AI" below.
- The portal link is `accounts.guest_portal_url` + `/guest/<reservation>.<sig>` (`signGuest`, HMAC with
  ENCRYPTION_KEY). **The portal moves to its own domain** — nothing else may build that link.
- Times: `GUEST_TZ` = America/Chicago for check-in/out moments (per-account zone is product debt).

- **Automations (117).** `planFor` is the one rule: listing scope (`appliesTo`), the trigger's moment (`dueAt`), the condition, the grace.
  Event triggers (`booked`, `checkin_done`) count from when it happened; `hold_hours` = never earlier than that long before check-in
  (done inside the hold → at once). `waiting` = after-check-in with no check-in yet; `skipped` = the condition does not hold
  ("only if not done" is settled the moment it is done; "only if done" is judged at its moment). Two ways in, one path (`createDue`):
  the clock's pass, and `fireStay(reservation)` the moment something happens (Mark done, the webhook's `reservation.created`). The unique
  index makes them harmless together. An automatic row whose booking is no longer confirmed at send time is `cancelled`, not sent.
- **House blanks** (`door_code`, `wifi_network`, `wifi_password`, `address`) are filled only on the server, only in automations
  (`houseVars`): door code = `doorCodeFor(lock type, Repository guest code, the reservation's Hostaway `doorCode`)` — the portal's rule.
  No value → the row is `failed` with the reason (never a blank code). The reply box refuses them. A sent code is in `guest_messages.body`.
- **Recipes open paused**, and a new automation that needs a 117 column is inserted paused and switched on only once those are stored —
  with sending on, an automation that silently became "all listings, always" would message every guest.
- **Tabs** (`threadTabs`, `tabOf`): All · the booking channel (only for Airbnb/Vrbo/Booking/Expedia or when the thread has channel
  messages) · Email (Hostaway has an address — `recipientEmail` / the reservation's `guestEmail`; the conversation's own `guestEmail` is a
  relay address on every row, not a signal) · SMS. A reply from Email / the channel tab sets `via`; from All it travels as the thread talks.
  **SMS is Quo only (owner, 2026-11-16: Hostaway's SMS costs per message — never sent from Kaizen);** Hostaway's own SMS automations show
  read-only (All, and merged into the SMS tab when Quo is connected).
- **Live events.** The webhook is a hint: `takeEvent` re-reads the conversation from Hostaway before believing anything. A guest message →
  one `guest_events` row (deduped by Hostaway's message id) → triage by ai-chain's chat tier (no answer from any model = needs a reply).
  Urgent → Slack `escalations` topic at once. `watchPass`: newest event per conversation, needs a reply, older than `waitMinutes`, not
  told before → thread read again → answered (closed) / the guest left or cancelled (closed) / told ONCE. **No Slack line per message
  (owner).** Events also close when: Kaizen sends, the list shows the host has the last word, the thread is opened and the host wrote last.
  The list's "Needs reply" drops a conversation whose last message was sorted as needing none (`noReply`) — only while it is the last word.
- The webhook's secret is derived (`hookSecret`, HMAC of the account key) — nothing stored; shown masked in Settings with Copy.
  Holding it allows only reporting an event. `/api/slack-cron` is already outside Access and SELF_AUTHENTICATING.

## The guest AI — what it knows (audit 2026-11-19)

Audited on 70 real guest messages (`guest_events.preview`): amenities (towels, a TV per bedroom), distance to a venue, early
check-in / luggage, other units and dates, long-stay discounts, refunds after cancelling, booking approval, insurance stays,
hot water / AC. Before, the draft saw only the portal guide — not the listing's text, capacity, fees, cancellation, amenities,
the booking or any company policy — so most of those were guesses or handoffs. Now `suggestReply` (`guest-ai.ts`) gives:
- **LISTING** = `guideFacts` (portal guide: Wi-Fi, address, times, parking, guest access, house rules, builder steps/house items,
  extras) + `listingFacts` (`src/lib/guest-knowledge.ts`, a whitelist of the Repository record: title, type, area, max/included
  guests, beds/baths, size, floor, elevator, min/max nights, cancellation, every fee, summary, description, the space,
  neighborhood, getting around, other notes, utilities) + Hostaway amenities (`fetchListingAmenities`, needs includeResources=1).
- **THIS BOOKING** = `stayFacts` from GET /reservations/{id}: channel, adults/children/infants/pets, nights, the booking's own
  hours, total + balance, the guest's booking note; payment / agreement / ID / online check-in. **OPEN WORK** = open to-dos of the stay.
- **COMPANY** = `guest_ai.business` (Settings → Integrations → Guest messages & AI → "Company facts for guests", ≤6000, jsonb, no
  migration) — EMPTY today: the owner fills it (hours, emergency line, early/late, discounts, refunds, approval, insurance stays…).
- **OTHER LISTINGS** (`portfolioFacts`: public title, area, beds, guests) — for "do you have another unit?"; availability never claimed.
- **SOPs**: only sections `GUEST_SECTIONS` (guest, claims, maintenance, compliance, mod-guest-services/experience/portal) or no section;
  framed as internal procedures. The cleaners'/Slack/pricing SOPs no longer reach a guest draft.
- Guards in code, not only the prompt: `scrubCodes` on every fact (real records hold door codes in "Elevator"); before a booking
  (inquiry / cancelled) no exact address, Wi-Fi, arrival steps, phone or manual; "Public address" is cut to the area (`areaOf` — it
  holds the street on real records). Airbnb threads: never payment/contact/booking off Airbnb.
- The prompt is a CX playbook per question type (amenity, early/late, broken, money, dates, distance, approval, upset, thanks) and
  answers every question in the last messages. New output `missing` ("Missing: …" on the draft card) = the fact to add next.
- Dry run on a real P2 inquiry (no model call): ~15.7k chars, record matched, 85 amenities, 0 codes from the records in the text.
  **Not run against a model yet** — read the first drafts (and their "Missing") before trusting it.
- Data gaps seen (Repository, 2026-11-19): listing text/fees filled on 21 of 44 records (the active ones); `svc_*`, waiver,
  deposit, `guest_code`, `portal_photo` empty everywhere; houses have no parking notes; Hostaway amenities differ from the text.

## Drafts on arrival + online check-in first (owner, 2026-11-23 — migration 122)

Owner: "the bot reads the messages and answers from the guest portal — it may ask them to fill it before giving info, send the link
or answer; for now a draft that can be sent or not; later it takes care of it."
- **When:** `takeEvent` (the webhook), after triage, when the message needs an answer (no triage = it does) and the stay is open →
  `draftEvent` (guest-events.ts) through the request's `waitUntil`; stored on `guest_events.draft` (`{"pending":true}` claims it, then the
  suggestion or `{error}` — never re-asked). Catch-up: the clock's `messages` job runs `draftPass` (one per pass, last 6 h; a claim older than
  15 min is retried). Same brain as Suggest: `suggestFor(conversationId)` (guest-ai.ts).
- **Inbox:** ✦ beside the dot in the list (`drafted`); the thread's `draft` opens the Composer's card as "Drafted when the guest wrote";
  **Use** fills `{{portal_link}}` and the other blanks (`fill` + `varsFor`) — the model writes the link only as `{{portal_link}}`.
  Composers are keyed by conversation now (a card no longer carries over to the next chat).
- **Portal first** (`portalLines`, inbox.ts): booked stay + portal address + online check-in not done → the guide and listing facts are built
  with `booked: false` (no address, Wi-Fi, steps, manual, phone reach the model) and the rule asks the guest to complete the check-in with the
  link; done → arrival answered, the code stays in the portal. **Old check-in notice:** agreement `signed` or ID verified in Hostaway → "we moved
  to a new online check-in, complete it once". **Damage protection** line from the Repository (`protectionFor`, nights); Airbnb = AirCover.
- Settings → Guest messages & AI: three boxes (`autoDraft`, `portalFirst`, `oldPortalNotice`; unset = on, jsonb, no migration).
- Tried 2026-11-23 with gemini-3.6-flash on a real Vrbo stay (P2-1201, agreement signed) + a made-up "door code / address / coffee maker /
  deposit" message: no code or address, the link blank, the old-check-in notice, coffee maker from amenities, $300 / $70. **Not seen yet: a
  draft written by the webhook** (needs 122 + deploy) — check `SELECT id, preview, draft FROM guest_events WHERE draft IS NOT NULL ORDER BY id DESC LIMIT 5`.
- **Check 2026-11-23 (2nd pass, owner: "is it working, with Claude, from the portal?"):** 122+123 applied; webhook live (events every few
  minutes); AI = Claude `claude-opus-5-5`, mode suggest. **The one webhook draft so far (event 246) failed: the stored Claude key is refused
  by Anthropic (401 invalid x-api-key)** → the owner pastes a new key in Settings → Integrations → AI. Dry run on that real stay with the model
  stubbed: ~23k chars to claude-opus-5-5, portal guide + Repository + booking + protection all in. "Company facts for guests" still empty.
  ⚠ `accounts.guest_messages_live` is TRUE (sending on) — drafts are still never sent by themselves.
- Same pass: **old Hostaway form** wording = acknowledge it (received, nothing lost) + the new check-in releases the arrival details "to avoid
  any problem or misunderstanding"; a guest who says "I already did it" is never argued with. **Guests already inside** (`staying`/`leaving`)
  are not held behind the online check-in (Wi-Fi/address answered). After the check-in: the draft gives the check-in instructions, the
  code stays in the portal. **Failed drafts retry** (`RETRY_DRAFT`: 3 tries, 20 min apart, `tries` on the draft, only while waiting, 6 h).
  **Slack's reminder** (`watchMessage` `draft`) says "A reply is drafted in the CRM" or why the AI could not draft. SOP #43: `.sop-draft-1123.mjs` after deploy.
- **Urgent check-in = the AI solves it (owner, 2026-11-23: "unless it is beyond its control").** Triage has `checkin` (getting in: code,
  entry, finding the unit, arrival parking, the online check-in). `urgent && checkin` + open stay + `guest_ai.autoCheckin` (unset = on; Settings box
  box to come with the mode "Answer on its own" — **owner 2026-11-23: drafts only for now, so it is OFF: `autoCheckin` is true only when `mode` is 'auto', which
  cannot be chosen yet**) + guest messages live → `solveCheckin` (guest-events.ts) instead of the instant alert: forced draft →
  `checkinAutoSend` gate (no handoff, confidence high, blanks filled via `varsFor` + `portalFor`, thread re-read: still waiting) → a `guest_messages`
  row (`source` manual, `created_by` 'Kaizen AI', not retried by the clock) → `deliver` → Slack `solvedMessage` (what was sent). Fails any gate →
  nothing sent, the urgent alert with "not answered by the AI: <why>" and the draft's state. Beyond control (code/lock fails after the steps, battery,
  broken lockbox/call box, unit not ready, someone inside, safety) = handoff in the prompt. Triage checked on real-like texts (gemini-3.5-flash-lite).
  **Never run end to end** — the Claude key is refused; watch the first one.
- **Playbook, owner 2026-11-23 (3rd pass):** the host speaks in first person ("let me check and confirm") — never "the team"; an inquiry
  with few details gets its question answered + up to 3 questions (dates, adults/children, pets kind/weight, reason for the trip); pets = yes
  within the house rules (Repository `house_rules`: disclosed, ≤50 lbs) + `pet_fee` paid before arrival; early/late = the guest asks in the
  portal up to the day before ($20/h, confirmed when no turnover that day). A reminder (online check-in) goes AFTER the answer, never instead;
  never ask what the guest already said. **Company facts written** (guest_ai.business, 951 chars: pets, early/late, times, online check-in,
  inquiries — no hours/emergency line yet, owner adds). Real Claude drafts checked: an inquiry with a dog, an early check-in on a booked stay.
- **Bad experiences + what the AI sees (owner, 2026-11-23, 4th pass — migration 124 `guest_issues`, NOT applied):** triage has `bad`
  (the stay itself hurt: dirty, important thing broken, noise, pests, unsafe, misleading, rude, disappointment; NOT a small missing item the
  host is bringing — checked on 3 real-like texts) → `recordIssue` (one open row per stay, `source` ai | team). Condition subject `issue`
  ("Bad experience": None / Recorded) — `issue_pending` is a stopper; the **Thank you & review** recipe carries it. Clock facts `issuesOf`.
  CRM: stay panel line "Bad experience" (Record with one line / Clear), a red mark on the list row, filter "Bad experience" (loaded page only).
  The guest is told nothing. AI prompt: 40 messages (last 10 whole, older 400 chars), MESSAGES ALREADY SCHEDULED (Kaizen outbox rows +
  `planFor` automations still to come; Hostaway's own automations are not readable — its public API has no endpoint), BAD EXPERIENCE ON
  RECORD (never ask for a review), complaint → apologise + handoff, a scheduled message that would be wrong → said in `reason`.
- **Refunds / complaints (owner, 2026-11-23):** never offer a refund, credit or money back; no apology up front, no fault admitted. First reply:
  thanks, "not our standard", checking with housekeeping (cleaning), solving it ASAP; only when they insist after that → ask what they would like,
  promise nothing; always handoff. Company facts got a "Refunds:" line (1150 chars). Checked with Claude on a dirty-arrival + refund thread.
- **Guest rating (owner, 2026-11-23):** Airbnb does not give Hostaway the guest's rating — `guestRecommendations`, `guestTrips`,
  `isGuestVerifiedByReviews` are 0 on every stay, inquiries too. Hostaway does give `guestExternalAccountId` (the Airbnb user id) →
  `bookingLinks().profile` = airbnb.com/users/show/<id> (person icon beside H / A in the conversation head): the reviews other hosts left.
  Accept / decline an inquiry stays manual (owner) — in Hostaway / Airbnb; the AI never accepts or promises availability.
  Own data for later: Hostaway /reviews has our host-to-guest reviews (rating null; some carry 3 category scores) — usable for repeat guests.
- **Quo / SMS (checked 2026-11-23):** key works, 5 numbers, `quo_from` = …3228 "Hikaru CS MAIN" — the SMS of matched guests are there.
  The gap is the phone: **Airbnb gives Hostaway no guest phone (20 of 22 Airbnb stays)**; Vrbo/Booking.com do. Fix proposed: ask the phone in the
  portal's online check-in when Hostaway has none, and a Quo webhook for incoming SMS → guest_events. `quo.ts` still on api.openphone.com (works).
  No Kaizen automations exist yet (0 templates).
- **Recipes rewritten for going live (owner, 2026-11-23; Hostaway's automations already off, sending live):** short, calm, no dashes
  (a test refuses — or – in a recipe body). New: **Welcome** (at booking: thanks + `{{portal_link}}` for details and the online check-in),
  **How is everything** (24 h after check-in, held by a bad experience), **Mid-stay cleaning** (new trigger `mid_stay` = the middle day,
  `floor(nights/2)`, at 10 AM + the wait; condition **Stay length** `monthly_done` = 28+ nights, `MONTHLY_NIGHTS`), **Extend your stay**
  (48 h before check-out, condition **Night after check-out** `open_done`: the check-out night is 'a' in `calendar_watch`, looked at in
  the last day — `openAfterOf` in guest-outbox.ts, no Hostaway call; not seen = skipped). Both new subjects are no-migration `only_if` tokens.
  The conversation's Scheduled card and the AI's list do not read the calendar: an extension shows "planned" there until its moment.
  Recipes are starters (paused); the owner creates each one from the Automations screen and switches it on after reading it.
- Same day, 2nd pass (owner): **Online check-in reminder (arrival day)** (6 h before check-in, check-in not done) beside the 48 h one;
  extension text = "we have some availability after {{checkout}}" (one open night is enough). New condition **Extra charges**
  (`charge_pending` stopper / `charge_done`): a `upsell_charges` row `pending` (card or Airbnb RC) — `chargesDueOf`, the same rows the
  portal's "Pending payments" shows (with Pay / Pay on Airbnb / "I already paid", parallel session). No guest recipe for it (owner: a pending charge
  is for the team, a Slack notice later, not a message to the guest); the condition stays for any automation. Hostaway's own reservation payment stays the **Payment** condition (Payment reminder, 72 h before).
- Owner switched on Welcome, both check-in reminders and Door code (2026-11-23). `{{listing}}` is the internal unit name (CL1235,
  P2-1406) → taken out of every recipe and of the 3 live templates (a test refuses it in recipes); no "house" either (P2 are apartments).
- Then ALL ten starters made and ON (owner: they replace Hostaway's). The screen groups them Before arrival / During the stay /
  After check-out (`phaseOf`), in stay order (`stayOrder`); "Start from" lists only starters not made yet (by name).
- ⚠ The stay link `/guest/<id>.<sig>` still shows only Pending payments (Phase 2): a guest sent there today cannot do the check-in.

## Who sent it + attachments (owner, 2026-11-23)

- "Everything shows as Derek": the channels (Airbnb, Vrbo…) show the listing's host account on every host message — Hostaway
  sends as that account and nothing in its API changes it. Kaizen now names the sender under each bubble: Hostaway's `userId`
  → first name (`fetchTeam`, GET /users, an hour per worker), `communicationId` → "Hostaway automation", Kaizen's own sends keep
  `created_by` on the channel's copy (`mergeThread`; an email becomes the Hostaway first name, `senderName`). No name = written in
  the channel's own app. Checked on a real thread: Amanda · Juan · Shannon · Hostaway automation.
- **Attachments: Hostaway's send is text only** — its docs: "We do not support sending attachments in the message" (read
  2026-11-23). Incoming photos already show (`imagesUrls`). Sending a photo would have to be a link (upload → Drive → a signed
  public URL on the portal's domain, appended to the text) — proposed to the owner, not built.

- **Pending beside the name (owner, 2026-11-23):** an amber "!" next to the guest in the list (count when more than one; the tooltip lists
  them) for anything still open on the stay — open to-dos, open claims, an upsell charge not paid yet (Airbnb Resolution Center or the
  Stripe link: the case stays Open until it is marked Paid) — `pendingOf` / `caseLine`, claims only for people with `claims`. It replaces
  the red to-dos count on the right. The stay's **Upselling** fold is red with "!" while a charge is open, like Work and Claims.
  The stay card shows Hostaway's check-in / check-out **hours** under the dates; an open (unpaid) Early / Late check-in or Late checkout
  case marks that hour amber "! · not paid" (Hostaway's hour moves only once the charge is paid — §178). Needs `claims` to see the mark.
  Bad experience keeps its own red mark in the preview line. **Suggest** is now the sparkle icon alone (owner: the word looked too important).

## Not verified yet (no way to without a real guest or a key)

- **117 is written, NOT applied** (2026-11-16). Seen working without it on real data (read-only harness): list, thread, tabs,
  Automations screen, settings. Not run for real: saving an automation with listings/condition, Mark done → `fireStay`, `{{door_code}}`
  on a real stay, a reply by Email (`communicationType: 'email'` — Hostaway may want a subject), the webhook's real body
  (`eventFrom` is written from Hostaway's docs + the events PriceLabs' webhook lists), triage on a real message, the Slack line.

- `sendMessage` (POST `/conversations/<id>/messages` `{ body, communicationType }`) — written from Hostaway's API,
  never run. Watch the first live send.
- `quoThread` / guest SMS — written from Quo's reference; the account has no Quo key. `quo.ts` still uses
  `api.openphone.com` (Quo's docs now show `api.quo.com`).
- The AI suggestion on a real thread — mode is off until 116 runs.

## Open items

- **Deploy phase 1:** `npm run migrate` (117) → push → `node --env-file=.env.local .sop-117.mjs` (SOP: new version, or the draft)
  → Settings → Integrations → Guest messages & AI: copy the webhook address into Hostaway (Settings → Integrations → Webhooks →
  unified webhook) → check "Connected — last event" there after the next guest message. The watch posts to Slack's Escalations
  channel (#kaizen-ops today) — change the channel or switch the watch off in the same panel. No clock redeploy needed.
- First real use: one automation for one listing, watch its row in that guest's conversation; then the webhook's first events
  (`SELECT event, needs_reply, urgent, why, preview FROM guest_events ORDER BY id DESC LIMIT 20`).
- Calls (Quo) — later (owner). Quo's API lists calls / recordings / summaries; it cannot place one. Needs the account's Quo key first.
- A booking-channel filter on automations (Airbnb only / direct only), and more events (payment received, extras bought) once the
  portal's real door reports them (roadmap phase 2).
- Web Push for a closed browser (today the notice needs Kaizen open in a tab).
- Then: turn the AI to Suggest, read drafts for a few days; write the templates; read the staged rows beside Hostaway;
  only then turn sending ON and switch Hostaway's automations off one at a time (arrival instructions first).
- The portal's real door must write `guest_checkins` (source `portal`) and call `fireStay` — phase 2; until then a person marks it.
- The portal's real door (`/guest/<id>.<sig>` → `verifyGuest`) and its events (check-in done, extras, payments) feeding
  the stay panel — today the panel shows Hostaway's paid / agreement / ID.
- Mark-as-read is not written back to Hostaway.
- Fill "Company facts for guests" (owner) and read a week of drafts' "Missing" lines → Repository fields / facts.
- Answering on its own ("auto") — not built; `guestAiFrom` reads it as suggest. `ai_draft` vs the sent text is the
  evidence for when to build it.
- Claims & upselling still lives in Operations → To-do; Guest Services has a door to it.

- 2026-11-17 (owner): the conversation's To-dos "+" opens a pop-up — Task / Repair (work order) / Purchase (purchase order)
  go to Operations → To-do; Claim (`CASE_CATEGORIES`) and Upsell (`UPSELL_CATEGORIES`) open a case in Claims & upselling (needs `claims`).
  The bell shows a dot for anything new; the count stays on Guest Services. The menu's Leadership is now "Home".
- 2026-11-17 (owner): **cancel what is scheduled, per stay** — the conversation's Scheduled card: Cancel per row, Cancel all
  (two steps), Undo on a cancelled automation. POST `hold` / `resume` in `functions/api/inbox.ts`: a manual message →
  `cancelled`; an automation → its once-per-stay row written as `cancelled` with `created_by` (kept out of the thread), so the
  clock never makes it; `resume` deletes that row. The automation stays on for every other stay.
- 2026-11-17 (owner): **conditions on automations** (not flows — owner dropped flows to keep it simple). `Template.conditions:
  Cond[]` (online check-in / payment / agreement / ID × not done | done; all must hold), stored as a comma list in
  `message_templates.only_if` (old values still read; no migration). "Not done" = stopper (skipped the moment it is done);
  "done" judged at the moment. Facts on the clock's `Stay`: `paid` (`paidOf` Hostaway paymentStatus; Unknown = null = done),
  `signed` (`signedOf`; none = done), `idVerified`. Checked 2026-11-17 on 46 stays: paymentStatus Paid/Unknown, agreement
  signed/not_signed, **ID verified false on all** → ID conditions useless until the portal reports it. New recipe: Payment reminder.
- 2026-11-17 (owner): small links beside the stage in the conversation header — **H** opens the reservation in Hostaway, **A** in Airbnb (host page by its HM confirmation code, `bookingLinks`); other channels: Hostaway only.
- 2026-11-17 (owner, "simplify"): the stay's side = stay card · **Online check-in in one line** (Done / Not done + Mark done) ·
  folded sections (`<details>`, count + own "+"): **Work** (task / repair / purchase → Operations → To-do), **Claims** (start a
  case), **Upselling** (upsell cases + **Extend stay**: POST `extend` reads the live Hostaway calendar, `calendarFit` — free nights
  before/after + Hostaway prices; the change is an alteration made in Hostaway / Airbnb via the header links, never from here),
  **Scheduled**. Thread GET adds `cases` (claims of the stay, needs `claims`) and `order` on tasks. A case opens in Claims & upselling.
- 2026-11-17 (owner): open Work and Claims on a stay are red with a "!" (section count, fold border) until closed; the list row's open to-dos badge too.
- 2026-11-17 (owner): menu — Guest Services shows only a red dot on its icon while a guest waits; its one door is renamed **CRM** (the screen's title too) and carries the count; the "Claims & upselling" shortcut was removed (`alwaysSub` keeps CRM drawn under the module).
- 2026-11-19 (§178, guests module): the Upselling section's + → **Upsell** goes on to "Charge the guest" (`UpsellCharge`) in the same pop-up — Airbnb: Resolution Center / change dates; others: Hostaway hold + Stripe pay link.
- 2026-11-23 (owner): **a to-do or a case opens as a pop-up over the conversation** — no trip to Operations → To-do / Claims & upselling.
  Work rows → `<TodoList task>` (the single-task pop-up Costs already used); Claims and Upselling rows → `ClaimPop` (Todos.tsx: the
  `ClaimCase` card in a Modal, re-read on `claims` live events). Closing it reloads the stay panel. `Inbox` no longer takes `onTodo` / `onClaim`.
- **Payments on the reservation card (2026-11-26):** a "Payments" fold lists what the guest paid in the portal (deposit held, waiver, extras,
  set-up to-dos) with Release / Keep / Refund — same rules and dialog as Guest Services → Payments (see guests.md).
