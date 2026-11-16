# Design: Kaizen reports (bugs + requests) — BUILT 2026-10-15

The original design, kept for reference. What was built and how it works now: `docs/modules/slack.md` (Reports).
Decisions taken: the full list is for whoever holds Settings; reports never become Work tasks; channel #kaizen-reportes (private).
The Slack verbs also accept fallo / pedir / request.

## What a report is
- Type: **Bug** / **Request** (something new or a change).
- What happened or what is asked (text), optional photo/screenshot, urgency (low / normal / blocking).
- Captured automatically: who, from where (screen + sub-tab, or Slack channel), device.
- Status: New → Seen → In progress → Done / Won't do, with comments.

## In the app
- **PC:** fixed button bottom-left, one-colour icon from `Icon.tsx` (no emoji), label "Report".
- **Mobile:** "Report / Ask for something" entry inside the menu.
- Both open the same form, with the current screen prefilled.
- **Reports list:** owner/admin only (Settings or its own tab), filter by type and status, change status there. Each person sees their own under "My reports".

## In Slack
- `/kaizen bug` opens the same form as a modal.
- `@Kaizen bug <text>`: a mention event has no `trigger_id`, so it cannot open a modal directly. Kaizen replies in the thread with the text prefilled and a "Complete report" button that opens the modal; "Send as is" saves it in one click.
- `@Kaizen pedir <text>`: same, with type Request.

## Channel #kaizen-reportes
- Each new report is posted there as a card: type, who, where, text, photo, status buttons.
- The thread works like task threads: a reply adds a comment to the report; a status change in the app posts a reply in the thread.
- When it becomes Done, the reporter gets a DM.
- Creating the channel from the bot needs an extra scope (`channels:manage`) and reinstalling the app. Recommended: create it by hand and pick it in Settings → Slack as one more event.

## Internals
- New table `reports` (migration 087), API `/api/reports`, threads registered in `slack_threads` like tasks.
- Update the slack (or platform) module doc and SOP 8.

## Open decisions (owner) — resolved, see the top
1. Who sees the full list: only the owner, or the client's admins too?
2. Can an approved request be turned into a Work task, or does it stay separate (items for the developer)?
3. Channel name: #kaizen-reportes, or another?
