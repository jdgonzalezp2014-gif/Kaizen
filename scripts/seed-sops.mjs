/**
 * Starter SOPs (§92) — drafts for the procedures Kaizen OS already runs,
 * written from how the screens work, for the owner to correct and publish.
 *
 *   node --env-file=.env.local scripts/seed-sops.mjs [--dry]
 *
 * Idempotent: an SOP whose title already exists is left alone. Everything
 * goes in as a DRAFT — readers see none of it until someone publishes it —
 * except what is marked published (the Slack help, which Slack shows).
 */
import { neon } from '@neondatabase/serverless';

const dry = process.argv.includes('--dry');
const sql = neon(process.env.DATABASE_URL);
const BY = 'kaizen-os';

const SOPS = [
  {
    // §101: published from the start — /kaizen help shows it, so it must be readable by everyone.
    section: 'systems', status: 'published', title: 'Kaizen in Slack',
    features: ['home', 'operations.board', 'operations.todos', 'claims', 'settings'],
    purpose: 'Work Kaizen from Slack: see the day in one message, and manage check-ins, cleans, tasks and claims in pop-ups without opening the app.',
    trigger: 'Whenever a Kaizen message arrives in Slack, or you need to add or update work on the go.',
    owner: 'Operations',
    steps: [
      { text: 'Read the reminder: one line per section.', who: 'Ops',
        detail: '- **Morning (8 AM)**: today and tomorrow, plus tasks and claims. **Afternoon (3 PM)**: what is still missing for tomorrow.\n- Each line says how many, and what needs you (▲) — or ✓ when all is fine.\n- **Manage** opens that section in a pop-up. The channel stays one message; the work happens in the pop-ups.' },
      { text: 'Check-ins → Manage: fix what is missing before each arrival.', who: 'Ops',
        detail: '- Every arrival: the agreement, the ID copy (where the building keeps one), and who cleans before it.\n- **Assign clean** when the clean before it has nobody.\n- **↗ Hostaway** opens the reservation, to send the guest portal link again (agreement or ID).' },
      { text: 'Cleans → Manage: see and change who cleans.', who: 'Ops',
        detail: '- Every checkout: time, unit, cleaner, same-day, deep clean, set by hand.\n- **Today / Tomorrow** at the top.\n- **Assign** or **Change**: a cleaner, *No clean needed*, or *Let the rule decide*. The list refreshes after saving.\n- Also /kaizen cleans (or cleans tomorrow).\n- These are real changes: in live mode Kaizen also updates the Host Note in Hostaway.' },
      { text: 'Tasks → Manage: work the open tasks.', who: 'Everyone',
        detail: '- Each task’s ⋯ menu: **Open**, Complete, Start, Edit, Remove (with Undo).\n- **+ To-do** and **+ Repair** at the top.\n- Also /kaizen tasks.' },
      { text: 'Work a task in its card: 📋 Open.', who: 'Owner',
        detail: '- Status, owner, dates, sub-tasks and the latest updates in one place.\n- **Complete**, **Start**, **🙋 Take it** (you become the owner), **Edit**.\n- Write in *Add an update* and press it: it is saved on the task’s timeline. Closing the card brings you back to the list, up to date.' },
      { text: 'Claims → Manage: follow the open claims.', who: 'Ops',
        detail: '- Each claim: a **Status** select, **✎ Edit** and **🗑 Remove** (with Undo); **+ Claim** at the top.\n- Also /kaizen claims and /kaizen claim ….' },
      { text: 'Add work from anywhere: ⚡ shortcuts, or ⋯ on any message.', who: 'Everyone',
        detail: '- ⚡ **New task**, **Report a repair**, **New claim** from anywhere in Slack.\n- On any message: ⋯ → **Create task from message** — the text and a link come with it, and the thread is told it is tracked.\n- Or type /kaizen task … and /kaizen repair ….' },
      { text: 'Answer what comes to you directly.', who: 'Owner',
        detail: '- A task assigned to you arrives in your Slack messages, with its buttons.\n- Each morning you get your overdue tasks.' }
    ],
    doneWhen: 'The reminder says ✓ Nothing missing, and your tasks show where they really stand.',
    body: `## Good to know
- You act as yourself: Kaizen matches your Slack email to your Kaizen account, with your role's permissions.
- Everything done in Slack is the same as in Kaizen — the same timeline, the same Hostaway sync.
- Every pop-up refreshes in place after an action; nothing new is posted to the channel.
- /kaizen help shows this SOP in Slack; "❓ How to use this" on the reminder opens it in Kaizen.`
  },
  {
    section: 'compliance', title: 'Check-in readiness: signed agreement and guest ID',
    features: ['home', 'operations.board'],
    purpose: 'Every guest signs the rental agreement and gives an ID before arrival. Some buildings (P2 today) also need a copy of the ID in Drive, where the building can see it.',
    trigger: 'Every arrival — the day before, and again the morning of arrival.',
    owner: 'Operations',
    steps: [
      { text: 'Open Home → Check-ins. Today and tomorrow are listed, not signed first.', who: 'Ops' },
      { text: 'For each “▲ Not signed”: open ↗ Hostaway on that arrival and send the guest the portal link again, asking them to sign and upload their ID.', who: 'Ops' },
      { text: 'For units that keep a copy (P2): in the Hostaway reservation, download the ID the guest uploaded.', who: 'Ops' },
      { text: 'Back on Home, click “⇪ ID to Drive” on that arrival and choose the file. It goes to the reservation’s ID folder in Drive.', who: 'Ops' },
      { text: 'Check the arrival now shows “✓ ID in Drive”.', who: 'Ops' },
      { text: 'If a guest has still not signed on the morning of arrival, tell the manager before the access details go out.', who: 'Ops → Manager' }
    ],
    doneWhen: 'Every arrival for today and tomorrow shows ✓ Signed, and every P2 arrival shows ✓ ID in Drive.',
    body: `## Which units keep a copy in Drive
Operations → Setup → Guest documents — copy in Drive. Today: every P2 unit.

## When Hostaway does not say "ID verified"
Hostaway marks an ID "verified" only when its own check ran. An ID the guest uploaded in the portal is not "verified" there — open the reservation to see it.

## To confirm before publishing
- The cut-off for a missing signature, and what happens then (last step).`
  },
  {
    section: 'turnover', title: 'Early departure or mid-stay clean',
    features: ['operations.board'],
    purpose: 'A clean that does not come from a checkout is recorded, so it is done, paid and counted — and the stay is not cleaned twice when the guest left early.',
    trigger: 'A guest leaves before their checkout date, or a stay needs a clean during the stay.',
    owner: 'Operations',
    steps: [
      { text: 'Open Operations → Next 10 days and click “+ Manual clean” (or, on the stay’s checkout row, “Guest left early…” / “+ Mid-stay clean”).', who: 'Ops' },
      { text: 'Choose why: Guest left early, Mid-stay clean or Extra clean.', who: 'Ops' },
      { text: 'Pick the unit, the day cleaned and — for an early departure — the stay.', who: 'Ops' },
      { text: 'Assign the cleaner; tick Deep clean if it is one. Add a note the cleaner needs (e.g. keys left in the lockbox).', who: 'Ops' },
      { text: 'Click “Add clean”. For an early departure, check the stay’s original checkout clean now reads “no clean needed”.', who: 'Ops' }
    ],
    doneWhen: 'The clean is on the board on its day with a cleaner; for an early departure, the original checkout clean reads “no clean needed”.',
    body: `Pay is automatic: the cleaner's rate for the unit's size. The clean counts in Costs and on the calendar like any other.

## Undoing it
Cancel the manual clean from the board. For an early departure, the original checkout clean comes back.`
  },
  {
    section: 'claims', title: 'Log and follow a guest claim',
    features: ['claims', 'operations.todos', 'home'],
    purpose: 'Every guest complaint or platform case is recorded once, tied to its stay and its platform case, followed to a close, and costed.',
    trigger: 'A guest complains, asks for a refund, reports damage — or a platform opens a case.',
    owner: 'Operations manager',
    steps: [
      { text: 'Open Claims → “Log a claim” (or “+ Add” in the Claims lane of the to-do list).', who: 'Ops' },
      { text: 'Pick the unit and the stay; set the category and the severity.', who: 'Ops' },
      { text: 'Paste the platform’s case link (Airbnb, Booking.com, Vrbo) into “Case link”.', who: 'Ops' },
      { text: 'Write what happened in one or two sentences.', who: 'Ops' },
      { text: 'If something must be fixed or done, add a repair or a to-do from the claim, so the work is linked to it.', who: 'Ops' },
      { text: 'Post an update on the claim’s timeline each time the case moves.', who: 'Ops' },
      { text: 'Close it: set the status (Resolved, Refunded or Dismissed) and record the refund and the repair cost.', who: 'Manager' }
    ],
    doneWhen: 'The claim is closed, refund and repair cost are filled in, and its timeline says how it ended.',
    body: `## Severity — a suggestion to adjust
- **Low**: an inconvenience; no refund expected.
- **Medium**: a partial refund or a return visit is likely.
- **High**: the stay was affected; a refund or a platform case is likely.
- **Critical**: safety, access or the guest cannot stay.

A claim can stand alone — a late checkout, an early check-in — with no work behind it.`
  },
  {
    section: 'maintenance', title: 'Repairs and work orders',
    features: ['operations.todos'],
    purpose: 'Every repair has an owner, a vendor, a date and a cost, and nobody has to ask whether it was done.',
    trigger: 'Something in a unit needs fixing — from an inspection, a cleaner, a guest or a claim.',
    owner: 'Operations',
    steps: [
      { text: 'Open Operations → To-do and click “+ Add” in the Repairs lane (from a claim: add the repair from the claim so it is linked).', who: 'Ops' },
      { text: 'Give it a short title and pick the unit; put the detail in the description.', who: 'Ops' },
      { text: 'Fill in the vendor, “Booked for” and the estimate.', who: 'Ops' },
      { text: 'Post updates on its timeline as it moves (quote received, vendor rescheduled…).', who: 'Ops' },
      { text: 'When it is done, enter the actual cost and tick it off.', who: 'Ops' }
    ],
    doneWhen: 'The repair is ticked off with its actual cost, and it shows in the done log.',
    body: 'The done log (Operations → To-do → Done log) is the audit trail: who closed what, when, and at what cost.'
  },
  {
    section: 'systems', title: 'A new listing in Kaizen OS',
    features: ['settings', 'operations.setup'],
    purpose: 'A listing added in Hostaway is set up in Kaizen OS before its first guest: cleans, pay and guest documents.',
    trigger: 'A new listing is created or activated in Hostaway.',
    owner: 'Admin',
    steps: [
      { text: 'Create or activate the listing in Hostaway.', who: 'Admin' },
      { text: 'Kaizen adds it on its own the first time the board shows a stay for it. To add it now: Settings → Sync units.', who: 'Admin' },
      { text: 'If its building needs a copy of guest IDs: Operations → Setup → Guest documents — tick it and save.', who: 'Admin' },
      { text: 'Check its cleaning rules and pay in Operations → Rates & rules.', who: 'Admin' },
      { text: 'Confirm it appears on Units and on the board.', who: 'Admin' }
    ],
    doneWhen: 'The listing is on Units and the board, and its guest-document setting is right for its building.',
    body: null
  },
  {
    section: 'team', kind: 'article', title: 'How we write and keep SOPs',
    features: [],
    purpose: 'One way to write procedures, so any of them can be followed by someone doing it for the first time.',
    body: `## One SOP, one process
If it needs "and then, separately…", it is two SOPs.

## The parts, in the order they are used
- **Purpose** — why it exists, in a sentence or two.
- **When to use it** — the trigger, so nobody has to guess.
- **Owner** — one role that keeps it right.
- **Steps** — start each with a verb, one action per step, and say who does it.
- **Done when** — how anyone can check it was done right.
- **Details** — exceptions, escalation, links.

## Where it shows
Tick the screens where the work happens. The SOP then shows on that screen's 📘 SOPs button, next to the work.

## Keeping it true
- Publish only what you would hand to someone new.
- Each change asks what changed and why; the history keeps every version.
- When the review is due, read it through: if it is still right, "Mark reviewed"; if not, edit it.
- The library shows the screens with no SOP yet — that list is the backlog.`
  }
];

let added = 0;
for (const s of SOPS) {
  const [exists] = await sql`SELECT id FROM sops WHERE account_id = 1 AND title = ${s.title} AND deleted_at IS NULL`;
  if (exists) { console.log(`= ${s.title} (already there)`); continue; }
  const kind = s.kind ?? 'sop';
  const content = { title: s.title, kind, purpose: s.purpose ?? null, trigger: s.trigger ?? null, owner: s.owner ?? null,
                    doneWhen: s.doneWhen ?? null, steps: s.steps ?? [], body: s.body ?? null };
  console.log(`${dry ? '(dry) ' : ''}+ ${s.title} → ${s.section}${s.features.length ? ` · on ${s.features.join(', ')}` : ''}`);
  if (dry) continue;
  const [row] = await sql`
    INSERT INTO sops (account_id, section_key, kind, title, status, purpose, trigger, owner, done_when, steps, body, features,
                      created_by, updated_by, reviewed_at, reviewed_by)
    VALUES (1, ${s.section}, ${kind}, ${s.title}, ${s.status ?? 'draft'}, ${content.purpose}, ${content.trigger}, ${content.owner},
            ${content.doneWhen}, ${JSON.stringify(content.steps)}::jsonb, ${content.body}, ${s.features}::text[], ${BY}, ${BY},
            ${s.status === 'published' ? new Date().toISOString() : null}, ${s.status === 'published' ? BY : null})
    RETURNING id`;
  await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
            VALUES (1, ${row.id}, 1, ${JSON.stringify(content)}::jsonb, 'Starter draft, from how Kaizen OS works', ${BY})`;
  added++;
}
console.log(dry ? 'Dry run — nothing written.' : `${added} SOP(s) added.`);
