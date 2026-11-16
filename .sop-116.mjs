// Run once AFTER migrating 116 and deploying (owner, 2026-11-16): the Inbox's SOP, as a DRAFT for the owner to publish.
// node --env-file=.env.local .sop-116.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const BY = 'Kaizen OS (draft)';
const s = {
  title: 'Guest Services Inbox: answering guests, scheduled messages and the AI draft',
  section: 'guest', features: ['inbox'],
  purpose: 'Every guest gets a correct answer from one place, with the stay, its to-dos and what is scheduled in view.',
  trigger: 'A guest writes (the conversation shows under "Needs reply"), or a stay needs a message at a set time.',
  owner: 'Guest Services',
  doneWhen: '"Needs reply" is empty, and every to-do a conversation raised is on the stay.',
  steps: [
    { text: 'Guest Services → Inbox. "Needs reply" lists the conversations where the guest wrote last. Open one.', who: 'Guest Services' },
    { text: 'Read the thread and the stay on the right (dates, guests, paid / agreement / ID, to-dos).', who: 'Guest Services' },
    { text: 'Answer: write the reply, or pick a Template, or press Suggest for an AI draft — read it, change it, then Send.', who: 'Guest Services' },
    { text: 'If the draft says "Needs a person", do not send it as an answer: decide the case (or ask the manager) and write the reply yourself.', who: 'Guest Services' },
    { text: 'If the guest needs something done, press + under To-dos: it is created in Operations → To-do for that listing and stay.', who: 'Guest Services' },
    { text: 'To send later, press Later, pick the time, then Schedule. It shows in the thread with a clock; Cancel removes it.', who: 'Guest Services' },
    { text: 'SMS tab: the texts with the guest\'s phone through Quo. Same reply box.', who: 'Guest Services' },
    { text: 'Templates (gear, top of the inbox): write the messages, and for the automatic ones choose when they go.', who: 'Manager' }
  ],
  body: `Conversations stay in Hostaway and SMS in Quo; the Inbox reads them and keeps only its own outbox.

## Rules
- If "Sending is off" shows → nothing written here reaches the guest; it is kept as Staged. Answer in Hostaway until it is turned on.
- If a message still has an empty {{blank}} → it cannot be sent; fill it in or remove it.
- If the guest asks for money back, reports damage or an emergency, or asks for an exception → a person decides; never send an AI draft as the answer.
- Never type a door code or lockbox code in a reply → the arrival instructions carry it.
- If a message shows "Not sent" → read the reason under it, fix it, then Retry.
- If a conversation has no reservation yet (an inquiry) → answer it in Hostaway.

## What the system does
- Shows Hostaway's 50 latest conversations with their stay; reloads every two minutes while open.
- Sends a scheduled message at its time (checked every 5 minutes) and tries a failed one again, 3 times, 10 minutes apart.
- Sends each automatic template once per stay, only for confirmed bookings, at its moment before or after booking, check-in or check-out.
- Keeps every message it sent, staged, scheduled or failed, with who wrote it and the AI draft it started from.
- The AI draft is written from the listing's Repository record, the published SOPs and the conversation. It never sends by itself.`
};
const [exists] = await sql`SELECT id FROM sops WHERE account_id = 1 AND title = ${s.title} AND deleted_at IS NULL`;
if (exists) { console.log('already there'); process.exit(0); }
const content = { title: s.title, kind: 'sop', purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen, steps: s.steps, body: s.body };
const [row] = await sql`INSERT INTO sops (account_id, section_key, kind, title, status, purpose, trigger, owner, done_when, steps, body, features, created_by, updated_by)
  VALUES (1, ${s.section}, 'sop', ${s.title}, 'draft', ${s.purpose}, ${s.trigger}, ${s.owner}, ${s.doneWhen}, ${JSON.stringify(s.steps)}::jsonb, ${s.body},
          ${s.features}::text[], ${BY}, ${BY}) RETURNING id`;
await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
          VALUES (1, ${row.id}, 1, ${JSON.stringify(content)}::jsonb, 'Draft: Guest Services → Inbox (116)', ${BY})`;
console.log(`+ SOP #${row.id} (draft)`);
