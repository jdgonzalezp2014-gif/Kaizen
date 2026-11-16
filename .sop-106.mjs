// Run once AFTER deploying 106 (owner, 2026-10-28): SOP #39 (paying handymen and cleaners) moves from Stripe to Wise — version 2, still a draft.
// node --env-file=.env.local .sop-106.mjs
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const BY = 'Kaizen OS (draft)';
const s = {
  title: "Paying handymen and cleaners: Handymen page, invoices and payouts",
  section: 'maintenance', features: ['operations.vendors', 'operations.crew'],
  purpose: "Pay every handyman and cleaner exactly what their invoice says, once, with the team's corrections on record.",
  trigger: 'A work order with a vendor is done, or an invoice period ends (weekly Sat–Fri, or monthly).',
  owner: 'Operations (edits) · whoever holds "Payouts" (paying)',
  doneWhen: "Every ended invoice with something to pay shows Paid — by Wise or marked by hand — and nothing waits for approval in it.",
  steps: [
    { text: 'Operations → Handymen → pick the handyman. The period select shows their invoice periods; "Last 7/30 days" or two dates review any span (no payment from a span).', who: 'Operations' },
    { text: '"Copy their link" (clipboard) copies the handyman\'s own page — work orders and pay, no sign-in. Paste it in WhatsApp/SMS. Same link each time; "…" → New link / Turn off if it leaked.', who: 'Operations' },
    { text: "Decide each charge waiting on a job (Approve, or Deny with the reason they read). Approved charges are the job's pay.", who: 'Operations' },
    { text: 'Fix what is wrong on a job done: ⚑ Flag (a note, optionally a deduction or a pay instead), ✎ Correct the pay (blank = back to the approved charges), ○ Not paid with the reason. + Add a job for work done without a work order.', who: 'Operations' },
    { text: 'First payment by Wise: in Payment, "Get their bank link" and send it by WhatsApp/SMS. They type their routing and account number once; it goes to Wise and Kaizen keeps only the last 4. The same link changes a bank on file.', who: 'Payouts' },
    { text: 'After the period ends: Payment → "Pay $X with Wise" → Confirm (from Kaizen\'s Wise USD balance; Wise\'s fee, about $1.13, comes from it too), or "Mark paid…" with how (cash, Zelle, check #).', who: 'Payouts' },
    { text: 'Cleaners: the same Payment card is under their page in Operations → Cleaners.', who: 'Payouts' }
  ],
  body: `A job is a work order with the handyman's name; it goes on the invoice of the period in which it was completed. Names typed on a work order but not in the vendor directory are listed too; picking their invoice period adds them to the directory.

## Rules
- If the period has not ended, a job has no pay, or a charge (cleaner: an extra) waits for a decision → the invoice cannot be paid yet.
- If the team set a job's pay by hand (correction or deduction) → later approved charges do not change it, until ✎ Correct is saved blank.
- If a job is marked Not paid → it leaves the invoice and Costs; a repair charged to the owner also leaves the owner's Hostaway statement.
- If an invoice changes after it was paid → the card shows the difference; settle it by hand.
- If the Wise USD balance does not cover the invoice and fee → Wise refuses it; add money in Wise first.
- A payment marked by hand can be undone on the card; a Wise transfer is cancelled only in Wise, and only before it goes out.
- Only a Wise SANDBOX token is accepted for now (Settings → Payments); no real money moves until live payouts are switched on.

## What the system does
- Rebuilds the invoice on the server before paying — the amount on screen is never what is sent.
- One payment per invoice number; a retry or double click finds Wise's same transfer instead of sending a second one.
- Signs each Wise payment with Kaizen's own key (its public half is uploaded to Wise once, from Settings → Payments).
- Shows Wise's state of a transfer (on its way, or came back) each time the card opens.
- Every edit on a job is a line in the work order's activity, and its cost in Costs follows at once.
- The handyman sees their pay, flags and corrections on their own page (Pay tab), in English or Spanish.`
};
const [cur] = await sql`SELECT id, (SELECT max(version) FROM sop_versions v WHERE v.sop_id = s.id) AS v FROM sops s WHERE account_id = 1 AND id = 39 AND deleted_at IS NULL`;
if (!cur) { console.log('SOP #39 not found'); process.exit(1); }
if (Number(cur.v) >= 2) { console.log('already v' + cur.v); process.exit(0); }
const content = { title: s.title, kind: 'sop', purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen, steps: s.steps, body: s.body };
await sql`UPDATE sops SET purpose = ${s.purpose}, trigger = ${s.trigger}, owner = ${s.owner}, done_when = ${s.doneWhen}, steps = ${JSON.stringify(s.steps)}::jsonb,
          body = ${s.body}, updated_by = ${BY} WHERE id = 39`;
await sql`INSERT INTO sop_versions (account_id, sop_id, version, snapshot, note, edited_by)
          VALUES (1, 39, 2, ${JSON.stringify(content)}::jsonb, 'Payouts by Wise instead of Stripe (106)', ${BY})`;
console.log('SOP #39 → v2 (draft)');
