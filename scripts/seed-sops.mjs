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
        detail: '- Status, owner, dates, sub-tasks and the latest comments in one place.\n- **Complete**, **Start**, **🙋 Take it** (you become the owner), **Edit**.\n- Write in *Add a comment* and press **Add comment**: it is saved on the task. Closing the card brings you back to the list, up to date.\n- What the system recorded (status changes, Hostaway, costs) is in Kaizen, in the task’s **Activity log**.' },
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
  },
  // §128 — the cleaners' pages: the team's daily part, setting a cleaner up, and the cleaners' own guide.
  {
    section: 'turnover', title: "Cleaners' pages: what they see, and the team's part",
    features: ['operations.crew', 'operations.board'],
    purpose: 'Each cleaner has a page in Kaizen with their cleans, pay, invoice, extras and what is coming. Nobody confirms the schedule; the team keeps an eye on what cleaners already see (👁) and handles what needs a person.',
    trigger: 'Every day, while working the board (Operations → Movements).',
    owner: 'Operations',
    steps: [
      { text: 'On the board, 👁 means the cleaner already sees that clean on their page.', who: 'Ops',
        detail: '- They see what a person assigned to them, always, and the rule\'s picks 4 days ahead. Beyond that, nothing.\n- Change a 👁 clean only with a reason, and tell the cleaner: their page shows it at once and lists it under "Changes since" until the next daily update.\n- Cleans without 👁 can be moved freely — the cleaner has not seen them.' },
      { text: 'Deep cleans: every clean is regular until someone confirms it.', who: 'Ops',
        detail: '- Long stays show "○ deep suggested (N nights)".\n- If it will really be cleaned as deep: open the row → Deep clean → "Deep — confirmed". Only then is it paid as deep.' },
      { text: '"▲ declined by …": a cleaner turned the clean down. Give it to someone else.', who: 'Ops',
        detail: '- It is already unassigned (TBD) and in Needs attention, with their reason.\n- The rule never hands it back to the cleaner who declined.' },
      { text: '"▲ cancelled … — confirm who cleaned": settle it in Operations → Crew.', who: 'Ops',
        detail: '- Card "Cancelled after arrival — confirm": choose who cleaned it and the day (tick deep if it was), then ✓ Cleaned — or No clean needed.\n- Only bookings cancelled on or after the arrival day ask: the guest may have used the unit. Cancelled before arrival, or a guest who changed dates (cancel and rebook), never asks.\n- Until settled it is unpaid; the cleaner does not see it.' },
      { text: 'Extras: Operations → Crew → "Extras waiting on the team".', who: 'Ops',
        detail: '- Open the receipt or photo (📎), then ✓ Approve, or ■ Deny with a note — the note is required to deny; the cleaner reads it.\n- Approved extras go on that cleaner\'s invoice with the clean.' },
      { text: 'Something wrong with a clean: open its row → ⚑ Flag this clean….', who: 'Ops',
        detail: '- Write what the cleaner should know — they read it on their page.\n- For a clean due today or before, type the corrected pay in the same step ("Flag and correct pay"). Blank keeps the pay.\n- To switch deep / regular on a clean already done: Operations → Crew → the cleaner → ✎ Correct.' },
      { text: 'To check what a cleaner sees: Operations → Crew → pick them → 👁 View as cleaner ↗.', who: 'Anyone',
        detail: 'A separate tab with exactly their page — no ratings, no team controls. Their buttons do nothing there.' }
    ],
    doneWhen: 'Nothing waits in "Cancelled after arrival — confirm" or "Extras waiting on the team", and every 👁 clean is right.',
    body: `## Good to know
- Invoices: weekly (Saturday to Friday, paid Saturday) or monthly (paid in the first days of the next month), per cleaner. Done cleans plus approved extras; "○ not paid" ones say why.
- A flag does not change the pay unless you correct it in the same step.
- Cleaners never see their level or any rating.
- Michelle is assigned by hand only (emergencies and mid-stays).`
  },
  {
    section: 'systems', title: 'Give a cleaner access to their page',
    features: ['operations.setup', 'operations.crew'],
    purpose: 'A cleaner signs in with their own email and a code, and sees only their own page.',
    trigger: 'A new cleaner, or a cleaner who cannot get in.',
    owner: 'Admin',
    steps: [
      { text: 'Setup → Crew pages: type the cleaner\'s own email and choose their invoice (weekly or monthly). Save addresses and invoices.', who: 'Admin',
        detail: 'An address that belongs to a team member is refused: a cleaner needs their own.' },
      { text: 'Cloudflare Zero Trust → Access → the Kaizen application → its policy: add the same email, with the One-time PIN login on.', who: 'Owner' },
      { text: 'Send the cleaner the app address. They type their email and the code that arrives by email; they land on their page and nothing else.', who: 'Admin' },
      { text: 'Check it: Operations → Crew → pick them → 👁 View as cleaner ↗.', who: 'Admin' },
      { text: 'If the code does not work for them: Setup → Crew pages → make link, and send that link.', who: 'Admin',
        detail: '- It opens only once Cloudflare Access lets /crew, /assets/* and /api/crew-link through without a sign-in (a Bypass application).\n- Anyone holding the link sees that cleaner\'s page: revoke it if it leaks. It is shown once.' }
    ],
    doneWhen: 'The cleaner signs in and sees their own cleans.',
    body: `## What cleaners see ahead
Setup → Crew pages → "The rule's picks show this many days ahead" (4). What a person assigns shows at once. "Publish the whole schedule" shows everything ahead — leave it off unless the schedule has been checked.`
  },
  {
    section: 'turnover', title: 'Your Kaizen page (for cleaners)',
    features: ['crew.page'],
    purpose: 'See your cleans and what each one pays, plan your coming days, ask for extras, and get your invoice.',
    trigger: 'Before you plan your days, after a clean that needed something extra, and when you invoice.',
    owner: 'Each cleaner',
    steps: [
      { text: 'Sign in: open the Kaizen address, type your email, and enter the code we send to your email.',
        detail: 'Save the address on your phone\'s home screen to come back quickly.' },
      { text: 'Coming up: your cleans ahead.',
        detail: '- You see the cleans the team gave you, and the rest 4 days before.\n- "Last update" and "Changes since then" tell you what moved: a stay extended or shortened, a booking cancelled, a new clean.\n- ⚡ means the next guest arrives the same day — the check-in time is shown.\n- Look here before you plan your day.' },
      { text: 'Cannot do one? Tap "Can\'t do it" and say why, as early as you can.',
        detail: 'It goes back to the team, who give it to someone else.' },
      { text: 'Calendar: your month at a glance. Tap a day to see its cleans.',
        detail: '"Add my coming cleans to my phone calendar" puts them in your phone. If something changes, add them again.' },
      { text: 'Cleans: each clean with what it pays.',
        detail: '- ✓ paid · ○ not paid, with the reason · ⚑ a note from the team about that clean — please read it.\n- "✎ Corrected by the team" means the pay or the type of clean was changed, and why.' },
      { text: 'Extras: on a clean you did, "+ Add an extra": the amount, what it was for, and a photo of the receipt or invoice.',
        detail: 'The team approves or denies it with a note. Only approved extras are paid, with that clean.' },
      { text: 'Invoice: choose the period and check it. "Print / save as PDF" keeps a copy.',
        detail: 'Weekly: Saturday to Friday, paid on Saturday. Monthly: the whole month, paid in the first days of the next.' }
    ],
    doneWhen: 'You know your cleans for the coming days, and your invoice matches the work you did.',
    body: `Questions about a clean or a payment: message the team.`
  },
  // §133 — inspections as a checklist.
  {
    section: 'inspections', title: 'Inspect a unit with the checklist',
    features: ['operations.inspections', 'operations.setup'],
    purpose: 'Walk the unit room by room, catch what is wrong, and turn each finding into work in one go — a repair, a purchase, or something for a clean.',
    trigger: 'A scheduled inspection (Operations → Inspections → calendar or Scheduled), a unit due or overdue, or before a big booking.',
    owner: 'Inspector',
    steps: [
      { text: 'Open Operations → Inspections. ▶ Start a scheduled one, or pick the unit and inspector and ▶ Inspect now.', who: 'Inspector',
        detail: '- The inspector is never who cleaned the unit last — Kaizen will not allow it.\n- On a phone the checklist opens full screen. Everything is saved as you tap; you can close and ▶ Continue later.' },
      { text: 'Go room by room. Each item: ✓ OK, ▲ Fix, or N/A.', who: 'Inspector',
        detail: '- Bedrooms and bathrooms appear once per room in the unit.\n- "Everything else here is OK" marks the rest of a room in one tap.\n- On ▲: say what is wrong (optional) and take a photo — the photo is required.' },
      { text: 'Something not on the list? Use the buttons at the top: 🧽 Cleaning · 🔧 Repair · 🛒 Purchase.', who: 'Inspector',
        detail: 'Say what it is, the room, and take a photo.' },
      { text: 'Review & finish: choose what each finding becomes.', who: 'Inspector',
        detail: '- 🔧 Repair: a work order, nobody on it yet, with the sub-task "Assign and schedule".\n- 🛒 Purchase: a to-do "Buy: …".\n- 🧽 Task for the next clean: the cleaner sees it on their page with that clean.\n- 🧽 A new clean: one extra clean on the day you pick, unassigned — the team gives it to a cleaner.\n- No action: kept in the report only.\nThen the overall result (suggested), and Finish.' },
      { text: 'After: give each new repair an owner and a day — its "Assign and schedule" sub-task.', who: 'Ops',
        detail: 'Repairs and purchases are in Operations → To-do and in Hostaway. Pick the vendor from the list (Setup → Vendors & handymen).' }
    ],
    doneWhen: 'The inspection shows ✓ or ▲ in the calendar, and every finding has its repair, purchase or clean task.',
    body: `## The checklist
Operations → Setup → Inspection checklist: add, edit, reorder or remove items per room, for every unit or one unit only. An item already used in an inspection is switched off rather than deleted, so old reports keep it.`
  },
  // §129 — the same guide in Spanish; the cleaner's page shows the one in their language.
  {
    section: 'turnover', title: 'Tu página de Kaizen (para cleaners)',
    features: ['crew.page.es'],
    purpose: 'Ver tus limpiezas y lo que paga cada una, planear tus próximos días, pedir extras y tener tu invoice.',
    trigger: 'Antes de planear tus días, después de una limpieza que necesitó algo extra, y cuando haces tu invoice.',
    owner: 'Cada cleaner',
    steps: [
      { text: 'Entra: abre la dirección de Kaizen, escribe tu email y pon el código que te llega por email.',
        detail: 'Guarda la dirección en la pantalla de inicio de tu teléfono para volver rápido. Arriba puedes cambiar entre English y Español.' },
      { text: 'Próximas: tus limpiezas que vienen.',
        detail: '- Ves las limpiezas que el equipo te dio, y las demás 4 días antes.\n- "Última actualización" y "Cambios desde entonces" te dicen qué se movió: una estancia extendida o acortada, una reserva cancelada, una limpieza nueva.\n- ⚡ quiere decir que el siguiente huésped llega el mismo día — se muestra la hora de entrada.\n- Revisa aquí antes de planear tu día.' },
      { text: '¿No puedes hacer una? Toca "No puedo" y di por qué, lo antes posible.',
        detail: 'Vuelve al equipo, que se la da a otra persona.' },
      { text: 'Calendario: tu mes de un vistazo. Toca un día para ver sus limpiezas.',
        detail: '"Agregar mis próximas limpiezas al calendario del teléfono" las pone en tu teléfono. Si algo cambia, vuelve a agregarlas.' },
      { text: 'Limpiezas: cada limpieza con lo que paga.',
        detail: '- ✓ pagada · ○ sin pago, con el motivo · ⚑ una nota del equipo sobre esa limpieza — léela, por favor.\n- "✎ Corregida por el equipo" quiere decir que se cambió el pago o el tipo de limpieza, y por qué.' },
      { text: 'Extras: en una limpieza que hiciste, "+ Agregar un extra": el monto, para qué fue y una foto del recibo o invoice.',
        detail: 'El equipo lo aprueba o lo rechaza con una nota. Solo se pagan los extras aprobados, junto con esa limpieza.' },
      { text: 'Invoice: elige el periodo y revísalo. "Imprimir / guardar como PDF" guarda una copia.',
        detail: 'Semanal: de sábado a viernes, se paga el sábado. Mensual: el mes completo, se paga los primeros días del mes siguiente.' }
    ],
    doneWhen: 'Sabes tus limpiezas de los próximos días, y tu invoice coincide con el trabajo que hiciste.',
    body: `¿Preguntas sobre una limpieza o un pago? Escríbele al equipo.`
  },
  // §134 — inventory: the team's side, and the cleaners' (both languages).
  {
    section: 'turnover', title: 'Keep the supplies counted and ordered',
    features: ['operations.inventory'],
    purpose: 'Know what each unit and the storage really hold, find out where the record drifted, and buy what the coming cleans need — in one shopping list.',
    trigger: 'Weekly before buying; whenever Inventory shows ⚠ (something reported not there); after a big purchase.',
    owner: 'Operations',
    steps: [
      { text: 'Open Operations → Inventory and read the top line.', who: 'Ops',
        detail: '- ⚠ lists the places where a cleaner or a helper did not find something the record says is there. Each one also made a to-do "Check stock: …".\n- "never counted" places have no trustworthy number yet.' },
      { text: 'Count a place: choose it, ▣ Count, type what is really there, Save the count.', who: 'Ops',
        detail: '- Only the items you fill in are counted; the rest keep their record.\n- The Gap column shows how far off the record was (+ more than expected, − less). A big gap is worth asking about.\n- A count clears the ⚠ for that item. Close the matching "Check stock" to-do.' },
      { text: 'Record what came in: "Record a move here" → Bought / brought in.', who: 'Ops',
        detail: 'Purchases normally go to Storage. Use "Correct (+ or −)" only to fix a mistake, with a note.' },
      { text: 'To order: check the lines, change quantities, untick what you do not want, Create the shopping to-do.', who: 'Ops',
        detail: '- A line is a counted unit: what its cleans in the next 14 days use, plus the minimum to keep, minus what is there.\n- Units never counted are listed under "Count first" — count them to get their lines.\n- Totals subtract what Storage holds: "buy" is what is left to buy.\n- The to-do has one sub-task per line, to tick off while shopping; it goes to Hostaway like any task.' },
      { text: 'Keep the list right: Supplies list (Setup permission) — name, how it is counted, the estimate per clean, the minimum to keep.', who: 'Ops',
        detail: 'After 3 cleans in a unit report what they used, Kaizen uses that ("learned") instead of the estimate.' }
    ],
    doneWhen: 'No ⚠ left without a count, and the shopping to-do covers the next two weeks of cleans.',
    body: `## Where reports come from
Cleaners report from each clean's "Options…" on their page: what they took, what they bought, what is missing, a problem, or something they need — plus photos before/after and "done". Whoever helps them on a clean reports the same from the link the cleaner sends for that clean (no account) — they appear as "<cleaner>'s team: <name>". Neither can count or correct; only the team can.`
  },
  {
    section: 'turnover', title: 'Your clean step by step: photos, done, supplies',
    features: ['crew.page'],
    purpose: 'Show the team each clean before and after, say when it is done, and say what you used or what is missing — from the clean itself, in a few taps.',
    trigger: 'At every clean: when you arrive, when you finish, and whenever something is missing or wrong.',
    owner: 'Each cleaner',
    steps: [
      { text: 'Find the clean in "Coming up" (or in Cleans, if it was in the last days) and open its "Options…" list.',
        detail: 'Everything you choose there is about that clean only — you never pick the house or the day.' },
      { text: 'Arriving: "📷 Photos & mark as done" → 1 Photos BEFORE cleaning → take or choose the photos → Send.',
        detail: 'One photo of each room from the door is enough, and close-ups of anything wrong. They go to the team’s Drive, in a folder for that house and day.' },
      { text: 'Finishing: 2 Photos AFTER cleaning → Send → 3 ✅ Mark as done.',
        detail: '"Mark as done" needs at least one AFTER photo. If you marked it by mistake: ↩️ Reopen → "Yes, reopen".' },
      { text: 'What you took, what you bought, what is missing, a problem, something you need: choose it in "Options…".',
        detail: '- What I took: tap + on each thing, then Send — all of it goes at once.\n- Bought: the item, how many, a photo of the receipt.\n- Missing: the item and how many are there (0 if none) — the team gets a task to count it.\n- A problem or a need: write it or say it with the 🎤 of your keyboard; add a photo if it helps.' },
      { text: 'Someone helps you on this clean: "Options…" → 📤 Send the link to my helper → Send by WhatsApp.',
        detail: '- The link is for that clean only and needs no account. Your helper can do the same steps: photos, done, supplies, problems.\n- Several people can use the same link; each writes their name once.\n- It stops working two days after the clean, or if the clean is given to someone else.' }
    ],
    doneWhen: 'Every clean has its before and after photos, is marked done, and nothing missing goes unsaid.'
  },
  {
    section: 'turnover', title: 'Tu limpieza paso a paso: fotos, completada, insumos',
    features: ['crew.page.es'],
    purpose: 'Mostrarle al equipo cada limpieza antes y después, avisar cuando está completada, y decir qué usaste o qué falta — desde la limpieza misma, en pocos toques.',
    trigger: 'En cada limpieza: al llegar, al terminar, y cuando algo falta o está mal.',
    owner: 'Cada cleaner',
    steps: [
      { text: 'Busca la limpieza en "Próximas" (o en Limpiezas, si fue en los últimos días) y abre su lista "Opciones…".',
        detail: 'Todo lo que elijas ahí es solo de esa limpieza — nunca eliges la casa ni el día.' },
      { text: 'Al llegar: "📷 Fotos y marcar completada" → 1 Fotos ANTES de limpiar → toma o elige las fotos → Enviar.',
        detail: 'Basta una foto de cada cuarto desde la puerta, y de cerca lo que esté mal. Van al Drive del equipo, en una carpeta de esa casa y ese día.' },
      { text: 'Al terminar: 2 Fotos DESPUÉS de limpiar → Enviar → 3 ✅ Marcar como completada.',
        detail: '"Marcar como completada" necesita al menos una foto del DESPUÉS. Si la marcaste por error: ↩️ Reabrir → "Sí, reabrir".' },
      { text: 'Lo que tomaste, lo que compraste, lo que falta, un problema, algo que necesitas: elígelo en "Opciones…".',
        detail: '- Lo que tomé: toca + en cada cosa y Enviar — se va todo junto.\n- Compré: el artículo, cuántos y una foto del recibo.\n- Falta algo: el artículo y cuántos hay (0 si ninguno) — el equipo recibe una tarea para contarlo.\n- Un problema o algo que necesitas: escríbelo o dilo con el 🎤 del teclado; agrega una foto si ayuda.' },
      { text: 'Alguien te ayuda en esta limpieza: "Opciones…" → 📤 Enviar el enlace a mi ayudante → Enviar por WhatsApp.',
        detail: '- El enlace es solo de esa limpieza y no necesita cuenta. Tu ayudante puede hacer los mismos pasos: fotos, completada, insumos, problemas.\n- Varias personas pueden usar el mismo enlace; cada una escribe su nombre una vez.\n- Deja de funcionar dos días después de la limpieza, o si la limpieza se le da a otra persona.' }
    ],
    doneWhen: 'Cada limpieza tiene sus fotos del antes y el después, está completada, y no se queda sin decir nada que falte.'
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
