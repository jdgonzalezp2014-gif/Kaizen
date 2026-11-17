// Run once AFTER migrating 117 and deploying (owner, 2026-11-16): the Inbox's SOP with automations, channel tabs,
// the online check-in mark and the unanswered-guest watch. Updates the SOP .sop-116.mjs made (a new version), or
// creates it as a DRAFT if that one was never run.   node --env-file=.env.local .sop-117.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const BY = 'Kaizen OS (draft)';
const s = {
  title: 'Guest Services Inbox: answering guests, scheduled messages and the AI draft',
  section: 'guest', features: ['inbox'],
  purpose: 'Every guest gets a correct answer from one place, with the stay, its to-dos and what is scheduled in view — and the routine messages go on their own.',
  trigger: 'A guest writes (the conversation shows under "Needs reply"; Slack names a guest who has waited or something urgent), or a stay needs a message at a set time.',
  owner: 'Guest Services',
  doneWhen: '"Needs reply" is empty, and every to-do a conversation raised is on the stay.',
  steps: [
    { text: 'Guest Services → Inbox. "Needs reply" lists the conversations where the guest wrote last. Open one.', who: 'Guest Services' },
    { text: 'Read the thread and the stay on the right (dates, guests, paid / agreement / ID, online check-in, to-dos).', who: 'Guest Services' },
    { text: 'Pick the tab to answer by: All (the way the thread already talks), the booking channel (Airbnb, Vrbo…), Email, or SMS (Quo).', who: 'Guest Services' },
    { text: 'Answer: write the reply, or pick a Template, or press Suggest for an AI draft — read it, change it, then Send.', who: 'Guest Services' },
    { text: 'If the draft says "Needs a person", do not send it as an answer: decide the case (or ask the manager) and write the reply yourself.', who: 'Guest Services' },
    { text: 'If the guest needs something done, press + under To-dos: it is created in Operations → To-do for that listing and stay.', who: 'Guest Services' },
    { text: 'To send later, press Later, pick the time, then Schedule. It shows in the thread with a clock; Cancel removes it.', who: 'Guest Services' },
    { text: 'If the guest finished the online check-in outside the portal, press Mark done under Online check-in: the door-code message goes by itself.', who: 'Guest Services' },
    { text: 'Automations (the bolt, top of the inbox): the messages that go on their own — when, for which listings, on what condition — and the quick replies.', who: 'Manager' }
  ],
  body: `Conversations stay in Hostaway and SMS in Quo; the Inbox reads them and keeps only its own outbox.

## Rules
- If "Sending is off" shows → nothing written here reaches the guest; it is kept as Staged. Answer in Hostaway until it is turned on.
- If a message still has an empty {{blank}} → it cannot be sent; fill it in or remove it.
- If the guest asks for money back, reports damage or an emergency, or asks for an exception → a person decides; never send an AI draft as the answer.
- The door code is sent only by the automation "Door code after online check-in" → do not type a door or lockbox code in a reply.
- If a message shows "Not sent" → read the reason under it, fix it, then Retry.
- If a conversation has no reservation yet (an inquiry) → answer it in Hostaway.
- If Slack says a guest has waited or that something is urgent → open the conversation from the link and answer first; it is told once.
- If a new automation is made → it starts paused; read its words, choose its listings, then turn it on. With sending on it reaches guests by itself.
- If an automation's listing has no door code in Hostaway or the Repository → that stay's message is not sent; send the access by hand and fix the record.

## What the system does
- Shows Hostaway's 50 latest conversations with their stay; reloads every two minutes while open, and at once when a guest writes (live messages connected).
- Sends a scheduled message at its time (checked every 5 minutes) and tries a failed one again, 3 times, 10 minutes apart.
- Sends each automation once per stay, only for confirmed bookings and only for its listings: after booking, after the online check-in (never earlier than its "not before"), or before / after check-in and check-out. A booking cancelled meanwhile gets nothing.
- Skips a reminder whose condition no longer holds (the online check-in is already done).
- Fills the door code from the reservation in Hostaway (smart locks) or the Repository's guest code, and Wi-Fi and address from the Repository.
- Reads each incoming guest message with a light AI model: "thanks" is not counted as waiting; something urgent is posted to Slack's Escalations channel at once.
- Posts to Slack once when a guest who is coming or in the house has waited longer than the time set in Settings; a guest who already left is not chased.
- Shows the number of guests waiting on the menu, and a desktop notice when one writes (bell, top of the inbox).
- Keeps every message it sent, staged, scheduled or failed, with who wrote it and the AI draft it started from.
- The AI draft is written from the listing's Repository record, the published SOPs and the conversation. It never sends by itself.`
};
const content = { title: s.title, kind: 'sop', purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen, steps: s.steps, body: s.body };
const [exists] = await sql`SELECT id FROM sops WHERE account_id = 1 AND title = ${s.title} AND deleted_at IS NULL`;
if (exists) {
  const [v] = await sql`SELECT COALESCE(max(version), 0) + 1 AS n FROM sop_versions WHERE account_id = 1 AND sop_id = ${exists.id}`;
  await sql`UPDATE sops SET purpose = ${s.purpose}, trigger = ${s.trigger}, done_when = ${s.doneWhen}, steps = ${JSON.stringify(s.steps)}::jsonb, body = ${s.body},
                   updated_by = ${BY}, updated_at = now() WHERE account_id = 1 AND id = ${exists.id}`;
  await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
            VALUES (1, ${exists.id}, ${v.n}, ${JSON.stringify(content)}::jsonb, 'Automations, channel tabs, online check-in, unanswered-guest watch (117)', ${BY})`;
  console.log(`~ SOP #${exists.id} → v${v.n}`);
} else {
  const [row] = await sql`INSERT INTO sops (account_id, section_key, kind, title, status, purpose, trigger, owner, done_when, steps, body, features, created_by, updated_by)
    VALUES (1, ${s.section}, 'sop', ${s.title}, 'draft', ${s.purpose}, ${s.trigger}, ${s.owner}, ${s.doneWhen}, ${JSON.stringify(s.steps)}::jsonb, ${s.body},
            ${s.features}::text[], ${BY}, ${BY}) RETURNING id`;
  await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
            VALUES (1, ${row.id}, 1, ${JSON.stringify(content)}::jsonb, 'Draft: Guest Services → Inbox (116 + 117)', ${BY})`;
  console.log(`+ SOP #${row.id} (draft)`);
}
