// Run once AFTER deploying 099 (owner, 2026-10-25): the Handymen screen's SOP, as a DRAFT for the owner to publish.
// node --env-file=.env.local .sop-099.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const BY = 'Kaizen OS (draft)';
const s = {
  title: "Paying handymen and cleaners: Handymen page, invoices and payouts",
  section: 'maintenance', features: ['operations.vendors', 'operations.crew'],
  purpose: "Pay every handyman and cleaner exactly what their invoice says, once, with the team's corrections on record.",
  trigger: 'A work order with a vendor is done, or an invoice period ends (weekly Sat–Fri, or monthly).',
  owner: 'Operations (edits) · whoever holds "Payouts" (paying)',
  doneWhen: "Every ended invoice with something to pay shows Paid — by Stripe or marked by hand — and nothing waits for approval in it.",
  steps: [
    { text: 'Operations → Handymen → pick the handyman. The period select shows their invoice periods; "Last 7/30 days" or two dates review any span (no payment from a span).', who: 'Operations' },
    { text: '"Copy their link" (clipboard) copies the handyman\'s own page — work orders and pay, no sign-in. Paste it in WhatsApp/SMS. Same link each time; "…" → New link / Turn off if it leaked.', who: 'Operations' },
    { text: "Decide each charge waiting on a job (Approve, or Deny with the reason they read). Approved charges are the job's pay.", who: 'Operations' },
    { text: 'Fix what is wrong on a job done: ⚑ Flag (a note, optionally a deduction or a pay instead), ✎ Correct the pay (blank = back to the approved charges), ○ Not paid with the reason. + Add a job for work done without a work order.', who: 'Operations' },
    { text: "First payment by Stripe: in Payment, \"Get their Stripe setup link\" and send it by WhatsApp/SMS. They enter their own bank details with Stripe.", who: 'Payouts' },
    { text: 'After the period ends: Payment → "Pay $X with Stripe" → Confirm, or "Mark paid…" with how (cash, Zelle, check #).', who: 'Payouts' },
    { text: 'Cleaners: the same Payment card is under their page in Operations → Cleaners.', who: 'Payouts' }
  ],
  body: `A job is a work order with the handyman's name; it goes on the invoice of the period in which it was completed. Names typed on a work order but not in the vendor directory are listed too; picking their invoice period adds them to the directory.

## Rules
- If the period has not ended, a job has no pay, or a charge (cleaner: an extra) waits for a decision → the invoice cannot be paid yet.
- If the team set a job's pay by hand (correction or deduction) → later approved charges do not change it, until ✎ Correct is saved blank.
- If a job is marked Not paid → it leaves the invoice and Costs; a repair charged to the owner also leaves the owner's Hostaway statement.
- If an invoice changes after it was paid → the card shows the difference; settle it by hand.
- A payment marked by hand can be undone on the card; a Stripe transfer is reversed only in Stripe's dashboard.
- Only Stripe TEST keys are accepted for now (Settings → Payments); no real money moves until live payouts are switched on.

## What the system does
- Rebuilds the invoice on the server before paying — the amount on screen is never what is sent.
- One payment per invoice number; a double click sends one Stripe transfer (idempotent).
- Every edit on a job is a line in the work order's activity, and its cost in Costs follows at once.
- The handyman sees their pay, flags and corrections on their own page (Pay tab), in English or Spanish.`
};
const [exists] = await sql`SELECT id FROM sops WHERE account_id = 1 AND title = ${s.title} AND deleted_at IS NULL`;
if (exists) { console.log('already there'); process.exit(0); }
const content = { title: s.title, kind: 'sop', purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen, steps: s.steps, body: s.body };
const [row] = await sql`INSERT INTO sops (account_id, section_key, kind, title, status, purpose, trigger, owner, done_when, steps, body, features, created_by, updated_by)
  VALUES (1, ${s.section}, 'sop', ${s.title}, 'draft', ${s.purpose}, ${s.trigger}, ${s.owner}, ${s.doneWhen}, ${JSON.stringify(s.steps)}::jsonb, ${s.body},
          ${s.features}::text[], ${BY}, ${BY}) RETURNING id`;
await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
          VALUES (1, ${row.id}, 1, ${JSON.stringify(content)}::jsonb, 'Draft: Operations → Handymen and payouts (099)', ${BY})`;
console.log(`+ SOP #${row.id} (draft)`);
