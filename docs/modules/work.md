# Module: work (tasks, repairs, claims)

One backbone for the team's work: to-dos, 🔧 repairs (work orders), 🛒 purchase orders and ⚑ claims & upselling (§162). Shown on
Home (summary) and Operations → To-do (lanes, filters, done log); claims also on **Claims**.
Cleans are not tasks (operations module).

## Files

- `src/components/Todos.tsx` (TodoRow, TodoForm, lanes, ClaimCase, WorkView, done log,
  Timeline, PersonPick), `src/components/Modal.tsx`, `src/screens/Claims.tsx`.
- API: `todos.ts` (create/update/done/note/delete/restore/toClaim, Hostaway pull),
  `claims.ts` (CRUD, note, soft delete, restore), `stays.ts`.
- Server libs: `hostaway-tasks.ts` (mirror, pullAll, people), `repair-costs.ts` (settleRepair).
- Pure libs: `src/lib/todos.ts` (sort, filters, tree, progress, auditCsv, nyParts),
  `hostaway-tasks.ts` (PRIORITY_NUMBER, mapping), `claims.ts` (categories, sources, caseHost).
- Handymen (§137): `src/screens/Work.tsx` (WorkLinkPage, VendorHome, WorkCard), `VendorLink` in
  `Todos.tsx`; API `vendor.ts` (signed-in handyman), `report-link.ts` (`X-Work-Token`), `todos.ts`
  action `vendorLink`; server lib `vendor-work.ts` (workPage, workAct, workLinkFor, workOfToken);
  charges go through `field-costs.ts` (operations module).

## Tables

`todos` (kind, status, priority, assignee/supervisor user ids + names, unit_ids (one),
scheduled_on/start_time, due_on/due_time, vendor, cost_estimate, cost_actual, resolution_note,
parent_id, claim_id, reservation_id/label, charge_owner, hostaway_task_id, hostaway_state,
hostaway_expense_id, vendor_accepted_at/by, deleted_at), `work_links` (one secret link per work order:
vendor, token_enc, token_hash, expires_on), `work_photos` (before/after, Drive url), `work_updates` (subject task|claim; kind `note` = comment,
others = activity log), `claims` (case_url, reservation, deleted_at), `hostaway_users`,
`expenses` rows with `source='repair'` — for a work order AND (§137) any to-do completed with a cost
(category Repairs / Restock for "Buy…" / the title's category).

## Rules that bite

- Hostaway's task model (§94): status pending/confirmed/in_progress/completed/cancelled;
  priority none/low/medium/high/urgent = null/1/2/3/4 (**scale unverified** — flip in
  PRIORITY_NUMBER); one listing per task; owner/supervisor = Hostaway users; times NY → UTC.
- **The first comment starts the work (§143):** a comment on a `pending` or `confirmed` to-do moves it
  to `in_progress` by itself (`/api/todos` action `note`, so from the app, a Slack thread or the task
  pop-up alike), writes the status line on the timeline and pushes it to Hostaway like any other status
  change. Nothing is posted to Slack for it. A vendor's first "before" photo already did this (§137).
- Owners are optional (days off, shifts) — never shown as "no owner".
- **To-dos from the field (§134)** are made by `functions/_lib/inventory.ts` (`newTodo`), not /api/todos:
  a problem or a need from a cleaner or a helper link ("Problem at <unit>: …", "Request at …") with the
  priority the reporter chose (urgent / high / low; medium otherwise), "Check stock: …" (medium) when
  something is reported missing, and "Buy supplies: …" (one to-do, a sub-task per line) from Inventory.
  `mirrorTodos` announces each in Slack's tasks channel (`taskCreated`) and mirrors it to Hostaway.
- Sub-tasks one level; removing a parent removes its sub-tasks with one stamp; restore
  brings back exactly those (§78, §82).
- Comments (`note`) vs activity log (system lines, pop-up) (§103). Open task: description →
  comments → Details (folded, summary) → sub-tasks; sticky "Unsaved changes" bar; ✎ rename
  in place; row actions Cancel / ✓ Done / ↺ Reopen (§104, §105).
- Hostaway mirror is **ON**: every change pushes after the response; the pull applies only
  fields that moved there (`hostaway_state`); removed here = cancelled there; tasks typed by
  hand in Hostaway come in as to-dos (§93, §94).
- Kaizen's tasks carry a footer "— Kaizen OS · To-do #N" — ALONE when the description is empty
  (the body is trimmed). `isKaizens` / `kaizenIdOf` / `coreOf` match it anywhere at the end; the pull
  never imports such a task, and re-links it to to-do #N if #N lost its link (§132).
- **Never a second Hostaway task for one to-do:** `pushWork` first calls `recoverLink` for an unlinked
  to-do — its "Sent to Hostaway as task #N" note (verified with getTask + footer), else its listing's
  tasks — and updates that task instead of creating one. GET /tasks still fails (403); unit-less tasks are
  reachable only by id, which is why the note matters (§132).
- A completed repair with a cost is an expense in Costs › Repairs (`settleRepair`) — unless "Charge to owner":
  then it is only a Hostaway expense on the listing (negative amount), the owner's cost, not Kaizen's (§95, §167).
- **A case's money is the team's (§167):** Requested (an estimate) and Received are entered on the case
  (`/api/claims` action `money` → `saveCaseMoney`, functions/_lib/claim-money.ts; Finance corrects the same through
  `/api/claims-money`). Received is dated `received_on`. Statuses Open / In progress / Resolved / **Paid** / Dismissed:
  closed with money = Paid, Paid needs money (`checkClaim`). Repair work = view `claim_work`; result = `caseResult`
  (owner's share when the repair was charged to the owner). A closed case keeps its `resolved_on` on edits (`closeDate`).
  On the case: once money came in, a green **Close as Paid** button; while nothing came in, a quiet **Dismiss…** link beside
  Remove (asks why when money was requested; the reason goes to the timeline as "Dismissed: …") (2026-10-27).
- A claim is a case: `occurred_on` never moves; soft delete with undo; open cases first;
  can stand alone (late checkout) (§46, §77, §86).
- Times in timelines and the done log are New York (§87).
- Comments posted in Kaizen also go to the task's Slack thread (`commentToThread`, slack module).
- **Handymen work like cleaners (§137).** Their own page by link too (owner, 2026-10-25, §168): Operations → Handymen →
  "Copy their link" = `/crew#v=<token>` → `/api/crew-link` with `X-Vendor-Token` (`functions/_lib/vendor-door.ts`, same page as
  `/api/vendor`); `vendors.link_token_hash` finds them, `link_token_enc` lets the team copy the same link again. Three ways, all valid: an account (their email in Operations →
  Vendors, signed in through Access → role `vendor`, only `/api/vendor`: their work orders), a link
  ("📤 Send to vendor" in an open work order → `/report#w=…` by WhatsApp/SMS, no account), or none
  (the team runs the repair itself). The link needs a vendor and a day set; it lasts until the day + 7,
  dies if the vendor changes, the order is closed or deleted. Steps: 1 accept the day / "can't" →
  status back to pending, a high-priority sub-task "Reschedule — X can't on <day>: why" and the link
  closes; 2–3 photos before/after (Drive, first before = in progress); 4 charges (labor / materials,
  amount, what for, receipt); 5 done (resolution note); a note any time. Every step is a work_update
  and a reply in the task's Slack thread; pushWork when the mirror is on.
- **A repair's items go like cleans (owner, 2026-10-27).** A work order holding work-order items is their folder: no
  link of its own (`workLinkFor` refuses — its text lists every item), not a card on the vendor's page, not a job in their
  pay unless it carries a cost. Its editor shows **Give <vendor> the items?** (`GiveItems` in Todos.tsx → `todos.ts` action
  `giveItems`): all open items ticked except those with another vendor; the vendor is written on each item, never
  inherited, so "all but this one" survives a later change. An item with no day or listing of its own uses the repair's
  (`workRow`). Another vendor without an account → that item's own Send to vendor link.
- **What to fix shows the finding's photos (owner, 2026-10-27).** A work order's "Photo:" lines (an inspection's) are
  drawn as big photos, open by default (`WhatToFix` in Work.tsx). Drive is the team's, so every door serves them:
  `?work=<id>&photo=<Drive id>` on `/api/vendor`, `/api/crew-link` (X-Vendor-Token), `/api/report-link` (X-Work-Token)
  and `/api/vendor-admin?view=vendor` → `workPhoto` (vendor-work.ts): only a file that work order's description names,
  only on a work order of theirs. **View as handyman ↗** (Operations → Handymen, `#as-vendor/<name>`) = their page from
  `/api/vendor-admin?view=vendor`, buttons save nothing — as §122's View as cleaner.
- **The handyman's page is by house (owner, 2026-10-27):** a sticky island on top (name, Work orders / Pay, EN/ES, night);
  a carousel of houses (jobs, soonest day, how many to accept); a house (`?house=<unit>`, back returns) opens a carousel of
  its jobs, one per screen, pager on top. `VendorHome`, `byHouse`, `Carousel` in Work.tsx; CSS `.v-*`. The one-job link
  page (`WorkLinkPage`) is unchanged.
- **The handyman's Slack (owner, 2026-10-27: "simpler"):** one line when new work reaches them ("New job at <house>: …",
  or "N jobs new at …") and a morning summary from 8 team time ("N jobs open in M houses — house n · … · k today"), each
  @-mentioning them, with their page link. Builders `src/lib/vendor-slack.ts` (tested); senders `functions/_lib/vendor-slack.ts`
  (`tellHandyman` after a work order made with a vendor / vendor changed / Give items; `handymenDay` in slack-cron,
  `slack_sent` key `handyday:<name>:<day>`). Channel per handyman in `slack_config.handymen` — Operations → Handymen →
  Slack channel: an existing one by name (Tim's is #handyman, shared with the team) or a new #handyman-<name>.
- **A handyman asks to approve other work (owner, 2026-10-27):** their page → "＋ Ask to approve other work" (house, what,
  estimate, photos) → `vendorPost` action `request` → `workRequest`: a work order with NO vendor, `created_by` "<name>
  (handyman)", told to the team as new work. The team's editor shows **Approve for <name>** (= vendor set → their Slack
  line, their page) or **Decline** (= cancelled). Their page lists theirs waiting, and declined ones for 14 days.
- **Upcoming and Past on the handyman's page (owner, 2026-10-27):** island tabs Jobs · Upcoming · Past · Pay. Upcoming = open
  jobs by day (late ones marked, no day last); a row opens the job in its house's carousel. Past = jobs finished in the last
  90 days (`vendorPast`, vendor-pay.ts: `vendorJobs` + payouts in one query): what was done, pay as on the invoice, charges,
  team notes, Paid/Not paid yet. **＋ Add an extra** = a charge on a finished job (workAct allows `charge`/`note` on a
  completed job from their own page only; the one-job link closes with the job). If that job's invoice is already paid,
  `extraJob` (vendor-door.ts) puts the charge on a new completed work order "Extra — <job>" dated today, so it is paid with
  the open invoice — payouts are one per invoice and never re-paid. The jobs page now lists open jobs only (`mine(…, true)`);
  their actions accept jobs finished in the last 90 days.
- Migration 103 re-adds `vendors.link_token_hash/enc`: 099 was applied before those lines were added, so handymen's
  own-page links ("Copy their link", `/api/crew-link`) failed in production until 103 runs.
- **The access (codes, lockbox, Wi-Fi) shows only on the day set and while the order is open.**
- **No preset prices.** A handyman's charge is a pending `field_expenses` row (source `vendor`);
  approving it in Operations → Cleaners sets `cost_actual` = the sum of approved charges and runs
  `settleRepair` → Costs › Repairs (once completed). Denying needs a note the handyman reads.
- **The pay check (owner, 2026-10-28, §171, migration 104 `todos.pay_check`).** A handyman's job done — completed, a vendor,
  on the pay, with charges waiting or no price — gets ONE open sub-task **"Validate pay — <vendor>: …"** under its top-level
  work (a repair's items share the repair's; sub-tasks are one level). `syncPayCheck` (functions/_lib/pay-check.ts) makes it,
  refreshes its title/lines, and closes it by itself when nothing waits; it runs after every change in every door: `settle`
  in todos.ts, `settleWork` + a late `charge` in vendor-work.ts, crew-admin `decideField`, vendor-admin's `settle`/flag, the
  Hostaway pull. Completing it (`/api/todos` done/update, Slack too) = `validatePay`: approves every charge waiting
  (decideFieldExpense, note "Validated with the pay check #N") and settles each job → cost, invoice, Costs. **Refused (409
  `pay_check`)** while a job is ⚑ flagged (`pay_flag_note`) with charges waiting, or a job has no price. A partial unique
  index keeps one open per parent. Pay checks are listed in Tasks too ("Part of ›") — the job is often closed already.
  Builders `payCheckTitle/Text/Block` in src/lib/vendor-pay.ts (tested). Nothing is approved without the team.
- **The estimate follows the handyman's price (2026-10-28):** `addFieldExpense`/`decideFieldExpense` (vendor) set
  `cost_estimate` = their charges not denied, only while it still equals what the charges said before (or is empty) — an
  estimate the team typed, or the handyman's own in a request, stays.
- **The handyman's work, audited (2026-10-28):** an open work order or pay check shows **Handyman's work / To validate**
  (`WorkProof`, src/components/WorkProof.tsx): per job status, estimate, cost, photos before/after (`WorkPhotos`), charges with
  receipts, Approve/Deny (`ChargeDecide`, shared with Handymen), ⚑ Flag. Data: `/api/todo-files` GET now also returns
  `work` (`workProof`). Operations → Handymen rows show the job's photos (`vendorJobs` reads `work_photos`). Photos load
  through `/api/comment-image`, which now also serves a Drive id named by `work_photos` or a vendor charge's receipt.

- **A handyman's pay (§168):** `todos.pay_fixed` = a pay the team set (Operations → Handymen) — `decideFieldExpense` then keeps it
  (`coalesce(pay_fixed, sum approved)`); `todos.pay_void` = not paid → `settleRepair` treats it as not spent (out of Costs and, if charged
  to the owner, off Hostaway). `pay_flag_note` is the note the handyman reads. Payouts per invoice: operations module.

- **Live work (§166).** `todos.rev` / `claims.rev` come from one sequence (`live_rev`), bumped by a trigger on every
  insert or update — any door, no code needed (migration 091). Open screens ask `GET /api/todos?live=1&after=<id>`
  every 10 s while visible (`src/components/useLive.ts`, one poller per page): two signatures (count + sum(rev), comment
  count + max id) and the new top-level to-dos by someone else (`fresh`) for the header bell (`LiveBell.tsx`). A changed
  signature reloads TodoList, Home's work chips and the board's flags. **Saves from an open to-do send only the changed
  fields + `baseRev`**; moved since → 409 `conflict` with the row now and who touched it last (the UPDATE also checks
  `rev`, so no race). The form merges three-way (`src/lib/merge.ts`): fields only one side changed are kept silently,
  same field both sides = a "Theirs / Yours" pick → Merge and save, or Cancel my changes. ✓ Done / ↺ Reopen with
  `baseRev` on something already there → 409 `already` ("Already done by X"). Without `baseRev` (Slack, field links,
  Hostaway pull, vendor pages) a save writes as before. An untouched open form takes others' changes at once.
  `fresh` also carries to-dos done/cancelled by someone else since the last answer (`event`; cursor `since` = the
  DB's `now()` from the previous answer, matched on `done_at`). A hidden tab still asks once a minute. The bell chimes
  (two Web Audio notes, `src/components/chime.ts`, no file) and, with permission and the tab hidden, shows a desktop
  Notification. Its gear (per browser, localStorage): events New / Done / Cancelled, sound on/off + volume + Test,
  desktop status (on / blocked → how to allow / Turn on). Browsers play nothing until the page has had a click or key.
  In the rail its panel is `position: fixed` beside the expanded rail — the rail's `overflow: hidden` clipped it.
- The Slack clock also runs `pullAll` every tick (its own 2-minute pace) so Hostaway-made tasks arrive without anyone
  opening a list (§166).

## Open items

- §171: migration 104 + `.sop-104.mjs` (SOP #4 v4) at deploy, then the backfill (estimates from Tim's charges + a pay
  check per job with charges waiting) — tested on a Neon branch (deleted).
  Check the first real "Validate pay" (#108 has two $30 charges for one dishwasher — maybe a duplicate).

- §167: reconciliation of received money with platform payouts / Hostaway — later, read-only, owner to decide.
  Claims #4 ($150), #7 ($200), #8 ($50) are with the platforms (2026-10-15).

- §166: claims are refreshed live but their edit form has no version check yet (last save wins, as before).
- §166: the bell's list lives in each browser (localStorage); no "seen" across devices.

- §132: 16 to-dos are done (or cancelled) in Kaizen but still open in Hostaway — they changed in Kaizen
  while unlinked: #19 #20 #21 #25 #27 #28 #30 #33 #34 #35 #37 #38 #39 #40 #43 #44. The owner said leave
  them; syncing would be a Hostaway write (pushWork each). #33's comment says the couch is not rescheduled.

- Verify Hostaway's priority order in its UI.
- §137: a vendor who signs in needs their email in the Cloudflare Access policy (the link needs nothing).
  Vendors have no Slack channel and get no reminders yet; the team sends the link by hand.

## History

§46, §76–§78, §82–§88, §93–§95, §103–§105, §120, §132, §137, §162, §167, §171.

- **+ 🛒 purchase on a to-do (§150, operations module):** an open top-level to-do can record what was bought for it
  (inventory stock per place + one Restock expense) and close, or save its order as sub-tasks — `TaskPurchase` from
  `src/screens/Inventory.tsx`, beside "+ sub-task / + 🔧 work order" in `TodoRow`.
- **Sub-tasks folded in the list (§150, owner):** under a task they no longer show open; "▸ ☑ n/m" on its row
  opens them (`kidsShown` in `TodoRow`). Open the task for the full sub-task section, as before.
- **Closing an unbought cleaner request asks first (§150):** `TodoRow`'s ✓ Done / Cancel on a `cleanGroup = 'request'`
  to-do with no `purchases` opens a Modal (record the purchase / keep open / close with a reason, posted as a note).
- **Home's To-do card is tabs (owner feedback, 2026-10-13):** Tasks · 🔧 Repairs · ⚑ Claims · $ Approvals · 🛒 Purchase orders,
  each with its count (▲ when something is late / waiting). Tasks and Repairs are bucketed **Now** (overdue, today or urgent)
  / **This week** (≤7 d or high) / **Later** (no date) / **📅 Scheduled** (due or starting >7 d out — the landscaping) — only the first non-empty bucket open, 5 rows then "Show more". Rows on Home have
  no checkbox: ✕ (cancel) and ✓ (done) at the right. A URL in a description shows as 🔗 (`Linked`). Approvals come from
  `getCrewAdmin` (review in Operations → Cleaners); purchase orders = `getInventory().orders` to-dos, moved out of Tasks.
  `TodoList` props `extraTabs` / `orderIds`. Operations → To-do uses the same tabs and buckets (no row cap; kind chips gone; no checkbox anywhere).
- **Purchase orders tab: comments on the row (owner, 2026-10-13):** each order has "▸ 💬 n / Comment" that unfolds its
  Timeline (read + post, same `note` action → Slack thread, §143 rule applies) without opening the to-do (`TodoRow` prop `chat`).
- **Work orders too:** the Repairs tab's rows also unfold their comments (`chatRow`), like purchase orders.
- **Files on a to-do (owner, 2026-10-13, migration 076 `todo_files`):** "📎 Files" in an open to-do — several at once
  (≤10, 15 MB each, any type), Drive (field reports folder, "to-do #N — name"), ✕ takes one off (Drive copy stays);
  activity line per add/remove. Row shows "📎 n". API `/api/todo-files` (GET ?todoId, POST multipart, POST remove; role
  `todos`). Server `functions/_lib/todo-files.ts` (attachTodoFiles, slackFiles, slackMessageFiles).
- **Hostaway task mirror OFF (owner, 2026-10-13):** `accounts.hostaway_tasks = 'off'` — the mirror cost most of the to-do
  list's Hostaway calls for little use. Links kept; the toggle is Operations → Setup → "Hostaway tasks" (owner will turn
  it back on later). While off, a test task no longer reaches Hostaway.
- **An open to-do reads its description (owner, 2026-10-13):** links show as 🔗 until "✎ Edit" opens the textarea; Slack
  permalinks are saved without their `?thread_ts…` query (1 old description shortened; #76 lost its "task:").
- **To-do rows, less crowded (owner, 2026-10-14):** the title on its own line with ✕ ✓ at its right (absolute), what describes
  it on the next (`.todo-break`); every row the same left edge (the red bar only says urgent), room between rows, a hover tint,
  groups spaced. A description that is only a link ("From Slack: 🔗") is not shown on the row. Same component in Home and Work.
- **Open to-do: Details on top, ✎ Edit (owner, 2026-10-14):** the empty description box was confusing — Details ("✎ Edit", no summary —
  the row already shows it) sits under the title; the description is read there when it has text and edited inside Details. Then files, comments, sub-tasks.
- **Opening a to-do (owner, 2026-10-14):** ▸/▾ before the title, and a click anywhere on the row's line opens/closes it
  (`todo-opener`; clicks on its buttons, links and fields are left to them).

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only; tokens and shared components from `docs/design-system.md`.
- A to-do's ✕ / ✓ (`.todo-quick`): one set of rules instead of three that overrode each other; 28 px circles
  on a desktop, 40 px on a phone (were ~24 px). Still faint until the row is pointed at (§105); always shown on touch.
- Work tabs (Tasks / Repairs / Claims / Purchase orders): selected = ink fill, the system's "selected"
  (was a blue tint — blue is reserved for actions). A tab with nothing in it is muted, not 60% opacity.
- Claims keep their shape + word for status; no change needed.
- Open: the urgent to-do rail is red (priority Urgent). Kept: the owner chose red for High/Critical
  severity on claims and urgent priority reads the same way; revisit if red starts to mean only "failed".

- **One anatomy and one life cycle (§159, owner 2026-10-14):** every work row = title line + one context line
  (`.todo-meta`) in a fixed order; the category is a 2 px bar (`cat-task/work_order/order/claim`); the description is
  behind a short source label (`sourceOf`: "Request from a cleaner", "From an inspection", "From Slack", "Details"; `Peek`
  in Hint.tsx). Stages from `stageOf`/`claimStage` (src/lib/todos.ts) — also used by Slack (`taskFacts`, `taskCard`).
  A child of another category (a work order in a to-do, an order in a repair) is listed in its own tab with
  "Part of ›" and inside its parent as a line that opens a pop-up (`openPop` → Modal with the whole card); same
  category stays nested. Listing and owner on a row filter the list (`filterBy`, `WorkFilter.assignee`), shown as
  a ✕ chip. The open card is a sheet (`task-sheet`, `fl-group`). Claims screen rows use the same anatomy.
  Bucket "Scheduled" renamed "Further out" (Scheduled is a stage now). No data or API change except Slack's words.
- **Round 2 (§159, owner 2026-10-14):** not-started reads **Open** (not "Scheduled"); completing a child moves an Open
  parent to In progress (server, `todos.ts` update — like the first comment, §143); timeline words follow (Open/Done).
  Titles drop the listing's name when the row shows it (`rowTitle`, display only). Sub-tasks always live inside their
  parent — only a work order or an order inside another kind is also listed in its own tab. "Show N more" is a full-width
  row. **Merge** (`action: 'merge', id, into`): comments, files, photos, children, order lines, purchases, moves,
  inspection checks and field charges move to `into`; the claim if it has none; the description is appended; the other
  is cancelled "Merged into #N" (Hostaway closes it). Refused into a closed one, into its own child, or children under a
  sub-task. **Not exercised against real data** (the Hostaway mirror is on) — try it first on two test to-dos.
- **Round 4:** not-started reads **New** (the owner's word: what the system made or someone just wrote is new).
- **Side panel instead of the accordion (owner, 2026-10-15, §160):** opening a to-do/repair/claim row shows its card in `SlideOver` (`components/SlideOver.tsx`, portal; 50 % wide on desktop, full screen on a phone) — the list never expands. Header: title, ✓ / ↺ Reopen, ⋯ (`Popover`: Register as a claim, Merge into…, Remove…), ✕. The comment box of `Timeline` is portaled into the panel's dock (`useDock`) so it stays at the bottom. A sub-task opens in place inside its parent's panel (`inPanel`, `NoDock`). Operations → To-do header is one row: one **Filters** popover (urgency, deadline, listing, owner; count badge) on the right. *(§163: the Open work / Done log switch is gone — see below.)* Home's card has `All ↗` back beside `+ Add`. Two draft SOPs from `scripts/seed-sops.mjs` inserted 2026-10-15: #36 Home, #37 side panel — **drafts, for the owner to publish**.
- **Summary / Edit (owner, 2026-10-15, §161):** in the panel an item is one summary line (`status • urgency • listing • dates • owner`) with `✎ Edit` to open the fields; each sub-task is a one-line row that opens only with its own `✎ Edit` (`inPanel`, `startEditing`). The panel header has `✓` (done) and `⋯` (done, cancel, claim, merge, remove — cancel is not one click); the panel closes with `Close →` (top right), Esc or the backdrop. The description is edited by clicking it. Files: size limit in an `ⓘ` tooltip, uploader/source in the file name's tooltip.
- **Claims & upselling (§162, owner 2026-10-15):** a case has `requested` and `refund` ("Received (refunded)") typed, and
  **Repair work** computed (work orders' cost/estimate + purchase orders' purchases; `/api/claims` `repair_work`, `workCost().bought`).
  Kinds grouped Claim / Upselling (`CategoryOptions`). Alterations are not upselling unless collected through the Resolution
  Center or unpriced on the reservation (SOP #3 v3). "+ Purchase order" inside a case. Purchase orders take sub-tasks.
  To-dos: no Kind switch, no Cost; a work order's Vendor / Estimate / Cost / Charge to owner are their own group.
  Slack thread replies keep their files in the comment (`📷 name: url` → shown via `/api/comment-image`), not in Files.
  Round 2: money moved to Finance — Operations sees a case's Repair work only; requested/received in Revenue → Claims &
  upselling (`claims.money`, `/api/claims-money`); the Claims nav tab is gone (cases live in Operations → To-do).
  Open: drop `claims.repair_cost` once this is deployed (migration 087).
- **Done log folded into Closed (owner, 2026-10-15, §163):** no Open work / Done log switch. `WorkView` passes `doneLog` to `TodoList`; its "Closed in the last 14 days" toggle, when open, shows chips *Last 14 days* (the rows, with ↺ Reopen) / *Done log* (`DoneLog`: From–to in sight, Kind / Closed by / Listing / Include removed behind its own **Filters** popover, Export CSV). The open-work **Filters** button now sits on the tabs' line after `+ Add` (the `work-bar` row renders only when there is a `lead` or no tabs).

- **§164 field work (owner, 2026-10-15):** field problems come in at medium flagged `urgency_pending` (migration 088, no sub-task); the team answers
  in Slack (⚑ buttons) or by setting the priority — urgent = today, high = checkout of the stay ahead (attached), via
  `applyUrgency` (functions/_lib/urgency.ts, `/api/todos` action `urgency`). "Make it a work order" in the ⋯ menu. `claims.repair_cost` dropped (087).
- **"Inside"'s guide line (owner, 2026-10-15):** `.todo-kids`' indent + `border-left` is a nesting cue for the flat board,
  where a kid row has nothing else marking it as nested. Inside the panel's "Inside" section it sat inside `.task-fold`
  — already a box — so the line read as a short stray segment, not attached to anything above or below. Zeroed for
  `.task-fold-body .todo-kids` (`index.css`); the board's flat view keeps the line.

## To-do rows and the open item (2026-10-15, owner)
Every lane (to-dos, repairs, purchase orders, claims) shares it. Row: title ✎ then a light-grey `!` whose hover is the
description ("Details" is gone); a stay is a bed icon on the meta line (guest · dates on hover, link to Hostaway).
Slack as a source is Slack's logo linking to the message everywhere — row, description (`From Slack: <url>` folds
into it), comment ends; the open item's "From Slack" eyebrow is gone. Open item: the summary is small chips (symbol +
few words: stage, priority, unit, dates, owner, vendor, cost, stay ↗), left-aligned, wrapping. Files are chips on one
row that slides sideways. Brand marks: `components/ChannelMark.tsx` (Font Awesome Free, CC BY 4.0).
