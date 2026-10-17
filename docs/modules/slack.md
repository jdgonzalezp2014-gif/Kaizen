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
  `/api/slack-cron` with secret `KAIZEN_INGEST_TOKEN`; it also runs the hourly Host Note push → operations); deploy `cd clock && npx wrangler deploy`,
  logs `cd clock && npx wrangler tail kaizen-clock --format json`. `.github/workflows/slack-cron.yml`
  stays as a backup (GitHub's schedule ran every 5–6 h).

## Tables / config

`accounts.slack_bot_token_enc`, `slack_signing_secret_enc`, `slack_config` (channels, events,
digest hours, taskCheck {tz, checkin null, checkout '23:55'}, people {hostawayUserId: slackId},
dm {mode test|on|off, testUser}, helpSopId '8', appUrl, **botUserId (§153)** — the bot's own Slack
user id, read from `auth.test` the first time a thread reply is handled and cached), `slack_sent`
(dedup keys `digest:<kind>:<day>`, `taskcheck:<kind>:<day>`, `overdue:<day>`), `slack_threads`
(channel+ts → task|claim).

## Workspace facts

Workspace "Kaizen"; bot U0C5NJS538B; Juan U0C5CQSSVQV. All topics → **#kaizen-ops**
(C0C72JDKZ53, the team). **#kaizen-task** (C0C5NL9H5UK, private) = tests. "Add to…" listens in #kaizen-ops,
**#kgp-team** (C0C91GDLXL2, private) and #kaizen-task — the last on purpose, to test it (owner, 2026-10-14). Manifest reinstalled
with im:write, app_mentions:read, reactions:write, **channels:history (§144)** and the
`app_mention` event. DM mode `test`.

## What it does

- Clock: 8 AM (day + tasks named + claims, Manage per section, 💬 menu), 3 PM (missing for
  tomorrow), 11:55 PM tasks check-out — Central. A stale morning is skipped after 3 PM.
- `/kaizen help|tasks|task|repair|claims|claim|today|cleans`; ⚡ New task / Report a repair /
  New claim; ⋯ Create task from message.
- `@Kaizen new|repair <words>` → made at once (listing guessed, ✎ Add details in the thread);
  `claim` → form; `tasks`, `claims`, `today`, `all`, the to-do offer, `comments`, save failures
  — all **public**, posted in the asker's thread like a normal message (§152, so the team can
  manage/comment on what Kaizen answers). Only `help` and "not a Kaizen member" stay private,
  behind a "🔒 Answered privately" stub; in a task/claim thread: text = comment (✅).
- **A plain reply in a task's or claim's own thread is a comment too (§153)** — no `@Kaizen` needed.
  `message.channels`/`message.groups` events (new, alongside `app_mention`) reach `threadReply()`:
  only a threaded reply (`thread_ts !== ts`), not the bot's own post, and only when the thread is
  one Kaizen already knows (`slack_threads`) — everything else is left alone, no-op. An `@Kaizen …`
  reply is still the `app_mention` event's job; `threadReply` skips it (by the bot's own user id,
  `slack_config.botUserId`) so it is not saved twice.
- **`@Kaizen order <text>` = a purchase order from free text (owner, 2026-10-15)** — e.g. _2 paper towels y 1 Tide para LP-4212_.
  Nothing is saved until **Confirm**: Kaizen answers in the thread with a draft (`src/lib/order-text.ts`, pure + tests): each line
  **Rules first, then the AI for the rest (owner: "apoyarse en IA", and "refina … el gasto de tokens")** — a list: one item per line by
  the rules; what they settle (a taught alias, or the one item with every word of its name) never reaches a model; the rest go numbered to
  `readOrderLines` (request-read.ts) in parts of 30 at once, answered as one short row per line `[n, id, sure, [alts], name, measure,
  furniture, itemQty]` (`rowsToRaw` — flash-lite wrote "1: nights stands" for n, so the number is read from its start), checked by
  `readReceipt` (sure + existing, alias wins). One line of words: `readRequestText` splits it (as ✨ Build the cart; its prompt now keeps
  furniture — flash-lite had dropped 17 of 58 lines as "not supplies"). `draftLinesFromRead`: buttons = only what the model named
  (`suggested`), none = not in Kaizen with its name/type/measure prefilled in the forms. Only the first part writes `ai_last` (`askJson`
  `log: false`; subrequests). The draft says "16 matched by Kaizen, 42 read by ✨ …"; a part the AI did not answer keeps the rules' reading.
  Real list (58 lines, read-only test): 16 by rules + 42 by the AI in 2 parts, 10 s → 22 sure, 8 asked, 28 new. "Reading the order…" is
  posted first and replaced (27 s cap). **`@Kaizen order` alone in a thread** = the thread's first message is the order (not the bot's;
  `conversations.replies`) — how the owner first tried it. **One place, picked first (owner):** "Everything goes to:" is the draft's first
  choice, never split; supplies sent to a house go where that house's supplies are kept (`lineTarget`, the Repository's closet/storage),
  said under it ("🧴 3 supplies go to …"). Fallback rules: a line is
  matched to a supply (`matchOrderLine`) only when ONE item has every word of its name in the line and holds the line's last word
  (what it is), packing words (set/pack/case/of…) and (…) ignored — "queen mattresses" is not "Comforter — Queen", "paper towel holders"
  not "Paper towels", "knife sets" not "Sheet sets" — or by a taught alias (`inventory_receipt_aliases`). The rest are questions (the 3
  closest as buttons, **Another item…** = a modal with every item, **+ New item** modal, ✕ Drop); nothing alike = **Not in Kaizen yet**,
  grouped: **+ Add all as new items…** (one form, ≤45: name and type per line, both guessed — `itemName`, `guessKind` by the last noun,
  `guessMeasure` from "sets of"/"pack of") or ✕ Drop them. Settled lines are a numbered text list with one **Change a line…** menu.
  **A pasted list** (owner, same day — a new unit's 58-line setup under a paragraph): the mention's own lines are kept (`parseMention`
  joins words with spaces, so the handler re-reads `commentFromMention`), one item per line, prose lines skipped and counted ("2 lines of
  text were not read as items"); one line is split at , ; + and y &. ≤80 lines. The place is **always asked** (owner) unless the text names
  a storage/closet exactly; "para LP-4212" is said back and gives the new to-do its listing (the Repository says LP- where Hostaway says
  P2-). **▲ No place yet (new listing)** (`NO_PLACE`, owner 2026-10-15) saves the lines with no place — picked when bought in Kaizen. Store links via `cartLinks`. In a task's thread (incl. a cleaner's request / an inspection's order; a sub-task's → its parent) the
  lines go on THAT to-do's `inventory_orders`; a line already there at that place asks **Add → n / Replace → n** (owner). Otherwise a new
  to-do "Buy supplies: …" (`asOrder`; for the claim in a claim's thread; announced in the tasks channel like `@Kaizen new`). Who: **ops and
  up** (`/api/inventory` + `/api/todos` POST). The draft is a row of **`slack_order_drafts` (095)**; Confirm's value is its id; a message
  holds 50 blocks, so questions beyond what fits wait ("… and n more to answer"). Each click: read row → change → save → `chat.update`.
  Confirm once (`slack_sent` `order:<ch>:<ts>`), re-checks (to-do open, supplies not to a house), new items in ONE insert (`newItems`) and
  aliases in ONE (`learnAliases` batched) — Workers Free allows 50 subrequests a request; then the row goes and the message becomes what
  was saved + Open in Kaizen. "+ Purchase order" in the to-do offer opens the same draft. Before (§162) `order` made a line-less to-do.
  Tested on the owner's 58-line list (read-only, real items): 16 sure, 15 questions, 27 new, 2 prose lines skipped; 37 blocks.
- Costs (§117): `@Kaizen cost …` (button), `/kaizen cost …` and the help's **+ Cost** open
  `costModal` — what, amount, category, listing or shared, date, all required, prefilled from
  the words — and save to Costs → One-offs via /api/expenses as the member. Never at once.
- Cleans pop-up: each clean also says ↗ the stay leaving (guest, nights, guests, channel,
  total) and ↘ the next arrival (same day + time, or date + days empty; guest, nights, guests,
  total) — totals only for roles with `money` (§116). The board is read a week past the day.
- Task card and claim card (comments, Add comment with focus). Kaizen comments → thread.
- **A task message carries two buttons (§143)**: ✓ Complete and 💬 Comment (↺ Reopen when closed).
  ▶ Start went because the first comment now starts the work by itself (work module, §143), and
  "Kaizen ↗" because it opened the app's front door, not the task. The task pop-up (`taskCard`)
  dropped ▶ Start too — its own comment box is the same door. ▶ Start still exists in the ⋯ menu of
  `/kaizen tasks` and the "Manage" pop-up (`start:` / `task_start`), where no comment box is on screen.
- **Cleans' daily thread (§134, §136)**, event `cleanThread` (**ON since 2026-10-12** → #kaizen-ops): the
  clock posts the day's message at the morning reminder's hour (team time, until 20:00; `slack_sent`
  `cleanday:<date>`) with EVERY clean of the day — board checkouts + manual MAN- cleans, cleaner or
  "▲ nobody yet", time — kept in `clean_slack_posts.cleans` (064) and re-drawn as they progress ("3 of 7
  done", 📷 before/after, ✅). A photo before the clock opens the thread with the title only; the clock then
  fills it in. **The thread is the day's whole record for Ops** (§136, the owner: Ops must know everything):
  every event on a clean is a NEW reply — 📷 photos (a batch: same person and stage within 15 minutes is one
  reply that grows, `photos:<key>:<stage>:<by>:<bucket>`), 🧴 what was taken from storage (or nothing),
  ⚠️🙋❓🛒 problems / needs / missing / bought (with urgency and the to-do #), 💵 extras, ✕ can't do it
  (with the reason), ✅ done / ↩️ reopened — from the cleaner's page and the helper link alike, the person
  first ("Luz (Karina and Marvin's team)"). Under it, under it one line per clean and stage ("📷 Timber
  Crest — AFTER: 4 photos · Luz, Ana · Open in Drive") **edited in place** as photos arrive, and a reply
  for each ✅ done / ↩️ reopened (a repeated "done" posts nothing). `clean_slack_posts` takes the row
  before posting (ts NULL) so two photos at once make one message. Runs in waitUntil; a Slack error
  never fails the report. Field to-dos (problems, needs with priority, "Check stock") are announced
  like app-created work.
- DMs to owners via People mapping.
- **Cleaners' channels (§134)**, `crewChannels` (**off by default**; Settings → Slack → 6): in each
  cleaner's own channel, in their language (`src/lib/crew-slack.ts`): **today's cleans at 09:00 and
  tomorrow's at 18:00** (team time, Central; windows until 13:00 / 23:30), only on days they have
  cleans, with the 4 steps recalled — the board is read once per pass (`crewpass:<kind>:<day>`, each
  cleaner `crew:<kind>:<day>:<name>` in `slack_sent`); and **their helpers' reports** from a clean's link
  (photos as one growing line per clean and stage naming each helper, what they took from storage,
  done/reopened, problems/needs with urgency, missing/bought) — **and their own (owner, 2026-10-14)**: photos (one growing
  line, `own:<key>:<stage>`), storage, done/reopened, problems/requests/missing/bought, 💵 extras, ✕ can't do it.
  A report with a to-do is that to-do's thread (`rememberThread`): the team's reply there is a comment (§153).
  "Send now" / "Preview" by hand still work.
  The cleaners' channels are **private**: only members see them. Creating one invites the cleaner AND
  whoever pressed Create (§136 — the owner made three, for Irene, Veronica and Karina and Marvin, and saw
  none; he was then added by hand); "👁 Add me" (`cleanerJoin`) lets anyone of the team join one.
  Michelle has no channel (not in Slack yet).

- **Reports (owner, 2026-10-15)** — bugs and requests about Kaizen itself. App: "Report / request" at the rail's foot
  (computer) and in the phone's More menu (`src/components/Reports.tsx`; More is now always shown). Slack: `/kaizen bug|request …`
  opens `reportModal`; `@Kaizen bug|fallo|pedir|request …` answers with `reportOffer` (Complete the report → modal, Send as is).
  `/api/reports` (every member, in `ALWAYS`): own reports, or all for who holds Settings, who alone changes status. Tables
  `reports`, `report_comments` (087); one photo kept in the row (bytea, resized in the browser, ≤1.5 MB), shown by `?photo=<id>`.
  Topic **`reports` → #kaizen-reportes** (C0C9EG8G2RY, private, Juan only for now). The card (`reportMessage`) has the status
  buttons; its thread is the report's (`slack_threads` subject `report`): a reply there is a comment, a comment/status in Kaizen
  is a reply there. Done / won't do → DM to the reporter (`reportDm`, DM mode respected). Server: `functions/_lib/report-slack.ts`.

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
- Tasks **created in Slack** (@Kaizen new, /kaizen task, shortcuts, message action, forms) post
  no "To-do created" notice: `Kaizen.todo()` sends `via: 'slack'` on create (§119). Work created
  in the app or pulled from Hostaway is still announced. Assignment DMs are unchanged.
- `@Kaizen new`'s task thread is the mention's thread (no channel notice since §119).

## Open items

- **Waits (audit + fix, 2026-10-15).** Pages analytics: every `scriptThrewException` at 13:00 UTC (8 AM Central) and
  20:00 UTC (3 PM) used exactly 50 subrequests — Workers Free's cap (each Neon query, Slack, Hostaway, Google call counts);
  once over, even a `catch`'s DELETE throws, so claims stayed held (cleans' thread at 09:35 on 10-14, 08:50 on 10-15).
  `@Kaizen all` (57 s, killed — a waitUntil has 30 s) and `@Kaizen help <q>` (Gemini hung, no timeout) left nothing / "Looking…".
  Fixed: **the clock does one heavy job per tick** — reminders first; Host Notes, Hostaway's tasks pull and the Drive sync
  only on a tick that sent nothing; the cleans' thread never in the summary's tick. `today`/`all` post "⏳ Putting the day
  together…" and replace it within 15 s (or say it took too long); `help`'s "Looking…" is always replaced.
  **AI chain by tier** (`functions/_lib/ai-chain.ts`): `chat` (help, SOP keywords) = flash-lite 4 s → Workers AI 5 s →
  Claude Haiku 6 s, 15 s budget; `heavy` (receipts, carts, ✨ SOP from a thread with a 24 s budget) = configured Gemini 10 s →
  lite 10 s → Workers AI 10 s → Claude Sonnet 20 s. No retries; when the first choice failed, `by` says who answered and why (help: "↪ Answered by…"; receipts,
  carts, ✨ SOP already show `by`). Claude only with `accounts.claude_api_key_enc` (093,
  Settings → AI). Owner's rule: Claude key from prepaid credits, auto-reload off. Still open: Workers Paid ($5) would lift
  the 50 cap; `functions/_lib/gemini.ts` (pricing suggestions) has no timeout yet.

- **Cleans' thread missed 2026-10-15** (Concord had a clean): the 8 AM run claimed `cleanday:` and posted nothing, and the
  claim was never retried. Fix in `slack-cron.ts`: 0 cleans releases the claim; a claim with no `day:` message after 10 min
  is dropped and retried. The clock keeps no logs (`wrangler tail` is live only) — the 8 AM run's answer is lost.
- **Cleaners' reminders, same guard (2026-10-17):** a finished pass writes `crewdone:<kind>:<day>`; a `crewpass:` with no
  `crewdone:` after 10 min (a run killed at the 50 cap) is dropped and retried — each cleaner's `crew:` key keeps it to one
  message. Audit that day: Oct 16 6 PM sent to Irene, the only cleaner with an Oct 17 clean — nothing was missed.
  Still by design: a clean assigned after the pass ran is not in that evening's message.

- Reports: SOP 8 "Kaizen in Slack" not yet updated for `/kaizen bug` / `@Kaizen bug` (the in-Slack help is).


- Manifest with §157 + 📎 is installed (reactions:read verified, 2026-10-14).

- **§152/§153 need a manifest reinstall to take effect.** Code is deployed, but Slack only sends
  `message.channels`/`message.groups` once the app's manifest is updated and reinstalled: Settings →
  Slack → "Show the manifest" → copy → Slack → the app → App Manifest → paste → Save → Reinstall to
  Workspace (token stays the same). Until then, mention replies are already public (§152, no manifest
  change needed), but a plain thread reply still is not saved as a comment (§153).

- **Cleaners' channels built, off (§134).** No cleaner has a channel in production yet: Settings → Slack →
  6 → their Slack email → Create channel, then tick the reminders / helper notices and Save. Tested on
  the Neon branch with K&M's channel pointed at #kaizen-task.

- **Cleans' thread on (§136).** Still to do: add it to SOP 8 "Kaizen in Slack" (the owner's to approve —
  a step was proposed). The bot gained `channels:history` in §144 (to prune stale buttons off old
  messages, public channels only) — nothing today reads a thread with it; still not needed.

- Clock moved to Cloudflare (2026-10-07) after GitHub sent the 8 AM at 12:19 PM and missed a
  check-out. Verified: runs every 5 min, 200, sends only what is due. Wrangler is logged in as
  jdgonzalezp2014@gmail.com (account d217bb2fee2ba40210af9e0dee4d45c2, Pages project `kaizen`).
- Hostaway AI escalations: no API; plan = notification email → Kaizen → task. Waiting for a
  sample email / rule screenshots. Nothing built.
- Offered: Slack Home tab.
- Threads exist only for messages posted since §107 (or tasks made from a message).

## History

§99–§102, §107–§117, §119, §134, §152, §153, §157, §162.
- **Orders closed unbought (§150, operations):** ✓ Complete on a cleaner's or an inspection's request with no purchase
  recorded opens `unboughtModal` (callback `task_unbought`; views.open from a message, views.push inside the Tasks
  pop-up): a link to record the purchase in Kaizen, or a required reason → `/api/todos` done with `closeReason`.
- **The task card does what Kaizen does — phase 1 (owner, 2026-10-13):** `taskCard` shows the claim (⚑), the purchase order
  (item × qty from `inventory_orders`), each sub-task with a ⋯ menu (`card_sub`: ✓ Complete / ✕ Cancel / ↺ Reopen, the card
  stays on the parent), ✕ Cancel beside ✓ Complete (`card_cancel`; an unbought request asks why via `unboughtModal`), an
  "Add a sub-task" box next to the comment box (submit "Save" does either or both; not on a sub-task's own card) and the
  activity log's last 3 lines. Same card for to-dos and work orders. Next phases (owner's list): edit fields from the card
  (status/priority/owner/date/listing/claim link — ✎ Edit covers part), "Bought" for an order, claims' own work list.
- **What is opened from a thread lives in that thread (owner, 2026-10-13):** `threadFor(subject, id)` = its own thread, else
  its parent's (sub-task), else its claim's (claim work). `commentToThread` uses it (comment says "on *<sub-task>*");
  `notifyTask` posts a sub-task's events (➕ created ✓ ✕ ↺ 🙋) as a line in the parent's thread, and a claim's task's
  events as its full message in the claim's thread — no new channel message/thread. Sub-task creation now notifies
  (before: silent). `@Kaizen new` inside a task's thread → a sub-task of it; inside a claim's → a to-do for the claim
  (via `slack-thread`: no second notice); its listing defaults to the parent's/claim's. Order saved / bought on a to-do
  → a line in its thread (`/api/inventory` todoOrder / purchase).
- **Claim card = the claim in Kaizen:** its work (each "Open" → `claim_task_open`, the task card pushed on top) and an
  "Add a to-do for this claim" box (submit "Save" does comment and/or to-do; the to-do is told in the claim's thread).
- **Repairs too:** the task card also has "Add a 🔧 work order under it" (`subrepair`), the claim card "Add a 🔧 repair for
  this claim" (`repair`) — same rules (told in the thread they came from).
- **Cleaners' reminder ON, evening only (owner, 2026-10-13):** `crewChannels` = { reminders: true, morning: '' (off), evening:
  '18:00', helperNotices: false } — tomorrow's cleans at 6 PM Central in #cleaning-irene, #cleaning-veronica,
  #cleaning-karina-and-marvin. An empty time = that reminder off (`dueCrewReminders`, Settings → Slack). No new scopes.
- **Files from Slack onto the to-do (owner, 2026-10-13):** a to-do made by `@Kaizen new` / the offer's "+ New to-do" gets the
  source message's files (event `files`, else read back with `conversations.replies`); files posted in a to-do's thread
  (mention or plain reply, `subtype: file_share` allowed) go onto it. Done after the answer (`attachFromSlack`, waitUntil),
  then "📎 n files added…" in the thread. **Needs `files:read`** (added to the manifest — reinstall). `task:` with a colon
  now parses as `task` (Derek's to-do kept "task:" in its title).
- **Manual cleans in the cleaners' reminders (owner, 2026-10-14):** the board only lists checkouts, so `remindCleaners` also reads
  `cleanings` `MAN-%` (assigned, not voided, that day) — a mid-stay one says "🧹 mid-stay clean" instead of "checkout <time>".
  Irene's mid-stay at CL2450 was missed on the 14th's 9:18 reminder (morning turned on by the owner that day, 09:18).
- **Ready-by in the cleaners' reminders (owner, 2026-10-14):** never "no check-in" (cleaners went late). Each clean says
  "⏰ ready by <next guest's check-in>" when a guest arrives that day (early check-ins show), else "ready by 4:00 PM";
  after a late checkout (1 PM or later) with no arrival that day, nothing; a mid-stay, nothing (`readyBy`, `src/lib/crew-slack.ts`;
  the check-in time from the board's `in` row in `cleanerSchedule`). "⚡ next guest the same day" went (the time says it).
- **Order at 8 AM (owner, 2026-10-14): the day's summary first, then the cleans' thread.** In `slack-cron` the digest runs before
  the `cleanday` block, and the thread waits while `digest:morning:<day>` is not sent — one hour at most, then it goes anyway.
- **📎 Attach files on the Manage cards (owner, 2026-10-14):** the task card and the claim card have a `file_input` (block `files`,
  up to 10). "Save" accepts files alone. After the answer (`Kaizen.attachFiles`, waitUntil): a to-do's go onto it (`todo_files`,
  Drive, activity line); a claim keeps no files, so they go to Drive (`toDrive`, field-reports folder) and a claim comment links them.
  The bot has `files:read` (checked 2026-10-14). SOP 8 not yet updated for it.
- **Tasks list: "More ›" opens the card (owner, 2026-10-14).** In Manage → Tasks and `/kaizen tasks` each row's ⋯ menu (open,
  complete, start, edit, remove) became a **More ›** button (`task_open`) that opens the whole task card, on top of the pop-up —
  a Slack ⋯ cannot act on a click. Start / Remove are no longer in the list (the first comment starts; ✕ Cancel on the card, or
  remove in Kaizen); `task_menu` handlers stay for messages already posted.
- **Purchase order from the task card (owner, 2026-10-14):** an open, top-level to-do's card (for roles with inventory POST) has
  "🛒 Add to the purchase order" — item (active items), place (`supplyPlaces`), how many (empty = 1, 0 takes it out). "Save" merges
  that line into `inventory_orders` via `saveTodoOrder` directly (not /api/inventory: it answers with the whole inventory, past Slack's
  3 s) and tells it in the to-do's thread. The options load alongside the card's reads.
- **§157 (2026-10-14):** "Add to…" in listened channels (`offerAddTo`, `addto_*` actions, `Kaizen.addMessageTo`);
  SOPs from Slack (`newsop`/`sops` mention verbs, `/kaizen sop|sops`, `sop_from_message`, `sop_save`, `sops_section`,
  `sop_view`, `sop_suggest`, `@Kaizen help <question>` → `helpFromSops`); the AI chain (`functions/_lib/ai-chain.ts`, Gemini → flash-lite → Workers AI `[ai]`).
- **Clean photos in Drive: admins + each cleaner (owner, 2026-10-14).** The root "Kaizen — clean photos" was "anyone with the
  link"; now `functions/_lib/clean-access.ts`: link access off, members with role admin get writer on the root, each clean's
  folder is shared (reader, no Google email) with its cleaner's email (`cleaners.email`) when it is made (`addPhotos`).
  `syncCleanPhotoAccess` does all at once (run 2026-10-14). Every Kaizen member gets the root: admins writer, the rest
  reader (owner, same day: Derek, Amanda, Laura, Juan, Shannon).
  A cleaner's channel photo line now has "Open in Drive / Abrir en Drive" (`folderUrl`, from the clean's `drive_folder`).
- **All of Kaizen's Drive folders to the team (owner, 2026-10-14):** "a task's file would not open". `syncTeamDriveAccess`
  (`functions/_lib/clean-access.ts`) shares every root — clean photos, field reports (to-do files, orders, field reports),
  inspections, crew extras — with the members (admins writer, the rest reader; cleaners/handyman are not members), and takes
  "anyone with the link" off; when a root is made, and once a day from the clock (`drivesync:<day>`). Not the Repository's
  folders or guests' documents.
- **Missing scopes are said in Settings (2026-10-14):** `GET /api/slack-settings` returns `grantedScopes` (auth.test's
  `x-oauth-scopes`); Settings → Slack → 1 compares them with the manifest and warns "⚠ the installed app is missing …" with
  the steps — a reinstall from a stale manifest (an old page) had left 📎 without `reactions:read`.
- **SOPs updated (2026-10-14):** #34 "Add Slack messages to Kaizen and write SOPs from Slack" published (final behaviour);
  #8 "Kaizen in Slack" — More ›, the card's files and order, help with a question, sops/newsop, Add to… and 📎.
- **DM to Kaizen = the commands without the @ (owner, 2026-10-14):** `message` events with `channel_type: 'im'` → `dmMessage`:
  a reply in a thread Kaizen knows → `threadReply` (comment); else `mention(…, dm = true)` — answers in the DM itself
  (no per-question thread), "private" answers posted plainly. A to-do made from a DM (`new …` or the form) is
  `via: 'slack-dm'` → announced in the tasks channel like app work, and the DM is NOT remembered as its thread.
  **Needs in the Slack app:** bot event `message.im`, scope `im:history`, App Home → Messages tab on +
  "Allow users to send … messages from the messages tab"; then reinstall.

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only (Settings → Slack, `SlackPanel.tsx`); tokens and shared components from `docs/design-system.md`.
The messages Kaizen posts to Slack keep their emoji — they are Slack copy, not this app's UI
(`src/lib/slack*.ts`, `crew-slack.ts`, `sms.ts` untouched).
- Emoji in the panel's copy → one-colour icons (phase 0b); a label with an icon in it stays one line of text
  (`ic()` returns one inline span — loose pieces became columns inside `label.check`).
- Checkboxes no longer shrink beside a two-line label; a card's title (h2) outranks its numbered steps (h3).
- **§162 — one message per new item, the rest in its thread (owner, 2026-10-15).** `notifyTask`/`notifyClaim`
  (functions/_lib/slack.ts): created/opened = one channel message (its thread); later events = `threadLine` reply with who
  + `chat.update` of the first message. Every status change is told (`'status'`). Slack-made work outside the tasks
  channel is announced there too (`quickCreate`). `@Kaizen order …` / "+ Purchase order"; 💲 Upsell for upsell kinds;
  "Open in Kaizen ↗" (`kaizenButton`, `/?todo=` `/?claim=` deep links). (`@Kaizen order` became a draft with lines, 2026-10-15 — above.) Money left Slack's claim form and card (Finance's).
  Not yet seen in the real workspace — first real event will show it; check #kaizen-ops after the deploy.

- **§164:** a field report's #kaizen-ops message asks "⚑ How urgent is it?" (and ops privately in the cleaner's channel, `askOpsPrivately`) (`urgencyAsk`: `task_urgency_<p>`, `task_make_repair`) until
  answered; the answer is a thread line (`TaskEvent 'urgency'` / `'kind'`) and the message is redrawn without it.
