# Module: guests (agreement, ID, documents)

Every guest signs the rental agreement and gives an ID through Hostaway's guest portal;
Kaizen shows where each arrival stands and keeps a copy in Drive for buildings that need it
(the P2 building today).

## Files

- `src/screens/Home.tsx` (Check-ins card: docChip, DropRow drag-and-drop, upload),
  Operations board arrivals, Operations → Setup → "Guest documents — copy in Drive".
- API: `guest-docs.ts` (list folders/files), `guest-docs-upload.ts`, `operations.ts`
  (agreement/ID flags on arrivals), `google-drive.ts` / `google-callback.ts` (OAuth).
- Server libs: `guest-docs.ts` (folder path, docName), `gdrive.ts` (Drive client, resumable upload).
- Script: `scripts/house-rules-id-notice.mjs` (ID notice appended to house rules; `--dry` first).

## Tables

`accounts.guest_docs_root_id`, `accounts.guest_docs_units` (listing ids that keep a copy),
`drive_folders` (folder id address book), `listing_text_changes` (house-rules edits, revertible),
Drive OAuth tokens on `accounts` (encrypted).

## Rules that bite

- Folders are the daily file's, found by name, never moved:
  `Reservations / YYYY / YYYY-MM / YYYY-MM-DD / "MMM d & First Last" / ID | Rental Agreement` (§73).
- The upload finds the folder from **Hostaway's** record of the stay, not the browser's (§73).
- Agreement status from Hostaway (`reservationAgreement`); "ID verified" only when Hostaway
  says so — an ID uploaded in the portal is not "verified", and the API exposes no file, so
  the Drive copy is manual: download from Hostaway, drop it on the arrival (§89, §90, §106).
- Home: ⇪ ID / ⇪ Agreement to pick, or drag a file over an arrival → "Drop as ID / Drop as
  Agreement"; ✓ opens the folder; amber only where the building keeps a copy (§106).
- Which units keep a copy is a setting per building, not a rule (Airbnb limits asking) (§73).
- Permission `guests.documents` (the most sensitive data Kaizen holds).
- New listings reach `units` on their own when the board sees them (§90).
- Guest portal backdrop is painted on `html` (sized to the first screen), never a `position: fixed` layer under
  the content: on iOS Safari that left stale paint (a button's old label under its new one) (2026-11-16).

## Open items

- The external guest-identification sheet the P2 building reads is still written by the
  daily file (`18 guestidsync.js`) — not moved; ask before touching it.

## History

§72, §73, §89, §90, §106.

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only; tokens and shared components from `docs/design-system.md`.
- Home → Check-ins: the "⇪ ID / ⇪ Agreement" uploads were a `<label>` over an `<input hidden>` — not reachable
  by keyboard, and a 13 px word to tap. Now the input is visually hidden but focusable (`.sr-file`, focus ring
  on the label) and the label is a dashed pill (amber when the building needs the copy, muted when optional),
  36 px tall on a phone. Drag-and-drop on the row is unchanged.
- Signed / Not signed / ID verified already carried a word + shape; unchanged.

## Home check-ins/outs rows (2026-10-15)

Owner: same logic as Movements, two lines a row. Check-out: unit BR / cleaner · pay (small) | flags in one row.
Check-in: unit BR / guest ↗ · nights · guests | pills: the agreement pill only (`✓ signed` solid green, `▲ not signed`
dashed amber — clickable to upload the agreement when the person has `guests.documents`), plus `○ ID` only where the
building keeps an ID copy (as on the board). "✓ ID verified" and the separate Agreement chip are gone from Home.
"Open the board" sits top right; the panel's summary goes under the title.

Round 2 (same day, owner: save space): one line a row — time | unit BR ↗ | icons. The stay (guest · nights ·
guests · channel · total) is the ↗'s hover; the ↗ still opens Hostaway. Check-out: the cleaner and pay are a
person icon's hover (amber when unassigned). Check-in today: a brush icon says prepped by / clean not assigned.
Open work on the unit as icon-only chips (wrench work orders, cart purchase orders, list to-dos — no counts, titles
on hover, click → Operations → To-do filtered to the unit). Agreement is `▲ 📄`/`✓ 📄` (file icon), "signed / not
signed" on hover. Right column wider (3fr / 2fr, min 360px).

## Upselling y Experiencia del Huésped (Guest Portal, 2026-11-05)

**Status: first view, demo data only — nothing is charged, nothing is written to Hostaway.**
The owner's boss wants the Enso Connect "boarding pass": one link per stay where the guest sees the
stay, pays what is due, opens the arrival guide and asks for extras (see `docs/proposal-guest-platform.md`).
Reference the boss shared: kgp-guest-portal-demo.thestrforge.workers.dev (damage waiver $12/night,
$75 minimum; the arrival guide locked until paid *and* a release time; no fee on Airbnb/Vrbo).

### Files

- `src/lib/guest-portal.ts` (+ test) — pure: stay → pay state, guide lock, upsell catalog,
  availability, quote, the "new upselling request" record, the Hostaway pay-link shape.
- `src/screens/GuestPortal.tsx` — the guest's page; same look as the handyman's page by house
  (`.v-island`, `Carousel`, `.v-house` cards from `src/screens/Work.tsx`), plus `.g-*` in `index.css`.
  Palette = the public site's (website module): dark-only warm black + gold, via `useBrand()` adding
  `.guest-brand` to `<html>` while mounted (no day/night toggle on this page; staff theme restored on leave).
  Gold is the action colour, so attention/due is coral `#f0915a`, not amber.
- Routes: `/guest/<Hostaway reservation id>.<sig>` (owner's idea: a bypass keyed on the reservation id),
  `/guest/demo`, and `/crew/guest-demo` (rides the existing `/crew` bypass, §140 — shows the demo today
  without a sign-in). `?stay=unpaid|partial|paid|airbnb` picks the demo stay. `guestLink()` parses the path.
- **Why the `<sig>`:** reservation ids run in sequence — the id alone lets anyone walk other guests' stays
  (name, dates, address, later the door code). `<sig>` = HMAC(server key, id), checked in the function:
  no token table, and the team can rebuild any guest's link from the id. A bare `/guest/<id>` is not a link.
- Cloudflare Access needs a **Bypass** application for `/guest/*` before guests can open it (not done).

### What the guest sees (no paragraphs; how-it-works behind the "?")

1. **Island**: "Hi, <first name>" · Stay | Extras · day/night.
2. **Stay**: a hero card (house, dates, nights, check-in / check-out times), the pay state
   (`▲ $75.00 due` amber + Pay button · `▲ $39.00 left of $75.00` · `✓ Paid` green · nothing when the
   channel collects, e.g. Airbnb), and **Check-in instructions** — a button that stays locked with its
   reason ("Opens after payment" / "Opens Nov 14, 12:00 PM"); the content itself comes later.
3. **Extras**: a carousel of standard upsells — Extra nights, Early check-in, Late check-out,
   Mid-stay clean, Pet, Crib / pack 'n play, Welcome basket. Pick a choice (time / nights / qty),
   see the total, **Request**. Each one becomes a *new upselling request*; "Your requests" lists them
   as Pending until the team confirms.

### Check-in guide and prices from the Repository (2026-11-09)

- `guideFrom(vals)` (pure, tested) reads the Units record's existing fields — `hw_address` (+ Maps link),
  `wifi_network` / `password_2` (copy button), `checkin_from` / `checkout_time`, `parking` / `parking_free_street` /
  `parking_extra_price`, `guest_access`, `house_manual` (links only), `house_rules`, `hw_contact_phone`. Only what is
  filled shows. **No door codes**: cleaner_code / lockbox / admin / backup are the team's; a guest door code needs
  its own decision (Hostaway per-reservation code vs a guest column).
- Fill (23 active records): address 21, Wi-Fi 23, check-in 21, guest access 21, rules 21, parking 16, manual 7, pet fee 13.
- `pricesFrom(vals)`: only **pet = `pet_fee`** exists in Fees today; early/late/mid-clean/crib/basket stay placeholders.
  Owner's next idea (not built): a prices section per extra (icon, price, per hour — e.g. early/late $20/h);
  extra nights need the calendar's availability.
- `GET /api/guest-guide` (permission `repository`): no params → active units; `?unit=<id>` → guide + prices.
  Staff only — feeds the **house picker on `/guest/demo`** (behind sign-in; on `/crew/guest-demo` it never shows).
  The guest's signed link will reuse `guestHouse()`; Wi-Fi never goes out on an open route.
- **Check-in builder (2026-11-09, migration 107 `checkin_guides`)**: Repository → ⌂ Check-in builder. Per unit, arrival
  steps (title · text · optional pin, ≤ 8; `src/lib/checkin.ts` parsePin / cleanSteps / googleDir / appleDir) shown to the guest
  first, numbered, with Google Maps + Apple Maps buttons; then the record's fields (read, never copied). "Copy steps from" another
  unit loads its steps unsaved. API `/api/checkin-guide` (GET `repository`, POST `repository.edit`, audited `checkin.save`).
  Scope agreed: arrival to the building block only (The Links: fob pickup → building door; Cortland: one entrance), not the apartment.
  Pin = coordinates (Google Maps: hold on the spot, copy the numbers) or a long Maps link; short `maps.app.goo.gl` links refused.
  A step may carry a **link** (video/photo, https) → "Watch"; text may quote **`{lockbox}`** (the record's Lockbox, filled
  server-side in guest-guide — a new code is changed once, in the record). **Example seeded in 107**: P2-1304 (Hostaway 586502)
  from the owner's slides `CheckIn_Guide_Unit_1304_EN` — 8 steps garage → lockbox → exit → building → stairs/elevator → door → trash;
  preview `/guest/demo?stay=paid&unit=586502`. Record vs slides (2026-11-09, not changed): floor "First" (1304 is up the stairs),
  lock_type "Access Fob" (the door has a keypad; the fob is the building's), rules typos ("arties", "th registered"),
  and the guest's door code is not in the Repository (slides: "your access code").
- **Shared guides (109, owner 2026-11-09 — "a general repository")**: rows `shared:<slug>` with a `title`; a unit `uses` one.
  Guest = shared steps/items first, then the unit's own (`composeGuide`); tokens {unit} (P2-1304 → 1304), {floor} (record Floor,
  lowercased), {lockbox}. Builder: "Guide" picker lists ◆ shared guides + units; "+ New shared guide"; a unit picks
  "Uses shared guide" and adds extra steps. The Links: `shared:the-links-building-1` (1201/1304/1406, 7 steps) and
  `…-building-4` (42xx/43xx, 6 steps: garage → lockbox → drive to Building 4 → entrance → elevator → door), from the slides
  in Drive folder 1LSTwcKhmI9XcFTTBAH9cJbSWK8KZAmct (videos UNLISTED = open by link). Owner: all The Links units enter with
  the fob (lock_type Access Fob); 2nd digit of the unit = floor; where slides and record disagreed on a lockbox, the slides won.
  Codes never go in docs, tests or migrations — only in the record.
- **Guest portal builder, phase 1 (2026-11-09)**: owner — "simpler is better, the Repository is the base": no separate tool;
  a small **◆ Guide** next to "All details" on active Units rows (and in a record's header) opens it, full width with
  "‹ Repository". Left: pills from the record — values (Unit #, Floor, Lockbox 🔒, Address, Check-in time = tokens
  {unit} {floor} {lockbox} {address} {checkin}; drag into a text or tap to insert at the caret; empty = dashed) and
  ▤ blocks (Wi-Fi, times, parking, what you can use, rules, full guide & phone). Middle: Check-in / Stay tabs; steps as
  cards (⠿ drag to reorder, drop photos on them, pin + video side by side); Stay = ordered blocks (`house[].field`) +
  own text blocks. Right: live phone preview (the real GuestPortal, `embedded`, `.g-scope` palette), "as <unit>" for a
  building guide. Old guides with no record blocks keep the old Stay order. Text fields show {tokens} as pills behind
  the text (`TokenText`, auto-height so they line up).
- **SOP #41** "Guest guide: a unit's check-in steps and stay info" (section Guest lifecycle, feature `repository`, draft v1).
- **Photos open full screen** for guests (owner: "they can't open the photos, they're tiny"): tap → lightbox, ‹ › / swipe, ✕ / Esc.
- **Preston Vineyard**: no guide in Drive (its doc is the listing text); a 2-step test guide from its record (address pin from
  `units.lat/lng`, smart lock) + all Stay blocks; its Parking is empty in the record.
- **Tabs Stay · Check-in · Extras (owner, 2026-11-09 — "check-in is super important, apart")**: Check-in = its own tab
  (steps + photos, or the lock + pay card); Stay = hero, pay, a Check-in shortcut, then the house manual inline under "Your stay".
- **Two sections on the stay page (2026-11-09, migration 108 `checkin_guides.house`)**: **Check-in instructions** = the steps
  (≤ 3 photos each, inline; video link opens in a new tab — owner: "photos inline, videos in a new tab") + address;
  **House manual** = record's Wi-Fi (copy), times, parking, then the builder's items (`house`: title + text, ≤ 10, e.g. Trash),
  guest access, rules, full-guide link, phone. Both locked by the same rule (paid + release time).
  Photos: `/api/checkin-photo` — POST into the record's Drive folder "Check-in photos" (`checkinPhotoFolder`, repo-store);
  GET serves only ids some step names (like comment-image). P2-1304: 14 photos from the pptx (cover left out), folder 1Qe82Uzp2PO4-0a51nbBLREDxuGsujwxi;
  108 moves its Trash step into the house manual.
- Pay stays = the reservation's Hostaway `guestPortalUrl` (Hostaway Payments / Stripe on their side); our own Stripe later.


### Reference: Hostop demo (app.hostop.ai/portal/demo, walked 2026-11-15) — the boss's target for portal v2

- **Home**: greeting + photo, house, address, check-in/out; "Entry instructions locked" card + Start check-in;
  progress "0 of 4"; tiles Wi-Fi · Home guide · Directions · Local guide · Contact host; "Extend your stay"
  (host confirms in 30 min); "Enhance your stay" carousel with prices.
- **1 Guest details**: name*, email*, phone*, home address; arrival window (before 4 / 4–6 / after 6); trip reason;
  pet y/n; parking y/n; adults/children/infants with the house max; optional guest names; opt-in reminders.
- **2 ID**: pick ID type (licence front+back / passport / national ID) → photos (camera or gallery) → selfie.
- **3 Damage protection**: choose **waiver $49 one-time, covers accidental damage up to $1,500** (recommended) **or
  deposit $250 hold**, released after check-out (5–7 business days); exclusions listed (intentional, theft, smoking,
  unauthorised pets, above cap).
- **4 House rules**: 6 rules as title + one line (check-out time, quiet hours, no smoking + fee, no parties, pets
  by arrangement, care) + "I agree" checkbox → "Agree and finish".
- **Upsells** after the steps (skippable): early check-in $40, late check-out $40 (on request), mid-stay clean $75,
  welcome basket $35.
- **Review and pay**: one payment = waiver + extras (Apple/Google Pay, card; Stripe). Until paid: "3 of 4", a
  "Payment pending" card and step 5. **Confirmation**: entry details (door code, Wi-Fi, step-by-step guide) unlocked.
- Kaizen mapping: values per listing in the Repository (waiver price + cap, deposit, rules, restrictions,
  max guests), defaults by unit type (room / apartment / house). ID step = placeholder until Truvi vs Stripe Identity.

### Online check-in v2 (2026-11-15, owner: "the boss must see the portal")

- `src/lib/guest-checkin.ts` (+ test, pure) and `src/screens/GuestCheckin.tsx`. Steps: **Your details** (from the Hostaway
  reservation — name, email, phone, party; the guest only picks arrival window + pet) → **Identity** (placeholder,
  "Complete verification" marks it done; Truvi vs Stripe Identity undecided) → **Damage protection** (waiver once vs
  deposit hold; `protectionFor(unitType, override)`, defaults room 29/1,000/150 · apartment 49/1,500/250 · house 79/3,000/500 —
  placeholders; Airbnb = covered by AirCover, step done) → **House rules** (`rulesList()` splits the record's free text;
  checkbox) → **Extras** (optional; early/late are *on request*, charged only once confirmed) → **Review and pay** (only
  when something is charged/held; Apple Pay / Google Pay / card mock, "Demo — nothing is charged").
- `entry()` replaces the old pay gate on the page: door code + guide + house manual open when every required step is done
  **and** `guideReleaseAt` passed. `DoorCode` shows `stay.doorCode` (Hostaway per-reservation `doorCode` — not verified yet).
- Flow state lives in the page (demo resets on reload). Demo stays: New stay / Checked in / Airbnb (`?stay=unpaid|paid|airbnb`),
  sample house with a sample guide and door 4821. URL: `?sec=checkin&step=<key>`.
- Type: Quattrocento titles + Open Sans text (the public site's), loaded only with the guest page (`useBrandFonts`). CSS `.ci-*`.
- Next: Stripe sandbox (PaymentIntent for waiver+extras, manual-capture PaymentIntent or SetupIntent for the deposit — holds
  last ~7 days), `guest_checkins` table per reservation, Repository fields (unit type, waiver price/cap, deposit, rules),
  real reservation → `GuestStay` from Hostaway, the Access bypass for `/guest/*`. Hostaway's $12/night waiver must go
  before the portal charges one (see finance.md, guest fees).

### Cover photo, door code, early / late (2026-11-15)

- **Cover**: Hostaway gives every listing its photos in order (`listingImages[].url`, `sortOrder`; 55–66 per listing,
  S3 public URLs) → `coverOf()` / `fetchListingCover()` (hostaway.ts); `/api/guest-guide?unit=` returns `photo` = the record's
  **Portal photo (link)** if set, else Hostaway's first. The open demo uses listing 366041's cover.
- **Door code**: Hostaway reservations carry `doorCode` / `doorCodeVendor` ("Hostaway") / `doorCodeInstruction`. Checked
  2026-11-15 on the next 60 stays: filled on 14 — never on 586502/586503 (The Links), 375128 (Preston), 589741/589742,
  608827 (lockbox / fob houses). Portal: show `doorCode` when set; none → the arrival steps (`{lockbox}`) are the way in.
- **Early check-in / late check-out = $20 per hour, every house** (owner); hours over the stay's own times (`hoursOf`).
  `requestMode()`: asked before **8 PM Central the day before** and no turnover that day → `auto` (request `confirmed`,
  charged with check-in); later / same day / turnover → `approval` (charged only if confirmed). Late check-out takes the
  same $20/h (assumed — owner named early check-in).
- Pending: the request → To-do task / $ Approvals + Slack line (needs `upsell_requests` + API), the calendar write when one
  is approved (Hostaway check-in/out time → its smart-lock code window), Stripe.
- **Migration 110** (Repository section "Guest portal": Portal photo, Unit type, Damage waiver price / covers up to,
  Security deposit hold → `portalFrom()`): applied 2026-11-15 — blanks read as the unit type's defaults.
- **Door code by Lock type (owner, 2026-11-15)** — `doorCodeFor(lockType, guestCode, reservationCode)`: smart lock → the reservation's
  Hostaway `doorCode`, else the record's **Guest check-in code** (`guest_code`, migration 111, applied; Preston's Yale has no
  Hostaway code); Access Fob / Keys → no code, the guide's steps (lockbox) are the way in, locked until check-in + pay are done.
  Never configured per house in the portal. The signed guest link must send the code only once `entry()` opens.

### Stripe Checkout for the check-in payment (2026-11-15)

- "Review and pay" opens **Stripe Checkout** (hosted; Apple Pay / Google Pay / Link / card appear there). `functions/_lib/guest-pay.ts`,
  routed through the public door `/api/report-link?checkout=` (POST = create session, GET `?checkout=cs_…` = is it complete) — no new Access bypass.
- Charges + a hold in one session: any hold → `capture_method=manual` on the whole payment; after check-out the team captures what is
  owed (partial capture) and the rest is released. "If confirmed" extras are not sent (charged later).
- The answers are kept in `sessionStorage` (`FLOW_KEY`) before the redirect; back on `?paid=cs_…` the page restores them and marks
  paid only when the server reads `status = complete`.
- Card only (`payment_method_types=card`; Apple / Google Pay ride on it) — the dynamic list offered Klarna, Affirm, Cash App, Amazon Pay.
- **Identity step = Stripe Identity (sandbox)**: `?identity=1` POST → VerificationSession (document + matching selfie; licence /
  passport / ID card) → Stripe's page → back on `?verified=1`; the vs id waits in `sessionStorage` (`VS_KEY`); done when
  `processing` or `verified`. Photos are seen in Stripe → Identity. Truvi vs Stripe still open (Stripe ≈ $1.50 each live).
- **Sandbox only**: lines come from the page (demo stay), so a live key is refused (409). Before live: the signed `/guest/<id>` link,
  bill computed on the server, `guest_checkins` row + webhook. Hostaway's $12/night waiver still to remove first.

### Repository = the portal's single source (owner, 2026-11-15)

- Nothing is set per house inside the portal: lock type → door code (`doorCodeFor`), Unit type (blank → Property type),
  protection values, **Guest services** (migration 112, applied): `svc_*` Offer Yes/No per extra (blank = offered,
  "No" hides it — `notOfferedFrom` / `offered`), Mid-stay clean / Crib / Welcome basket price (blank = catalog). Early/late $20/h
  everywhere, pet = Pet fee, extra nights = calendar price.
- Coverage 2026-11-15 (active units): Wi-Fi + rules + access everywhere except LP-4217 / LP-4222 (no times, parking, rules,
  access); houses have no `parking` text. Arrival guides: The Links (2 shared building guides) + Preston only — Cortland
  (CL-*, Schlage, same complex) needs one shared guide like The Links (arrival photos + where the lockbox / fob is: owner).

### Open demo link for one real unit (2026-11-15)

- `/crew/guest-demo?house=<unit>.<exp>.<HMAC>` (`functions/_lib/guest-demo.ts`, `signHouse(key, unitId, days=14)`): loads that unit's
  guide + photos through `/api/report-link?house=` (photos `&photo=<id>`, only ids its own / shared guide names) — no sign-in.
  Carries the lockbox code and Wi-Fi: hand it only to who should see them. Mint with a one-off script (`.env.local` ENCRYPTION_KEY).
  P2-1406 test link minted 2026-11-15 for 10 years (the team's permanent test). The check-in persists in that browser (localStorage per
  token, "Start over" clears it). Cover: first Hostaway photo that answers — needs `?includeResources=1` on GET /listings/<id> (without it listingImages is empty).

### Look v3: light/dark, one menu, blocked previews, live calendar (2026-11-15, the boss: "Airbnb, but Apple")
- **Palette:** white & black with gold as the focus, light **and** dark — follows the phone until the guest picks (☰ → Appearance, kept in
  localStorage `kaizen-guest-theme`). Tokens in `src/index.css` (`html:root.guest-brand[data-theme=…]`); text-gold is deeper on white
  (#9a6a26, 4.7:1), gold buttons use `--cta` with near-black text. Builder preview (`.g-scope`) stays dark.
- **Type:** Apple's system font (SF on iPhone/Mac), Inter elsewhere (`--g-text`/`--g-display`); Quattrocento/Open Sans dropped.
  Airbnb's Cereal is proprietary — not copied.
- **Navigation:** one floating glass bar (☰ · KAIZEN · sun/moon); the ☰ sheet lists Your stay · Check-in & door code (n of m) ·
  Wi-Fi & house guide (Locked) · Make it better · Call us · Appearance · link to kaizenguestproperties.com. Sections: `stay|checkin|guide|extras`.
- **Home:** photo, name, dates card, check-in ring, four tiles (Door code, Wi-Fi, Directions, House guide) **shown but blocked** (blurred
  value + lock) until `entry()` opens, then the extras carousel inline. Check-in and Guide show a `Locked` preview with "Finish check-in".
- **Extra nights from Hostaway's live calendar:** `guestHouse(…, {arrival, departure})` → `calendar` = `calendarFit()` (src/lib/guest-portal.ts,
  tested): free nights each side (max 7), turnIn/turnOut; a night Hostaway does not list counts as taken. P2-1406 on 11-15: 0 before
  (turnover), 4 after.

### Stripe inside the portal + Airbnb booking box (2026-11-16, the boss: "that it does not leave the portal")
- **Embedded:** with a publishable key saved (Settings → Integrations → Stripe → "Inside the guest portal"), Pay mounts Stripe's
  **Embedded Checkout** in the page (`ui_mode=embedded`, `redirect_on_completion=never`, onComplete → `?checkout=<cs>` state) and Identity
  opens Stripe.js `verifyIdentity` over the page. No key (or migration 115 missing) → the hosted pages, as before. Loader: `src/components/stripe-js.ts`.
- **Wallet domains:** `/api/stripe-domains` lists/registers Stripe payment-method domains with the account's own key (Apple Pay needs it per domain).
  **kaizen-01v.pages.dev registered 2026-11-16 (sandbox): Apple Pay + Google Pay active.** Register the website subdomain when it exists.
- **Migration 115** (`accounts.stripe_publishable_key`) — applied by the owner 2026-11-16; publishable key saved.
- **Booking box (`Reservation`):** Airbnb's outlined box — Check-in | Checkout, a thin gold "Extend stay" strip at its foot; each offers its
  change only when offered and the calendar allows ("Arrive earlier" / "Leave later" / Extend stay → extra nights). Guests and pets are
  small details in the line under the name (owner: little text, self-explanatory; locks say just "After check-in").

### Check-in steps v3 (2026-11-16)
- **Details:** no pet question (pets come with direct bookings later). Arrival = a sliding strip of times (`arrivalTimes()`: check-in → 11:30 PM
  every 30 min, then "After midnight"; first one preselected). **"Request a change"** → short text → "Sent — our team will contact you."
  Kept as `flow.changeAsk`. **Open:** on the real `/guest/<id>` link it must create a task for the team (work module) to confirm with the
  guest — the demo creates nothing.
- **Confirmed states:** after Stripe, the guest stays on the step and sees a gold seal — "ID verified" / "Payment confirmed" ($ today ·
  $ held; `flow.paidTotal` from Stripe) — then Continue. Step header stays left on wide screens (`header.ci-head`).
- **Wallets in test mode:** Google Pay shows only in Chrome with a card saved in the Google account; Apple Pay only in Safari with a card in
  Wallet. Stripe never charges them in test mode. Otherwise card 4242 4242 4242 4242.

### One structure everywhere + extensions paid in the portal (2026-11-16)
- **Island (`Island`, `SecTop` in GuestCheckin.tsx):** every section opens with a round "‹" and an island of its parts — check-in steps
  (`StepIsland`), extras (`ExtrasTop`: all extras, then each), house guide (its blocks, `data-gk`; scroll moves the open one). Paid →
  one pill "✓ Payment" across, no back, "You’re all set" (what was paid stays paid).
- **Home:** the check-in card carries the steps (ring + list + Start/Continue; done steps reopen); tiles = Door code & access · Wi-Fi ·
  Contact (call, never locked) · House guide. Check-in section = that same card at the top, then the door code (top) and arrival steps.
- **Extra nights from Hostaway:** `calendarFit` also returns `nightPrices` (Hostaway's price per free night); the extension picks dates on a
  strip with those prices and is **booked and paid on the spot** (`StripePay`, the embedded checkout shared with check-in). On success
  `flow.extended` → `extendStay()` moves the dates and uses up the free nights. **Open (real link):** re-check the calendar right before
  charging, then extend the Hostaway reservation (blocks the calendar) — a Hostaway write, needs the owner's OK; the demo writes nothing.
- **Covered parking** = an extra (`parking`, per night × nights) where the record has "parking_extra_price"; also in the check-in Extras step.
- No "We confirm" / "Depends on the clean" anywhere: a turnover only changes the request to need our OK.

### Open: guest messages sent by Kaizen instead of Hostaway (planned 2026-11-15; the sender exists since 2026-11-16)

- **Built 2026-11-16 as Guest Services → Inbox — see `docs/modules/inbox.md`:** the outbox + retries + a row per message, templates with
  triggers (after booking, before/after check-in and check-out), staged mode side by side with Hostaway (sending OFF by default).
  Still to do from the plan below: the reservation webhook, "only if check-in not done", the team alert, and switching Hostaway's
  automations off one at a time.

- Plan: reservation webhook → welcome + signed portal link; reminders at T-3 / T-1 only if check-in not done; team alert T-1 6 PM;
  "done" confirmation; code/guide open on arrival; check-out reminder; review ask. Sent through Hostaway's conversation API
  (same channel thread). Airbnb: no waiver/deposit (AirCover); check-in required vs invited = owner.
- **Owner: messages must never fail** — the cron / Slack path has missed before, so Hostaway's automated messages stay ON until
  Kaizen's sender is proven: outbox table + retries + a log per message, draft mode side by side first, then replace one message
  at a time (arrival instructions first). Grows with the restructure, not as a separate project.

### Damage protection per listing + listing texts (owner, 2026-11-23 — migration 122)

- Owner: "$300 deposit or a damage waiver of $70 minimum or $12 a night, whichever is greater" — for every listing, per listing in the
  Repository. Fees: `damage_deposit` (Refundable damage deposit, $300), `insurance_fee` (now titled **Damage waiver per night**, $12 — the same
  field as Hostaway's nightly fee), `waiver_price` (moved to Fees, now **Damage waiver minimum**, $70). 122 fills blanks only. `deposit_hold`
  (Guest portal) is a fallback for `damage_deposit`. `protectionFor(type, o, nights)`: waiver = max(min, per night × nights); the portal passes
  the stay's nights. Defaults = the same values for every unit type (caps still placeholders 1,000 / 1,500 / 3,000).
- **Hostaway descriptions (written 2026-11-23, 23 active listings, all read back):** `scripts/description-protection-notice.mjs` appended a
  "Damage protection: …" paragraph to `description`, `homeawayPropertyDescription` (Vrbo) and `bookingcomPropertyDescription`; the text as it
  was is in `listing_text_changes`. Airbnb's fields untouched (AirCover; Airbnb forbids asking for money outside it).
  **Hostaway's own $12/night Damage Waiver fee was taken off all 31 listings (owner, 2026-11-23)** — `scripts/drop-damage-waiver-fee.mjs`, 62 rows
  (general + Vrbo; the Vrbo row answers 403 but goes with its general row), each kept as JSON in `listing_text_changes` (field
  `listingFeeSetting:<id>`) to put back by POST. Bookings already made keep the fee they were charged. Expedia's own setting (added by hand) is
  separate. `insurance_fee` is now only the portal's rate: no longer compared with Hostaway (repo-checks) nor a Missing-data gap.
- **Check-in guide coverage (2026-11-23, active units):** The Links 10/10 use a building guide (1xxx → building 1, 4xxx → building 4).
  P2-4217 / P2-4222 had empty records — check-in/out times, guest access, rules, parking, phone, address copied from LP-4212 (same building,
  repo_audit). **No arrival steps:** CL 1125, CL 1446, CL1250, CL1339, CL2260, CL2450 (one shared Cortland guide would cover them — owner
  gives the entrance / where to go + photos), Amber Valley, Bobcat House, Concord, Napa Valley, Quest, Timber Crest; Preston has a 2-step test.
  Houses: no Parking text anywhere; Bobcat House has no contact phone. Smart-lock houses get the door code from Hostaway's reservation —
  Preston and Bobcat (Yale) had none on checked stays and have no Guest check-in code in the record.
- **Links checked 2026-11-23:** `https://stay.kaizenguestproperties.com` answers 200 without sign-in (no Access on that host); `/guest/<id>.<sig>`
  loads; a bad signature is refused (403); `kaizen-01v.pages.dev/guest/*` still asks for Google sign-in (Access) — links must use the stay host,
  which `portalLink` does. `/crew/guest-demo` 200. **But the stay link shows only Pending payments** — Phase 2 (the check-in on the real link)
  is not built.

### The real door — Phase 2 (owner 2026-11-23: "what is missing to migrate the guest portal? create it") — migration 123

- `/guest/<res>.<sig>` (`GuestLinkPage`) is the whole portal now, from the server: `GET /api/report-link?stay=<token>` (`functions/_lib/guest-stay.ts`
  `stayGet` → `loadStay`): Hostaway's reservation (`fetchReservationDetail`) + the house (`guestHouse`: Repository, guide, cover, live calendar) →
  `stayFrom` (`src/lib/guest-stay.ts`, tested). `POST ?stay=` saves the guest's answers (`guest_flows.flow`, `cleanFlow`); the page saves every
  change after 350 ms (`remote` prop of `GuestPortal`). Pending upsell charges (§178) show under the page.
- **What the page cannot bend:** `identity` / `paid` are never read from the page — `identity_ok` is set when Stripe Identity says verified /
  processing for the session THIS stay started (`identity_vs`), `paid_ok` when the Checkout session made for this reservation (`metadata.purpose =
  checkin`) completes (page check or the webhook → `guest_payments`, reconciled on the next load). The bill is the server's (`stayLines`: `bill()` from
  the saved answers, or one extra by `quote()`); the page's lines are ignored. So the real link may use a **live** Stripe key (`anyKey`); the demo
  stays test-only.
- **Locked until `entry()` opens** (all required steps + `releaseAt` = noon Central the day before arrival): `lockedStay` sends only the rules and
  times — no address, Wi-Fi, steps, manual, phone or door code; guide photos (`?stay=&photo=`, `guidePhoto`) also wait. Door code = `doorCodeFor`
  (Hostaway's reservation code, else the Repository's Guest check-in code).
- **Steps done** → `guest_checkins` (source `portal`) + `fireStay` (the "After online check-in" automations) — even before the release time. A stay the
  team marked in the Inbox counts as done. **Request a change** → one high to-do on the stay ("Guest asked for a change: …", again only if the text
  changes; a failed insert is retried on the next save). **An extra paid on the link** → an urgent to-do once per Stripe session (set it up: hours in
  Hostaway, extend the reservation, prepare the clean / crib / basket / parking).
- Tested 2026-11-23 on Neon branch `test-portal-door-1123` (br-little-firefly-b5spv6vu, Slack/Drive/Hostaway tasks off, sending off) with real stays:
  P2-1201 Vrbo (locked; page's `identity/paid: true` ignored; Stripe test session billed **$70** by the server against a fake $1 line; identity
  session started; change to-do made once; with Stripe's marks simulated → steps done → guest_checkins 'portal', still locked until Nov 29 noon);
  Quest (Vrbo, in house) and CL 1125 (Airbnb) → entry open with Hostaway's door code, address, Wi-Fi, pins (Google + Apple Maps), Cortland video;
  phone screenshot fine. **Not tried:** a real card / ID through Stripe's own pages on the link (test the full flow once on a phone), the webhook path.
- Arrival guides 2026-11-23: **Cortland** = `shared:cortland-building-1|2` (1xxx / 2xxx, like The Links), from the CL-1125 / CL-2359 house manuals:
  drive (pin), call box (owner 2026-11-23: one code for both buildings, stored only in the guide rows;
  entrance pin 33.0884292, -96.8424110 — the owner gave the same point for both buildings); step 3 = `{to_floor}` (new token: "It is on the
  first floor — no elevator needed" / "Take the elevator to the <floor> floor"). Photos (owner): Building 1 entrance + the CL-1125 map (steps 1–2),
  Building 2 front (step 2), in CL-1125's Drive folder "Check-in photos". Building 2 route (owner, 2026-11-23): main entrance → call box →
  right → first door on the left past the red EXIT sign = parking garage → stairs, or the elevator behind the column on the right (another one on
  the opposite side if it is out of service; map on that step) → floor → door, elevator to {floor}, door code; house items gym/pool fob, trash chute,
  check-out. Building 1 units get their own Drive video (1446, 1339, 1250, 1125, 1425, 1350, 1235 — shared by link). **Houses** (Amber Valley, Bobcat, Concord, Napa, Quest, Timber Crest,
  Preston): arrive (address + Maps pin from `units.lat/lng`) → smart-lock keypad with the door code. Preston's code: Guest check-in code ← the
  "Front door code" written in its Elevator field.

### Stripe live (owner, 2026-11-23: "send the real one")
- Settings → Payments accepts live secret / restricted keys and `pk_live_` now (both must be the same mode — `embedKey`). The real stay link and
  upsell pay links run on it; the open demo (`/crew/guest-demo`) stays test-only and refuses to pay with a live key. **Vendor payouts by Stripe
  refuse a live key** (`LIVE_PAYOUTS_OFF`, payouts.ts) until the owner switches them on.
- **Test stays** (owner, 2026-11-23): `node --env-file=.env.local scripts/test-stay-link.mjs <listingId> [direct|airbnb] [YYYY-MM-DD] [nights]` mints a real /guest/ link for a made-up stay (id 77…, `testReservation()`): real house + live Stripe, nothing read from or written to Hostaway, no "after check-in" messages. To-dos it makes carry "Test Guest".
- **Airbnb protection** (owner, 2026-11-23): Airbnb guests see the waiver / deposit too, plus a small "None of them" (`protection: 'none'`, Airbnb only) with a note that any damage goes to Airbnb as a claim, likely charged in full. No more "Covered by Airbnb".
- **Identity step hidden** (owner, 2026-11-23): `IDENTITY_STEP_ON = false` in guest-checkin.ts — Stripe Identity (live) applied for, flow
  not finished. Hidden from the list and not required for the door code (server uses the same `steps()`). Flip to true to bring it back.
- ⚠ **Deposit holds last ~7 days** (card authorisations): a guest who checks in early and picks the deposit makes the WHOLE payment manual-capture
  (extras in it too) — not captured within 7 days, it lapses. Proposed: deposit = card saved for off-session (no hold) and charge only on damage;
  owner to decide before the deposit is offered live.

### Rules

- Pay state = `total − paid` (≤ 0 → paid); channel `airbnb`/`vrbo` → collected by the channel, no gate.
- Check-in instructions open only when nothing is due **and** `guideReleaseAt` has passed.
- Extra nights only as many as the calendar gap before/after the stay allows (0 → card says "Not available").
- Early check-in / late check-out on a same-day turnover stay requestable but flagged
  "Depends on the clean" — the team confirms; never promised by the page.
- Prices in `UPSELLS` are placeholders until the owner sets them (per house later).
- An upsell is **requested, not charged**: the team confirms, the charge is added to the reservation,
  and the guest pays it with the same pay button.

### Payments and Hostaway (checked on real stays, 2026-11-05)

- Every Hostaway reservation (Airbnb, Vrbo, Expedia, partner, direct) has **`guestPortalUrl`**
  (`guest-portal.hostaway.com/<reservationId>/…`) — Hostaway's own guest portal for that stay, where the guest
  sees the stay, signs and **pays through Hostaway Payments (Stripe; `stripeGuestId` is set on direct/Vrbo/Expedia)**.
  Also `paymentStatus` ("Paid", "Unknown" on Expedia…), `totalPrice`, `financeField[]`, `reservationFees[]`;
  `remainingBalance` and `isPaid` came back null on every stay checked.
- So **Pay = open the guest's own `guestPortalUrl`** (`payFromHostaway()`): automatic per stay, no card handling
  in Kaizen, nothing new to contract. Our page is the layer that sells (extras, status, instructions); Hostaway's
  portal is where the money moves. The URL is a login token: served only on that guest's signed page, never logged
  or sent to Slack (as `hostaway.ts` already says).
- Upsell money: when the team confirms a request, Kaizen adds it to the reservation (a fee / `financeField` line)
  so it shows in that same portal to pay. That is a **write to Hostaway** — the exact endpoint is not tried yet and
  needs the owner's OK (standing rule). Until then the team adds the charge by hand in Hostaway.
  *(Superseded 2026-11-19, §178: an upsell is charged from its case — Stripe pay link + Hostaway hold — see the end of this file.)*
- `paymentStatus` "Unknown" is not "unpaid": no warning on what Hostaway does not know.

### Open items

- Table `upsell_requests` (account_id, reservation_id, kind, choice jsonb, quote, status
  new/confirmed/declined/paid, created_at) + `functions/api/guest-*.ts` with a per-stay token like
  `/report#w=` (§137) — not written; the page's `send` is the seam.
- Real stay data from Hostaway (photo, times, balance), the release-time rule, the Access bypass for `/guest`.
- Team side: requests into To-do / Approvals and a Slack line; the SOP is written with it (the page is
  guest-facing, not a team screen — no `FEATURES` entry).

### Extras paid on the spot + the books (2026-11-17, §176)

- Owner: nothing waits for an OK — the payment is the confirmation. `requestMode`/`centralInstant`/`upsellRequest` deleted;
  `paidExtra` / `PaidExtra` is what the page keeps ("Your extras · ✓ Paid"). Early / late on a same-day turnover:
  `availability` → `{ ok: false, why: 'turnover' }` ("Not available — another guest that day"), also off the check-in bill.
- Every extra's Pick pays through `StripePay` (the embedded checkout); `BillLine.item` names what was sold, and `StripePay`
  sends the stay (id, unit name, guest) → session metadata → `guest_payments` (119, finance module).
- **Open (Phase 2, the real link):** a paid extra must create the team's to-do (early check-in → the cleaner and Hostaway
  times, mid-stay clean → a clean, crib / basket → prep) and attach the payment to the reservation and its listing — the demo
  knows only the unit's name, so test payments land as "portfolio-wide".

### Upsells charged from the team's side (§178, owner 2026-11-19)

Owner: "an upsell made in the CRM or in To-do runs from the finance side, connected to Stripe, everything set up — except Airbnb:
there, the link to the Resolution Center or to change the dates. Otherwise do it all from there: block the dates, make the pay link /
the extra charges, and show them in the guest's portal as pending payments."
- **One block, two doors:** `src/components/UpsellCharge.tsx` — in the case's panel (Operations → To-do → Claims & upselling,
  `ClaimCase`, open upsells and Stripe-paid ones) and in the Inbox (the chat's + → Upsell → "Next: charge" opens it in the same pop-up).
- **Rules** `src/lib/upsell-charge.ts` (+ test): `needOf` (Extra nights → nights, Early check-in → checkin, Late checkout → checkout,
  rest → amount), `isAirbnb` (Hostaway `channelName`), $20/h (`hourPrice`, same as the portal), `freeAround` / `nightsPrice` (calendar),
  `airbnbLinks` (Resolution Center + `hosting/reservations/details/<HM>`), the guest messages. New kind **Extra nights** in `UPSELL_CATEGORIES`;
  `COLLECTED_VIA` + **Stripe**.
- **Server** `functions/_lib/upsell-charge.ts`, API `/api/upsell-charge` (permission `claims`): the plan (stay read from Hostaway,
  nights ±7 days), `create`, `cancel`. **Hold first, charge after:** nights blocked one by one with `setNightOpen` (read back; any failure
  reopens the ones done, nothing charged); hours through the board's `pushStayTimes` (its log `stay_time_pushes` decides). Airbnb: no charge,
  no block (an alteration needs the nights open) — the amount is saved as requested, "Resolution Center" unless it is nights.
- **Pay link** `/api/report-link?pay=<id>.<sig>` (`signCharge`, guest-link.ts) on the portal's domain (`guest_portal_url` origin, else this
  host): a small Kaizen page → `&go=1` → Stripe Checkout (open session reused) → `&done=<cs>` records it. Metadata `source=guest-portal-charge`,
  `charge`, `claim` → `recordSession` → `settleCharge` (`charge-settle.ts`, `status='pending'` guard = once): live → case received +=
  amount, via Stripe, status Paid, Slack claims line; test → charge paid + note, no income. `guest_payments.claim_id` keeps it out of Portal sales.
- **Portal:** `/guest/<res>.<sig>` (`GuestLinkPage`) — until Phase 2 it shows only the stay's **Pending payments** (and paid ones) from
  `/api/report-link?charges=<res>.<sig>`.
- **Migration 120** (`upsell_charges`, `guest_payments.claim_id`, the `claims_collected_via_check` with Stripe) — written, NOT applied; needs 119 first.
  Tested 2026-11-19 on Neon branch `test-upsell-charge-1119` (br-shy-fire-b51yaybf): Airbnb plan on a real stay, Vrbo nights plan (0 free both
  sides, correct), Pet fee charge → pay page → Stripe test session (reused on a second tap), portal charges (bad signature refused), settle
  twice = once, cancel → "Nothing to pay". **Not tried: the Hostaway writes** (blocking nights / setting the hour) on a real listing, and a
  real Stripe payment back through the webhook.
- Open: extending the reservation's own dates in Hostaway after a paid extension (manual — the block holds the nights); a Stripe test payment
  end to end; the full portal on the stay link (Phase 2).

#### Round 2 (owner, same day, after the audit) — migration 121
- **How the guest pays** (`methodsFor`): card everywhere; Airbnb also the **Resolution Center** (`method = 'rc'`: "Log the RC request" →
  "Mark received" with what came in → `rcReceived`). Airbnb + Extra nights also offers **Change it on Airbnb** (the alteration; nothing logged).
  The hour is set from Kaizen on Airbnb too.
- **Nothing moves before the money** (owner: "only block with a confirmed payment"): `createCharge` only checks it is possible (nights free, hour
  valid); `charge-settle.ts` applies after the payment (`applyPlan`): hour → `pushStayTimes`; nights on a **direct** booking (`isDirect`) →
  `PUT /reservations/<id>` with the new dates, read back (and a warning if Hostaway changed `totalPrice`); on a channel booking (Airbnb paid
  outside, Vrbo, Booking, Expedia) or when the extension is refused → the nights blocked in runs (`runsOf`, one PUT each, read back) + an
  **urgent to-do** due today on the stay and the case (`followUp`: door code, clean, check-out messages). Any refusal → urgent to-do
  "Paid upsell not set up" + `apply_error`. Test card → no income and **no Hostaway** (a test card must not block a real calendar).
- **Pay page** re-checks before opening Stripe (`stillPossible`): a cancelled reservation cancels the charge; taken nights stop the payment.
  No idempotency key (a reused key after an expired page handed back the dead page).
- **Without a webhook** (owner sets Stripe later): `POST /api/slack-cron?job=charges` → `sweepCharges` (pending card charges with a Stripe page;
  the first finished one is recorded). Called by the clock (`clock/index.ts` — **needs `npx wrangler deploy` in `clock/`**) and hourly by
  `.github/workflows/slack-cron.yml`.
- **Refunds** (`syncChargeRefund`, from `recordSession`): the refunded part comes off the case; all of it → Resolved, received 0. Hostaway is not undone.
- **Portal sales** lists upsell-link payments apart ("Upsell links — counted in Claims & upselling"); Kept and Stripe fees include them.
- Migration **121**: `method`, `applied_at`, `apply_error`, `refunded`, `todo_id`; unique pending charge per case. SOP #3 v8: `.sop-121.mjs`.
- Tested on Neon branch `test-upsell-charge-r2` (2026-11-19): RC on a real Airbnb stay → Paid, nothing in Hostaway; RC refused on Vrbo; one pending
  per case; card link → pay page → Stripe test page; sweep; "paid but not set up" → urgent to-do; partial + full refund. **Not tried: the
  reservation extension PUT and the calendar block on a real listing** — watch the first real paid extension.
