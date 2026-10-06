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

## Tables

`todos` (kind, status, priority, assignee/supervisor user ids + names, unit_ids (one),
scheduled_on/start_time, due_on/due_time, vendor, cost_estimate, cost_actual, resolution_note,
parent_id, claim_id, reservation_id/label, charge_owner, hostaway_task_id, hostaway_state,
hostaway_expense_id, deleted_at), `work_updates` (subject task|claim; kind `note` = comment,
others = activity log), `claims` (case_url, reservation, deleted_at), `hostaway_users`,
`expenses` rows with `source='repair'`.

## Rules that bite

- Hostaway's task model (§94): status pending/confirmed/in_progress/completed/cancelled;
  priority none/low/medium/high/urgent = null/1/2/3/4 (**scale unverified** — flip in
  PRIORITY_NUMBER); one listing per task; owner/supervisor = Hostaway users; times NY → UTC.
- Owners are optional (days off, shifts) — never shown as "no owner".
- Sub-tasks one level; removing a parent removes its sub-tasks with one stamp; restore
  brings back exactly those (§78, §82).
- Comments (`note`) vs activity log (system lines, pop-up) (§103). Open task: description →
  comments → Details (folded, summary) → sub-tasks; sticky "Unsaved changes" bar; ✎ rename
  in place; row actions Cancel / ✓ Done / ↺ Reopen (§104, §105).
- Hostaway mirror is **ON**: every change pushes after the response; the pull applies only
  fields that moved there (`hostaway_state`); removed here = cancelled there; tasks typed by
  hand in Hostaway come in as to-dos (§93, §94).
- A completed repair with a cost is always an expense in Costs › Repairs (`settleRepair`);
  "Charge to owner" also writes a Hostaway expense (negative amount) (§95).
- A claim is a case: `occurred_on` never moves; soft delete with undo; open cases first;
  can stand alone (late checkout) (§46, §77, §86).
- Times in timelines and the done log are New York (§87).
- Comments posted in Kaizen also go to the task's Slack thread (`commentToThread`, slack module).

## Open items

- Verify Hostaway's priority order in its UI.

## History

§46, §76–§78, §82–§88, §93–§95, §103–§105.
