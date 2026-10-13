# Module: operations

Kaizen runs the day's operations (the daily file sheet is an archive). Tab **Operations**:
Movements (the board, §124) · To-do (→ work module) · Cleaners (view key `crew`; inside it 👥 Pages & approvals and 📅 Calendar, view key `calendar`) · Inspections ·
Inventory (§134) · Notes log · Rates & rules · Setup. Plus the **crew page** each cleaner sees (§122).

## Files

- Screen: `src/screens/Operations.tsx` (Board, Setup incl. StarSetup/CrewSetup, Inspections, CleaningsMonth…),
  `src/screens/Crew.tsx` (CrewHome = the cleaner's page, CrewAdmin = Operations → Cleaners; one CrewView for both),
  `src/components/CleaningCalendar.tsx`, `DayPicker.tsx`.
- API: `crew.ts` (cleaner, behind Access), `crew-link.ts` (secret link, SELF_AUTHENTICATING, reads
  no identity header), `crew-admin.ts` (team: GET `operations`, POST `operations.edit`),
  `operations.ts`, `turnover.ts`, `inspections.ts`, `manual-clean.ts`, `ops-settings.ts`,
  `stays.ts`, `cleaning-log.ts`, `cron.ts` (Host Note pass, reconcile).
- Server libs: `crew.ts` (loadCrewPage, scheduleState, confirmSchedule, crewGet/crewPost, Drive evidence),
  `ops.ts` (recordCleanings, reconcileRecent, pushHostNotes, opsConfig),
  `daily.ts` (daily-file CSV readers), `cleanings-import.ts`, `sync.ts`.
- Pure lib: `src/lib/crew.ts` (periodOf, buildInvoice, scheduleMovements, movementText);
  `src/lib/operations.ts` (star rule: zoneOf, requiredStars, pickByStars,
  assignByStars, typicalNightly; old tier rule `assign`; rateFor, sameGuest,
  oneCleanPerUnitDay, mergeHostNote, proposeInspections, hostawayReservationUrl), `dates.ts`.
- Inventory and the field (§134): `src/screens/Inventory.tsx` (Operations → Inventory; `InventorySetup` =
  Setup → Inventory), `src/components/FieldReport.tsx` (report or ask, one question per screen),
  `CleanSteps.tsx` (the 4 steps) and `PhotoPicker.tsx` (camera / gallery, shrink) — used by the cleaner's
  page (`CleanCard`, `PastCard`, `TodayCleans`, `QuickActions` in `src/screens/Crew.tsx`) and by `/report`
  (`src/screens/Report.tsx`, the helpers' page); server `functions/_lib/clean-record.ts` (records,
  photos to Drive, done/reopen), `clean-slack.ts` and `crew-slack.ts` (→ slack module);
  API `inventory.ts` (GET `operations`, POST `operations.edit`), `inventory-items.ts` (`operations.setup`),
  `report-link.ts` (SELF_AUTHENTICATING, `X-Report-Token`; GET the clean, POST photo/taken/nothing/
  done/reopened/problem/request/missing/purchase), the crew handler's `cleanLink`/`cleanPhoto`/`cleanTaken`/
  `cleanNothing`/`cleanMark`/`supply`/`problem`/`request` actions and `GET ?photo=`; server lib `functions/_lib/inventory.ts`;
  pure `src/lib/inventory.ts` (stockLevels, reconcile, unitUses, perClean, needByPlace, toOrder, orderList) and the
  places in `src/lib/unit-access.ts` (supplyPlace, placeLabel, inventoryPlaces); server `recordPurchase`, `fieldPurchase`,
  `cleanTodo`, `setMins` (functions/_lib/inventory.ts); `FieldPurchaseLines` (Inventory.tsx) in the approval.
- Script: `scripts/whatsapp-cleanings.mjs` (crew chat history, one-off).

## Tables

`cleanings` (record: `void_reason`, `decided_by` rule / rule:stars / override:…, `source` kaizen/sheet/manual/history,
`MAN-<n>` manual rows), `turnover_overrides` (NULL = the rule decides), `cleaners` (roster,
rate cards, `stars` 1–5, `zones` [] = all, `max_per_day` NULL = no limit, `email`, `invoice_period`,
`link_token_hash`), `accounts.assign_rule`, `accounts.crew_calendar(_days)`, `crew_extras_folder`,
`cleanings.flag_note/flagged_by/at`, `cleaning_extras` (+ `cleaning_extra_files`), `crew_declines`,
`crew_schedule_confirms` (snapshot jsonb), `accounts.ops_rules` / `ops_mode`, `stay_notes`, `inspections`,
`extra_inspectors`, `host_note_pushes`, `inventory_items`, `inventory_moves` (057; kind `taken` 061; `place` 068, `purchase_id` 069),
`inventory_place_mins` (068), `inventory_orders`, `inventory_purchases` (069), `todos.clean_key` (069) + `clean_group` (070), `inspection_checks.supply_id/qty` (069),
`accounts.field_reports_folder`, `clean_links` (058), `clean_records` (+ `supplies_at/by/none` 061) / `clean_photos` /
`clean_marks`, `accounts.clean_photos_folder` (059), `clean_slack_posts` (060). (057's `cleaners.report_token_*`
were dropped in 058.)

**Setup by section (§134, owner):** ⚙ General (who decides, daily-file import, Hostaway tasks mirror,
guest documents) · 👥 Cleaners & pay (roster and rates, levels, assignment rules) · 🧹 Crew pages ·
🔍 Inspections (due rules and who inspects, checklist, vendors) · 📦 Inventory (the supplies list, moved
out of the Inventory view). Every view has a "⚙ Setup" chip by Refresh that opens its own section
(`SETUP_OF` in Operations.tsx). "By cleaner" was removed (the crew pages replaced it); its SOP feature
key had no SOPs.

## Rules that bite

- **`ops_mode = 'live'` since 2026-09-25**: Kaizen decides and writes Host Notes; the
  Cleanings Log import refuses in live mode. One writer per record (§64, §68).
- The board = Hostaway (stays) + overrides + rules; nothing re-decided from the sheet.
  "Today" is New York's (§63, §64).
- Live rules: next-booking horizon 10 days, long vacancy 7 days. The team assigns
  P2 → Veronica, CL → Michelle by hand (overrides), not by the tier rule (§65) — zones replace that.
- **Levels (§125)**, replacing stars once switched: `cleaners.level` high (K&M, Irene) / standard
  (Veronica) / manual (Michelle — never picked by a rule). Needs high: a stay ≥ `levelLongStayNights`
  (10) with no mid-stay clean (`kind = 'mid_stay'`, MAN- rows) in its last `levelMidStayDays` (5) days;
  else the next guest decides if they check in < `levelNextWithinDays` (4) days after: ≥
  `levelHighFromNightly` ($200/night) high, else standard (a priceless block → standard). Else **TBD
  waiting** — not in "Needs attention" until the day before, then "▲ assign by hand". Pick: level or
  above, not manual, zone, under max, not declined → cheapest → fewer cleans that day; high cleans
  first; nobody → TBD (no "below" fallback, no flag). Mid-stays must be registered in Kaizen ("+ Mid-stay
  clean") or a long stay reads as high (owner accepts the risk). The "below stars" flag is gone.
- Stars (§121, retiring): required = band of the next guest's **price per night** (inside the horizon; else
  the unit's median nightly over loaded stays; else `starDefault`) + stay length (+1 ≥7, +2 ≥20)
  + 1 same-day turnover, cap ★5. Pick per day, most demanding first: active, covers zone, under
  max, stars ≥ required → cheapest (unpriced last) → fewer cleans that day → more stars. None →
  most stars, flagged below. Overrides take their slot first. Bands live in `ops_rules`.
- Setup → "Who cleans: by stars": Save is disabled until a Preview of the exact proposal
  (`previewAssign` rebuilds the board from `OpsState.boardInput` — one Hostaway load).
- The record: excluded, never deleted (`void_reason`); one unit, one day, one clean; the past
  is frozen; daily pass reconciles the last 45 days (§70).
- Manual cleans (early departure / mid-stay / extra); early departure makes the checkout
  clean "no clean needed"; undo restores (§79).
- Host Note: `mergeHostNote` replaces only Kaizen's line, keeps hand text, pushes only when
  our block changed, verifies by reading back; archived listings refuse (403) — skipped (§64, §70).
  The scheduled push runs from `/api/slack-cron` (the 5-minute clock), at most once an hour (`slack_sent`
  key `hostnotes:<UTC hour>`): `/api/cron` sits behind Access and nothing calls it, so before 2026-10-12
  only stays someone edited got their note.
- "Not needed" / "TBD" are states, not cleaners; match on words, not emoji (§57).
- Bulk writes with `unnest`, never one INSERT per row (§62).
- Ops role sees the board without booking values (`money` permission) (§63, §65).

- Crew page (§122): a cleaner = an Access sign-in whose email is on the roster → role `cleaner`,
  permission `crew` (not assignable; opens /api/crew + /api/settings only); exempt from the
  allow-list; a member row for the same address wins and roster save refuses a member's address.
  **Cleaners never see stars** — stripped from the payload, not just hidden.
- Invoice = done, assigned, not-void cleans in the period — per cleaner: **weekly Saturday–Friday, paid
  the next Saturday**, or **monthly, the whole month, paid in the first days of the next** — + approved extras on
  them; void rows listed as "not paid" with the reason; unpriced counted, never $0.
- Extras: cleaner, own clean, done, ≤60 days, ≤$500, optional receipts/photos (≤5, 15 MB, image or
  PDF) to Drive "Kaizen — crew extras" uploaded BEFORE the row is saved. Team approves (note
  optional) or denies (note required); only pending can be decided or withdrawn.
- Flag by hand = a note the cleaner reads; does not change pay. Set from Operations → Cleaners or from
  Movements (§124): a departure's editor, a manual clean's row, a recorded day's row (same
  `crew-admin` flag/unflag; needs the record row, so not in shadow mode).
- Movements (§124) = the board in a date window, default today + 10. From today on it is live
  (Hostaway + rules, `days` up to 30, never fewer than 10 so the other views keep their window);
  days before today read `/api/cleaning-log` (the record: departures + manual cleans, no arrivals),
  with not-paid rows listed. The strip counts the live rows in the window, plus "before today".
- Schedule shown only with `crew_calendar` on (Setup → Crew pages): live board, `crew_calendar_days`
  ahead. **Exception (§123): what a person assigned (override, or a MAN- clean) shows at once**, calendar
  off or not, and can be declined. The team **confirms** it (Operations → Cleaners) = a snapshot; cleaners see "last confirmed"
  and movements since (moved/extended, shortened, cancelled, declined, reassigned, new, time);
  after the snapshot's last day = "not confirmed yet".
- Decline: only with the calendar on, only a clean the board gives them now → override `tbd`
  (`declined by <name>`) or, for MAN-, the record set tbd; `crew_declines` row; the star rule
  never hands it back to them; board shows "▲ declined by X — reason"; live mode pushes the Host Note.

- **Cancellations (§123).** Hostaway's `cancellationDate` (taken as UTC → New York). Cancelled before
  the arrival day → no clean (void, as before). On or after it → the guest may have used the unit:
  the clean is **TBD, unpaid, `needs_confirm`**, proposed that day if cancelled before noon NY, else the
  next, never past the original checkout. Board shows "▲ cancelled … — confirm who cleaned"; the rule
  never assigns it; no Host Note pushed. A person settles it: on the board (an override) or Operations →
  Crew → "Cancelled after arrival — confirm" (who cleaned + date + deep, or no clean needed) →
  `confirmed_by`; reconcile and record never undo a settled row. `fetchCancelledTouching` skips iCal.
  Only rows already in the record are held (older never-recorded cancellations are not back-filled).
- Operations → Cleaners: pick a cleaner → their page for the team (level, flag/correct/decide), or
  **👁 View as cleaner ↗** — a separate tab (`/#as-cleaner/<name>`, PreviewShell in App.tsx) with only the
  cleaner's page, loaded through `crewGet` (the cleaner's own server code: level stripped), buttons inert.
- **Inspections as a checklist (§133).** Template `inspection_items` (area, label, default_outcome
  repair|purchase|clean, position, active) — Setup → 🔍 Inspections → Inspection checklist (CRUD, reorder; an item
  already answered is switched off, not deleted).
  **§138: areas are data** — `inspection_areas` (key, label, per_room, position, active; items FK to it): the six
  built-ins + "Pool & hot tub", and any the team adds (key from the name, `areaKey`), renamed, reordered (the walk),
  switched off (its items leave new inspections), removed only when empty and never used in a finding. Only
  bedroom/bathroom repeat per room. **Each item applies to** `applies_to` all | house | apartment | units
  (`unit_ids`) — `appliesHere` in `src/lib/inspection.ts`. House/apartment = the Repository's **Property type**
  column of the Units tables (Houses = House, Cortland_Legacy / The Links = Apartment, 067), read by
  `unitTypes` (`functions/_lib/unit-access.ts`, same `repoMatch` as the access); a unit without it gets only the
  items for all units and its own, and the setup flags it (▲ no type). The pool item applies to Bobcat House and
  Amber Valley only.
  A run (`/api/inspection-run`, lib `functions/_lib/inspection-run.ts`, pure `src/lib/inspection.ts`, UI
  `src/components/InspectionRun.tsx`): sections from the unit's bedrooms and bathrooms (half bath = one),
  each item ✓/▲/N/A saved on every tap (`inspection_checks`), "Everything else here is OK", fixed
  Cleaning/Repair/Purchase buttons for on-the-spot findings; a finding needs an outcome — a photo is optional
  everywhere (Drive folder "Kaizen — inspections"; the owner: photos are never required). Review & finish is a step wizard (the owner's flow): 🔧 Repairs → 🛒 Purchases →
  🧽 Cleaning → ✓ Finish, each with editable notes, "move to another kind" and "Confirm & continue". Finish
  (validated BEFORE anything is made, idempotent via todo_id / clean_task_id): repairs → **ONE work order for
  all of them** (§146 — one each only when there is exactly one; `repairList`), a sub-task per repair plus
  "Assign and schedule"; ALL purchases → ONE to-do "Buy for <unit>: N items", a sub-task per item; cleaning →
  one choice for the group (`cleanMode`): clean_next →
  `clean_tasks` on the unit's next clean in the record (board 🧾, cleaner's page "From the inspection");
  clean_new → one MAN- extra clean, TBD, carrying them; overall result suggested (OK / Minor issues /
  Maintenance needed). Repairs/purchases are mirrored to Hostaway (pushWork after the response); not
  announced in Slack. Inspections view: Inspect now / Schedule, month calendar (○ ◐ ✓ ▲), ▶ Start/Continue,
  View report; the old log form is folded ("past inspection without the checklist").
- **The inspector's link (§135).** Operations → Inspections → a scheduled row → **🔗 Link** (WhatsApp / copy):
  `/report#i=<token>`, no account — the helpers' field door (§134), so no new Access bypass: `/api/report-link`
  with `X-Inspect-Token` goes to `functions/_lib/inspect-link.ts` (team side: `/api/inspection-run` action `link`,
  `linkFor`). Columns on `inspections` (062): `link_token_enc/hash`, `link_expires_on` (the day after the
  inspection), `sent_at/by`. Page `src/screens/Inspect.tsx`: the name once (this phone remembers it), then
  **the team's own sheet** — `InspectionRun` with a `RunTransport` over the link (the owner: the link shows the
  same view), English like the team's; its foot is "Send to the team" instead of Review & finish, and a sent
  inspection is read-only with "Reopen" confirmed in place. **The inspector only sends** (every item
  answered); the row then reads "📨 Sent from the link by X" and ▶ Review opens the team's
  run, where Review & finish makes the work. Reopen from the link clears `sent_at`. Refused when expired,
  finished or cancelled. App.tsx reads `#i=` before `#t=`; the phone remembers which it opened last.
- **Purchases reach Costs (§137):** a purchase from the field (the cleaner's page; §141: no longer the helper's link — the menu omits "I bought something" and `/api/report-link` refuses `purchase`) needs its total — the
  form and the server require it — and becomes a `field_expenses` row waiting for approval in
  Operations → Cleaners ("Purchases & charges waiting for approval": who, unit, amount, receipt; deny needs a reason);
  approved → an expense (Restock) on its unit. The team's purchase in Inventory → Record a move takes a
  cost and goes to Costs at once. Approved extras and every clean's pay are in Costs too (finance module).
- **How cleaners get in (§136):** `src/lib/unit-access.ts` (pure, tested: `repoMatch`, `unitAccess`) +
  `functions/_lib/unit-access.ts` (`accessByUnit`). Address and Wi-Fi (and Hostaway's door code) come from
  Hostaway into `units.address / wifi_name / wifi_password / door_code` (063) on every units sync (Settings →
  Sync listings); the lock type, **Cleaner Code** (`cleaner_code`; the Houses typo column `clener_code` is gone, §147),
  Lockbox and Keys/Fobs from Repository → Units (Cortland_Legacy, The Links, Houses), matched by name, else
  by unit number (P2-4308 = LP-4308), else a name inside the other. Codes go only to the cleaner's clean
  of TODAY (crew GET `access`) and to that clean's helper link while it lasts; coming cleans get only the
  address. Hostaway's door code is the guests' — shown only without a cleaner code, and said so. Admin and
  backup codes never leave the server. Shown folded ("🔐 How to get in & Wi-Fi", `AccessBox.tsx`).
  Setup → Crew pages → "How cleaners get in": per active unit, there / missing, never the codes.
- Scheduled inspections on a phone: each row starts with the unit, its day and inspector, and the buttons
  (▶ Start/Continue/Review · 🔗 Link · cancel) — they were in the last column, scrolled out of sight.
- **Vendors (§133):** `vendors` directory (Setup → Vendors & handymen; switched off, never erased); the repair
  form's Vendor field suggests them (free text kept). §137: the email is how a handyman signs in (role
  `vendor`, their work orders only); without one, "📤 Send to vendor" in the work order gives a link
  (work module). A handyman's charges wait in Crew → "Purchases & charges waiting for approval" (🔧).
- **Carry (§131):** the record stores `prepares_for` (the next reservation when recorded). A rule-decided
  clean before guest X held by A: if a booking lands in between, the original checkout is decided again by
  the new guest, and A takes the new booking's checkout (the clean now before X) — `applyCarry`, before
  the star/level passes, `row.carried`, board "↪ kept from the … checkout", decided_by `rule:carried from …`.
  A person's choice never moves; works only from the first record that has `prepares_for` (Oct 11 on).
- **Cancelled before arrival (§130):** `voidCancelled` — void_reason "booking cancelled in Hostaway",
  assignment `not_needed`, cleaner/price NULL, decided_by "cancelled before arrival — it was X's". A booking
  that comes back is restored as TBD (unassigned). Migration 054 fixed the 8 rows that kept a cleaner.
- **Spanish for cleaners (§129):** `cleaners.lang` (en/es; Setup → Crew pages "Page language"; the cleaner
  switches it on their page → `setLang`, remembered). Everything the cleaner reads goes through
  `src/lib/crew-i18n.ts` (TX dictionary, dates, periods, paydays, Kaizen-written void reasons, movements,
  invoice work, .ics) and server messages in `crewPost` (`say(en, es)`). Notes a person typed stay as written.
  The team's side stays English. SOP #13 "Tu página de Kaizen (para cleaners)" = feature `crew.page.es`
  (draft); the page shows the help SOP in the cleaner's language. New sentences must be added to BOTH
  languages (a test checks the keys match). The Cloudflare sign-in screen itself is English.
- **Flag + pay (§128):** ⚑ Flag (board row, Movements past, manual cleans, Crew page) takes an optional
  corrected pay for a clean due today or before ("Flag and correct pay") → `edited_by/at`, `edit_note` = the
  flag note. `recordCleanings` and `loadOps` keep a corrected price/deep while the same cleaner holds the clean.
  The flag form also has "deduct $" (price − amount → the corrected pay; the note gets "(−$X deducted)"); it works
  on past cleans (Movements past rows), board rows and manual cleans, all once the clean is due and priced.
- **SOPs (§128):** drafts #10 "Cleaners' pages: what they see, and the team's part" (operations.crew,
  operations.board), #11 "Give a cleaner access to their page" (operations.setup, operations.crew), #12 "Your
  Kaizen page (for cleaners)" (feature `crew.page` — once PUBLISHED it shows on the cleaner's page as "❓",
  via `crewGet` `help`); #2 mid-stay updated to v2. Written in English (UI rule) — a Spanish version for the
  crew is the owner's call. The "Schedule shared" card with a Confirm button is gone (daily snapshot does it).
- **What cleaners see ahead (§127)** — `visibleAhead` (src/lib/crew.ts), one rule for the crew page,
  declines and the board: the whole schedule if published (`crew_calendar`); else what a person
  assigned (override / MAN-) plus the rule's picks within `crew_auto_days` (default **4**). The team
  verifies nothing: the board marks those rows **👁** (only if the cleaner has an email or a link).
  The daily cron pass takes one snapshot a day ("daily update", `crew_schedule_confirms` with
  `published/auto_days/day`); "Changes since" compares against it, only among what was in view — a clean
  that just came into the 4-day window is not "new". The manual "Confirm" button still takes one.
- **One rule for what is ahead (crew page):** a clean after today reaches the cleaner — in Coming up,
  Cleans and the calendar alike — only if Coming up shows it (published schedule, else hand-assigned).
  The record holds the rule's picks for the board's window; unpublished, `loadCrewPage` drops them.
- Crew page **calendar**: a month grid (past from the record: ✓ paid, ⚑ flagged, ○ not paid; ahead:
  only what "Coming up" shows, today counted as ahead), tap a day for detail; "Add my coming cleans to
  my phone calendar" downloads an .ics snapshot (not a live feed — a subscribed feed would need a public
  URL past Access).
- **Deep is a person's call (§126):** every clean is regular unless someone sets "Deep — confirmed" on the
  row (an override); a stay of `deepCleanNights`+ only shows "○ deep suggested" (`row.deepSuggested`).
- **Rebooked ≠ cancelled (§126):** a cancelled booking whose guest has a live booking in the same unit
  with overlapping nights (same channel guest id `guestKey` from `-guest-<id>-`, else phone, else one
  name starting with the other) is a change: no clean to confirm; a held row is released
  (`releaseRebooked`, void "booking changed — booked again as …"). A different guest overlapping is
  still held (the unit may need a clean between them).
- **Corrections (§123):** Operations → Cleaners → a cleaner → "✎ Correct" on a PAST clean: deep/normal and
  price (blank = the card's rate at the unit's size; no rate → must type one), note required and shown
  to the cleaner (`edited_by/at`, `edit_note`). Today and ahead are changed on the board.

- **Inventory (§134, §150): by PLACE, never by unit.** A place = a Repository record (`table/ROW-id`): a Storage
  row (S13, S1105…) or a house's own record (its closet). Which place a unit draws from = the Repository's
  `storage` column, the ONLY source (a house names itself; blank = ▲ no place), read every time by
  `supplyPlaces` (functions/_lib/unit-access.ts) / `supplyPlace`, `inventoryPlaces` (src/lib/unit-access.ts) —
  looked up in every Units table. Setup → Inventory shows the map with ▲ and a link to each record (`/?repo=`).
  **The stock is never stored**: last `count` + `purchase` − `used`/`taken` ± `adjust` per item and place, floored
  at 0. Every move keeps the place it happened in (`inventory_moves.place`) — a unit moved later leaves its past;
  `taken` also names the unit and the clean; a unit with no place records with place NULL (▲, never blocks).
  `missing` changes nothing: ⚠ and a "Check stock" to-do; a count clears it. Only the team counts or corrects.
  **Per clean = the average** of what cleaners reported over every clean that answered step 2 in 60 days
  ("nothing" included), per unit wherever it took from; the item's estimate until 3. **To order per place** =
  Σ its units now (per clean × cleans in 14 d) + its minimum (`inventory_place_mins`, else the item's) − its
  stock, only once counted (never-counted is not guessed — 273 lines on the first test).
- **Counting is onsite (§150, owner):** 📱 Count opens a full-screen sheet like the inspection (`OnsiteCount`,
  reuses `Sheet` from InspectionRun): 🔍 + progress on top, a card per item with − [n] + / "= as recorded", only
  touched items saved; "+ Add an item here" (`newItem`, an old switched-off name comes back on) and "🙈 Not kept
  here" (073 `inventory_place_hidden`: off that place's list, needs and orders; ↺ back). The desk table's count
  mode is gone.
- **Drafts and low stock (§150, owner, 072):** "💾 Save draft" keeps the order being written (`inventory_order_drafts`,
  one per account; comes back as left, "Discard draft"; creating the order clears it). Setup → Inventory → **Low stock
  to-dos** (`accounts.inventory_low_stock_tasks`, OFF by default): after a count, a correction or a take, a counted
  place below an item's minimum gets ONE open "Low stock at <place>" to-do (`todos.low_stock_place`), a sub-task per
  item never twice while open, its order filled in (`lowStock`).
- **The places map is editable (§150, owner):** Setup → Inventory → drag a unit (or tap → Move to) between storages,
  🏠 Own closet (self storage) and ▲ Not assigned → `inventory-items` action `assign` writes the Repository's
  `storage` (the one source; audited by field name). Cross-table storages are allowed here (the Repository's
  own ref picker still offers only the same table).
- **Corrections (§150, owner):** "On record" has − [n] + per item (fixed box, typing works; staged; Save corrections
  needs why → `adjust` moves, API `adjusts`) — for what comes from outside or is lost; a count still replaces the record.
- **✎ Edit settings (§150, owner: everything in one edit):** per item name, counted in, estimate per clean (the item's)
  and Keep at least here (`saveSettings`, API `settings`; replaced "Minimums here"), + Add an item, 🙈 Not here, 🗑 Remove
  (switched off everywhere, asked first). **📝 Draft order for what's short** puts the place's toOrder > 0 or ❗ items
  into the draft order.
- **Order ≠ purchase (§150, owner).** The ORDER = a shopping to-do, a line per ITEM and where it goes ("Everything
  goes to" one place by default; ⑂ on a part splits half to another place, again for a sub-split; 🔍 adds any
  item — not on the list → "+ Add “…” as a new item", created on the spot), lines kept in `inventory_orders`. The PURCHASE = Inventory → 🧾 Record a
  purchase (from an open order, filled in, or from scratch; total + receipt) → a `purchase` move per line and
  place + ONE Restock expense (`purchase-<id>`) + a note on the order; the team closes the order. The only way
  stock goes up from buying. The inspector's 🛒 Purchase has the same 🔍 (supply + how many) → the inspection's
  to-do is an order filled in, to the unit's place. A checklist item that is bought can PRESET its supply
  (Setup → Inspection checklist → "Supply to buy", 071 `inspection_items.supply_id`): failed, the inspector is
  only asked "how many?" (no preset → optional 🔍); blank = buy what the note says.
- **Practice → 📦 Inventory** (`/#practice/inventory`, the SOP panel on Inventory): the real screen over an
  in-browser transport (`InvTransport`, `inventoryPractice` in Practice.tsx) — two storages and a house closet,
  counts, a "not found", a field request and a problem to attach an order to; nothing leaves the browser.
- **Order vs purchase, and the cleaner's request (§150, owner):** an ORDER is a purchase without a total — a request,
  editable, more lines can come; the PURCHASE executes it. Closing (✓ Done or Cancel) a cleaner's supplies request
  (`clean_group = 'request'`) with no purchase recorded for it opens a pop-up — it reads as dismissing the request:
  🛒 Record the purchase · Keep it open · or close it with a required reason, posted on the to-do. The to-do list
  carries `cleanGroup` and `purchases` for it. **The server enforces it** (`/api/todos`: closing a `request` or
  `inspection` to-do with no purchase → 409 `unbought` unless `closeReason`, which is kept as a note) — so Slack's
  ✓ Complete on one opens "Nothing bought" (`unboughtModal`: 🛒 Record the purchase in Kaizen, or a required why).
  Only these order to-dos; every other task closes as before. The four older "Request at …" to-dos from Irene (#55, #56, #62, #63) were
  tagged `request` on 2026-10-13.
- **Inspection orders and who paid (§150, owner, 074):** the inspector only requests — the inspection's purchase to-do
  is `clean_group = 'inspection'`, an order processed as a purchase (closing it unbought asks first, like a cleaner's
  request). Every purchase form asks **Paid by**: Kaizen (company card) or someone — a name (`inventory_purchases.paid_by`);
  then it is on Costs → One-off → **💵 To pay back** (by person, with receipts) until "✓ Paid back" (`paid_back_at/by`).
  NOT a cleaner's approved "I bought something" (owner: she charges it as an extra on her invoice — listing it would
  pay it twice); Paid by is for whoever does the inventory.
- **A to-do carries its purchase (§150, owner):** any open top-level to-do (Operations → To-do) has "+ 🛒 purchase"
  (`TaskPurchase`, Inventory.tsx): its order filled in if it has one, else 🔍 to the unit's place; "🧾 Record the
  purchase" (stock + Restock expense + receipt, `recordPurchase` with `todoId` — no order needed first) and "✓ and close
  this to-do"; or "💾 Save draft" — the to-do keeps that order (`saveTodoOrder`, API `todoOrder`: replaces, never
  appends; noted in its log), filled in the next time.
- **Cleaners speak, the team records (§150).** "I bought something" = their words + total + receipt → a pending
  field expense, no stock; approved ONLY via "✓ Approve — record in inventory" (items, places) in Operations →
  Cleaners → `recordPurchase`. A clean's reports are THREE kinds of to-do (070 `todos.clean_key/clean_group`):
  ⚠️ each problem its own · 🧴 "Supplies requested — clean of <unit> on <date>" (one per clean, a sub-task per
  request) · 🛒 "Bought on the clean of …" (one per clean). Any of them can carry a purchase order (To order →
  "For" the to-do: the lines become its sub-tasks, `inventory_orders` keyed by it).
- **"No hay" in step 2 (§150, owner):** "❗ Something not there?" (one line, sticky at the TOP of step 2 so it is seen;
  "↓ Slide down — there are more" floats until the list's end is in view) opens chips of the supplies; the
  ones NOT found go with the step-2 answer (`out`, `ranOut`): a `missing` move at the place — ⚠, NEVER zero (they
  may not have seen it; the record may be wrong) — and one high sub-task on the clean's supplies request. The team
  checks the stock and/or orders.
- **Per clean, not per team (§134, owner):** everything a cleaner does is on one clean (see "The cleaner's
  page" below), and the helper's link too. The helper link (`clean_links`, token encrypted to be
  shared again, `/report#t=…`) is for THAT clean: unit and key come from the link, never the page; it
  closes 2 days after the clean, when the clean is voided or given to another cleaner, or the cleaner is
  inactive. Several helpers can use one link; each gives a name once (localStorage), reports are
  `"<cleaner>'s team: <name>"`. A cleaner's clean is checked against their page once (`myClean`, reads
  the schedule) and then by `clean_records.cleaner`.
- **The cleaner's page (§134, owner's layout):** no big header — one line (hello · EN/ES · ❓ help · ☾) and
  right under it four sections, one at a time: **☀️ Today** (one big button per clean when there are
  several — a row that stays on top while scrolling, up to 3 in view and sliding sideways beyond, opening
  on the first clean not done; choosing one jumps to its top; the chosen one open with every option as a tab on top — 🧽 My clean · 🙋 Report or ask ·
  💵 Extra (the cleaner's alone) · 📤 Helper — and "✕ Can't do it" small at the TOP RIGHT of the clean while still in
  Coming up, its form opening full width below — the owner: by the tabs it was in the way of everyday taps; the same
  on Future rows, on the date line) · **↩️ Past** (last 3 days,
  a list; each opens AS IT WAS LEFT — its photos before/after, done or not, what was taken — with only
  "Add an extra" and Close: nothing more to report or photograph on a past clean, the owner) · **📅 Future** (only share the link or Can't do it;
  the calendar below) · **💲 Pay** (period, cleans, invoice; recent and coming rows carry the same small
  buttons). The team's view (Operations → Cleaners) keeps the one long page. Shells (`/crew`, preview,
  crew-only sign-in) drop the app header for it.
  Photos reach the cleaner through Kaizen (`GET /api/crew?photo=<id>`, same on crew-link and the team's
  preview): only a photo of a clean whose `clean_records.cleaner` is them; the team's Drive stays theirs.
  In "Changes since", a clean taken off a cleaner (reassigned or unassigned) reads just "cancelled" to
  them; the team's view still says what happened.
- **A clean's 4 steps (§134):** 1 photos BEFORE · 2 🧴 what I took from <its place> — "from S1105", "from the closet"
  (§150; with the place's code; "from storage" if the team has not set it) (**required**: lines, or
  the explicit "I took nothing …" — `clean_records.supplies_at/by/none`) · 3 photos AFTER ·
  4 ✅ done. Done is refused until 2 and 3 are there. "What I took" is no longer in the reports menu.
  The helper page (`/report`): the header IS the clean (unit, day small under it; EN/ES beside ☾), then two
  big tabs "🧽 My clean" / "🙋 Report or ask" so both show without scrolling. Reports in the owner's
  order: ⚠️ something is wrong (broken, damaged) · 🧴 request supplies (their words; "missing" and "need" were one
  thing to them, merged §150) · 🛒 bought (the same in the cleaner's "Report or ask"). A link is per clean,
  not per person: several helpers use the same one, each with their name. A phone keeps every clean it
  was sent while the link lasts (`localStorage.reportLinks`) and shows "Your cleans on this phone" to
  switch when there is more than one.
  The cleaner's **💵 Extra** tab (Today, Past, and Pay's small buttons; clean today or before, within the
  extra window) is the same `addExtra` as before, in the big form with the photo picker; the old
  "+ Add an extra" link stays only on cleans older than the last 3 days.
  One photo picker everywhere (`PhotoPicker.tsx`): "📷 Take a photo" (camera, one shot, "Take another")
  and "🖼️ Choose from the gallery" (several), thumbnails with ✕ — `multiple` alone hides the camera on
  many Android phones.
- **Photos and done (§134):** photos go one per request, shrunk on the phone (2000 px JPEG), to Drive
  `Kaizen — clean photos / <unit> / <date> <unit>` (made on first photo). **Done needs step 2 answered and ≥1 AFTER photo**;
  a second "done" is a no-op; reopen asks "Yes, reopen" in place. Every mark is kept (`clean_marks`);
  the latest is the state. The crew rows show "📷 n before · n after · ✅ done (who)" (team view too).
- **Field tasks have a priority (§134):** a problem or a need asks "How urgent?" (required: urgent =
  before the next guest / high = next days / low = when possible); "Check stock" is medium. Every to-do
  made from the field or Inventory is announced in Slack's tasks channel (`taskCreated`) and mirrored.
- **Cleans' daily thread in Slack (§134):** see the slack module (`functions/_lib/clean-slack.ts`).
- **Check-in deadline every clean sees (§142, owner):** a cleaner always has a check-in to finish before —
  **4:00 PM by default**, even when no next guest is booked (a last-minute booking can still come; cleaners
  ran late on a no-check-in house). When a same-day guest is confirmed it reads "check-in confirmed at
  4:00 PM"; when their real arrival is **earlier** than 4 PM (early check-in) that actual time shows instead.
  A **late check-out** needs nothing extra — the checkout time (when the cleaner can start) is already shown.
  `checkInFlag` / `DEFAULT_CHECKIN` in `src/screens/Crew.tsx` (CleanCard, UpcomingRow, the ICS export);
  labels `checkInConfirmed` / `checkInBy` in `crew-i18n.ts`. Shown on checkout cleans, not manual ones.

- **Practice (§139):** `src/screens/Practice.tsx`, two doors to the same page: the in-app hash
  `/#practice/<which>` for the team, and two public paths for cleaners / helpers to open without
  a sign-in — `/crew/mock` (cleaner) and `/crew/mock-helper` (helper) — reusing the Access bypass
  that already fronts `/crew` (§140; `PUBLIC_PRACTICE` / `practiceUrl` in Practice.tsx, which the SOP panel links use); `which ∈ inspection | work-link | vendor | cleaner | helper`.
  Linked from the SOP panel ("🧪 Practice · Practicar", `PRACTICE_FOR` by screen:
  Inspections → inspection + both handyman doors; Cleaners / Calendar → cleaner + helper). The real screens with example
  data ("🧪 Practice House / Loft") and in-browser transports: InspectionRun's `transport`, `CrewHome practice`,
  `ReportPage practice`, `WorkLinkPage` / `VendorHome practice`. Nothing reaches the server; a reload starts over; the
  helper practice never touches the phone's saved name or language. A change to one of those
  screens' actions needs its mock in Practice.tsx too (or the practice drifts from the real page).

## Open items

- **Access for cleaners (§136):** all 21 active units complete (2026-10-12, after the owner filled Bobcat
  House and the lockboxes of P2-4212 / P2-4315). A new unit shows in Setup → Crew pages → "How cleaners
  get in" with what it lacks.
- **Later (owner): a code of their own for each cleaner** instead of one shared Cleaner Code per unit —
  for security (revoke one person without changing everyone's code). Needs per-cleaner codes on the smart
  locks (Schlage / Yale) and a place to keep them encrypted; the access box would then show the cleaner's own.
- The helper link shows the codes while it is valid (until 2 days after the clean): anyone the link is
  forwarded to sees them. The per-cleaner codes above are the fix.

- **Inspector's link built (§135), test inspection P2-1304 on 2026-10-12.** Checklist items are English only
  (the page says so in ES) — a Spanish label per item in Setup is not built. Not built: a Slack notice when an
  inspection is sent; choosing the inspector's language on the team side (it follows the roster, else EN).
  Cancelling a scheduled inspection that has answers fails (FK from `inspection_checks`) — pre-existing.
- **Inventory by place (§150) live 2026-10-13** (068–069 applied; Repository filled; the 6 test moves placed —
  nothing is counted yet, so every place reads "never counted" and nothing is ordered). To start: count
  S1105, S13 and the house closets (Operations → Inventory → ▣ Count), set minimums per place, adjust the starter
  list (13 items, estimates are guesses). Hostaway task 16400930 ("Buy supplies: 2 items") and its Slack notice
  were a branch test — delete them (owner's OK). Not built: transfers between places; closing an order
  automatically; per-item supplier/price; a Spanish label per supply. Access **Bypass** app "Kaizen — public links" (Bypass Everyone) is live since
  2026-10-12 for `/report`, `/api/report-link`, `/crew`, `/api/crew-link`, `/assets/*` — verified: those
  answer without sign-in (APIs 403 without a token), `/` and every other `/api/*` still redirect. SOP drafts: "Keep the supplies counted and
  ordered", and the cleaners' "Your clean step by step: photos, done, supplies" / "Tu limpieza paso a
  paso: fotos, completada, insumos" (publish them to show on the crew page). Not built: photos and done
  on the Operations board; done does not feed the record or pay. Not built: a Slack notice for ⚠.

- **Stars built, tiers still deciding (§121).** `accounts.assign_rule = 'tiers'`; the board shows
  "needs ★N · has ★M ✓/▲" and "by stars: X" beside each clean. Next: the owner sets each
  cleaner's stars and zones by hand (seeded from tiers: Veronica and Michelle ★2, Irene ★3,
  K&M ★5 — 12 of 27 cleans read "below" on 2026-10-11, mostly Veronica's hand-set P2 cleans),
  watches a week, then Setup → Preview → **Save and switch to stars**. After the switch: drop
  the tier rule (`assign`, `primaryFor`, `cleaners.tier/position`, tier rules) once nothing reads it.
- **Levels built, not switched on (§125).** `assign_rule` is still `stars` in production. To switch:
  Setup → "Who cleans: by levels" → set max/day (owner: K&M 3, Irene 3, Veronica 2) → Preview →
  "Save and switch to levels". Fill **Irene's deep rates** first (blank → her deep cleans price at the
  ordinary rate and look cheapest). After the switch: delete the stars rule (requiredStars,
  pickByStars, assignByStars, StarDecision, `row.stars`, star bands in DEFAULT_RULES, `cleaners.stars`).
- **Crew page built, not switched on (§122).** To start: set each cleaner's email (Setup → Crew
  pages); in Cloudflare Zero Trust add those emails to the Kaizen Access policy with One-time PIN
  on. Calendar stays off until the star schedule is checked; then turn it on and Confirm in
  Operations → Cleaners. Fallback links work: the Access Bypass app for `/crew`, `/assets/*`,
  `/api/crew-link` exists since 2026-10-12. Not built: notifying the team on a decline (Slack), approved
  extras in Costs (they are only on the invoice), payment status ("paid") on invoices.
- Stars limitations: manual cleans (`MAN-`) don't count toward a cleaner's daily max; zones are
  derived from unit names (building prefix, else Houses) — a house can't be its own zone yet.
- Cleanings Log header row is blank in the daily file (read by column order) — **ask before
  touching that sheet**.
- Not built: Sheets mirror with the crew's Spanish tabs; crew cleaning sessions.
- Cleaner Slack channels: prepared, sent by hand only (see slack module).

## History

§18a, §53, §56–§64, §68, §70, §79, §80, §121, §122, §123, §124, §133, §134, §135, §136, §137, §138, §139, §140, §141, §142, §147, §150.
