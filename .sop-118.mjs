// Run once AFTER migrating 118 and deploying (owner, 2026-11-17): the help assistant's SOP, as a DRAFT to publish.
// node --env-file=.env.local .sop-118.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const BY = 'Kaizen OS (draft)';
const s = {
  title: 'Ask Kaizen: the help assistant and the "?" on every screen',
  section: 'systems', features: [],
  purpose: 'Anyone finds how a process works, or a listing\'s or account\'s details, without leaving the screen they are on.',
  trigger: 'You do not know how to do something in Kaizen, or you need a Wi-Fi, an address, a login or a code.',
  owner: 'Everyone',
  doneWhen: 'You have the answer, or you know no SOP covers it and told your manager.',
  steps: [
    { text: 'Bottom right: "?" opens the SOPs of the screen you are on. The round chat button above it opens Ask Kaizen.', who: 'Everyone' },
    { text: 'For a process, ask in your own words (English or Spanish): "how do I record a receipt?". Read the answer and open the SOP it names.', who: 'Everyone' },
    { text: 'For a listing, tool or account, name it and what you need: "wifi Amber Valley", "password Airbnb", "CL 1125 code".', who: 'Everyone' },
    { text: 'A password or code shows as Reveal: press it, copy the value. It hides again after 30 seconds.', who: 'Everyone' },
    { text: 'If it says no SOP covers this, tell your manager so the SOP gets written.', who: 'Everyone' }
  ],
  body: `## Rules
- If you need a password → use Reveal; never ask for it in Slack or paste it anywhere.
- If Reveal says your role cannot → ask an admin; do not ask a colleague to send it.
- If the answer names an SOP → the SOP is the source; the answer is a summary.

## What the system does
- A question that names a Repository record is answered from that record by rules — no AI is used.
- Any other question is matched to the published SOPs by words; a light AI model answers only from the few that match.
- Every Reveal is written to the Repository's reveal log with who and when.
- Nothing typed in Ask Kaizen is saved.`
};
const [exists] = await sql`SELECT id FROM sops WHERE account_id = 1 AND title = ${s.title} AND deleted_at IS NULL`;
if (exists) { console.log('already there'); process.exit(0); }
const content = { title: s.title, kind: 'sop', purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen, steps: s.steps, body: s.body };
const [row] = await sql`INSERT INTO sops (account_id, section_key, kind, title, status, purpose, trigger, owner, done_when, steps, body, features, created_by, updated_by)
  VALUES (1, ${s.section}, 'sop', ${s.title}, 'draft', ${s.purpose}, ${s.trigger}, ${s.owner}, ${s.doneWhen}, ${JSON.stringify(s.steps)}::jsonb, ${s.body},
          ${s.features}::text[], ${BY}, ${BY}) RETURNING id`;
await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
          VALUES (1, ${row.id}, 1, ${JSON.stringify(content)}::jsonb, 'Draft: Ask Kaizen (118)', ${BY})`;
console.log(`+ SOP #${row.id} (draft)`);
