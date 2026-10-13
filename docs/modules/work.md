# Module: work (tasks, repairs, claims)

One backbone for the team's work: to-dos, 🔧 repairs (work orders) and ⚑ claims. Shown on
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
- A completed repair with a cost is always an expense in Costs › Repairs (`settleRepair`);
  "Charge to owner" also writes a Hostaway expense (negative amount) (§95).
- A claim is a case: `occurred_on` never moves; soft delete with undo; open cases first;
  can stand alone (late checkout) (§46, §77, §86).
- Times in timelines and the done log are New York (§87).
- Comments posted in Kaizen also go to the task's Slack thread (`commentToThread`, slack module).
- **Handymen work like cleaners (§137).** Three ways, all valid: an account (their email in Operations →
  Vendors, signed in through Access → role `vendor`, only `/api/vendor`: their work orders), a link
  ("📤 Send to vendor" in an open work order → `/report#w=…` by WhatsApp/SMS, no account), or none
  (the team runs the repair itself). The link needs a vendor and a day set; it lasts until the day + 7,
  dies if the vendor changes, the order is closed or deleted. Steps: 1 accept the day / "can't" →
  status back to pending, a high-priority sub-task "Reschedule — X can't on <day>: why" and the link
  closes; 2–3 photos before/after (Drive, first before = in progress); 4 charges (labor / materials,
  amount, what for, receipt); 5 done (resolution note); a note any time. Every step is a work_update
  and a reply in the task's Slack thread; pushWork when the mirror is on.
- **The access (codes, lockbox, Wi-Fi) shows only on the day set and while the order is open.**
- **No preset prices.** A handyman's charge is a pending `field_expenses` row (source `vendor`);
  approving it in Operations → Cleaners sets `cost_actual` = the sum of approved charges and runs
  `settleRepair` → Costs › Repairs (once completed). Denying needs a note the handyman reads.

## Open items

- §132: 16 to-dos are done (or cancelled) in Kaizen but still open in Hostaway — they changed in Kaizen
  while unlinked: #19 #20 #21 #25 #27 #28 #30 #33 #34 #35 #37 #38 #39 #40 #43 #44. The owner said leave
  them; syncing would be a Hostaway write (pushWork each). #33's comment says the couch is not rescheduled.

- Verify Hostaway's priority order in its UI.
- §137: a vendor who signs in needs their email in the Cloudflare Access policy (the link needs nothing).
  Vendors have no Slack channel and get no reminders yet; the team sends the link by hand.

## History

§46, §76–§78, §82–§88, §93–§95, §103–§105, §120, §132, §137.

- **+ 🛒 purchase on a to-do (§150, operations module):** an open top-level to-do can record what was bought for it
  (inventory stock per place + one Restock expense) and close, or save its order as sub-tasks — `TaskPurchase` from
  `src/screens/Inventory.tsx`, beside "+ sub-task / + 🔧 work order" in `TodoRow`.
- **Sub-tasks folded in the list (§150, owner):** under a task they no longer show open; "▸ ☑ n/m" on its row
  opens them (`kidsShown` in `TodoRow`). Open the task for the full sub-task section, as before.
- **Closing an unbought cleaner request asks first (§150):** `TodoRow`'s ✓ Done / Cancel on a `cleanGroup = 'request'`
  to-do with no `purchases` opens a Modal (record the purchase / keep open / close with a reason, posted as a note).
