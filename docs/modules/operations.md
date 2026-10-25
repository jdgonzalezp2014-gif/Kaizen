# Module: operations

Kaizen runs the day's operations (the daily file sheet is an archive). Tab **Operations**:
Movements (the board, §124) · To-do (→ work module) · Cleaners (view key `crew`; inside it 👥 Pages & approvals and 📅 Calendar, view key `calendar`) · Inspections ·
Inventory (§134) · Notes log · Rates & rules · Setup. Plus the **crew page** each cleaner sees (§122).

## Files

- Screen: `src/screens/Operations.tsx` (Board, Setup incl. StarSetup/CrewSetup, Inspections, CleaningsMonth…),
  `src/screens/Crew.tsx` (CrewHome = the cleaner's page, CrewAdmin = Operations → Cleaners; one CrewView for both),
  `src/components/CleanControls.tsx` (FlagControl, ManualCleanForm, MANUAL_WORD, LEVEL_LABEL — shared by Movements and Cleaners),
  `src/components/CleaningCalendar.tsx`, `DayPicker.tsx`.
- API: `crew.ts` (cleaner, behind Access), `crew-link.ts` (secret link, SELF_AUTHENTICATING, reads
  no identity header), `crew-admin.ts` (team: GET `operations`, POST `operations.edit`),
  `operations.ts`, `turnover.ts`, `inspections.ts`, `manual-clean.ts`, `ops-settings.ts`,
  `stays.ts`, `cleaning-log.ts`, `cron.ts` (Host Note pass, reconcile).
- Stay times to Hostaway (§154): server `functions/_lib/stay-times.ts` (`pushStayTimes`), Hostaway
  `updateReservationTimes` / `fetchStandardHours` (functions/_lib/hostaway.ts); pure `src/lib/stay-time.ts`
  (hourOf, timeOfHour, stayTime, isAgreedTime, nightToBlock, timeReminder, syncLogLine, syncState); `blockNight` /
  `setNightOpen` (hostaway.ts).
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
- Purchase form + ✨ Read receipt (2026-10-14): ONE `PurchaseForm` (Inventory.tsx) under `RecordPurchase` (Inventory card),
  `TaskPurchase` (to-do) and `FieldPurchaseLines` (cleaner's purchase); `sendPurchase` posts it. Server
  `functions/_lib/receipt-read.ts` (`receiptFiles`, `readReceiptFiles`), `askJson(…, files)` in `ai-chain.ts` (Gemini
  `inlineData`); `recordPurchase` = `checkPurchase` + `writePurchase`, `recordPurchases` (splits); pure `src/lib/receipt.ts`
  (readReceipt, similarItems, orderFor, receiptSum, splitTotal, sizeKey, aliasKey, wrongSize).
- **Walmart/Amazon receipts = MarkDownload .md ONLY (owner, 2026-10-15, replaces the PDF/screenshot/Ctrl+V reading of 90340e2 —
  `receipt-prep.ts` and pdfjs-dist deleted):** the team saves the order page with the MarkDownload extension. Walmart: select from
  "<date> order" down to Total → "download selection" (the whole page loses the items — Readability drops them; the server says so).
  Amazon: Order details page. Pure `src/lib/store-order.ts`: `parseOrderMd` (blocks from each product's first link line; Walmart
  "Qty 4" + LINE price, "$0.94 ea"; Amazon the lone number = qty, price = ONE's → amount = qty × price; totals, `orderNo`, date;
  pack "Count Per Pack: 40" / "42 Count" / "4 Rolls", never "Sheets per Roll"), `readOrder` → `Receipt` (sure ONLY by the store
  number on exactly one supply's buy option, or a learned alias; else `match` 'guess' (candidates) or 'none'; leftover
  fees/savings = one line so lines + tax = total), `packFor`, `withProduct`, `cartLinks`, `againstOrder`. Server
  `readOrderMds` (no AI; `receipt_reads` by='Markdown', same hash/orderNo repeat warning) and `learnProducts` (purchase's
  `products` [{itemId,url,pack}] → that option FIRST in `buy_options`, pack = line's qty in the item's measure ÷ store qty).
  **No migration:** the store product is a `buy_options` entry (075) whose url is walmart.com/ip/…/<id> or amazon.com/dp/<ASIN>,
  plus `pack` (Setup → Items list → Buy at "×"). `fieldPhotos` accepts `text/markdown` (the .md is the Restock receipt in Drive).
  A cleaner's receipt photos (FieldPurchaseLines, `fieldExpenseId`) still go to the AI (`readReceiptFiles`, files only now).
- **Against the order (owner, 2026-10-15):** after a read, `PurchaseForm` shows "Against the order" — `Flag`s (Peek: hover/tap
  lists the items): ✓ as ordered · ▲ missing · ≠ fewer / more · + not in the order · ≈ not exact · ✕ no match; each receipt row
  gets a `RowFlag` (✓ exact / ✓ learned / ≈ / ✕ / +). Ordered items on no receipt are taken OFF the lines on the first read (not
  bought); a line chosen later goes back to the order's place.
- **Store carts (owner, 2026-10-15; checked that day):** `CartLinks` in To order (OrderPlan) and in the purchase form before a
  read. Walmart `https://affil.walmart.com/cart/addToCart?items=<itemId>|<qty>,…` — **works** (owner: it filled the cart).
  Amazon `gp/aws/cart/add.html?ASIN.1=…&Quantity.1=…` **does NOT** (opened the cart as it was) → each Amazon item is a link to
  its page "Amazon: <item> ×n". qty = ⌈ordered ÷ pack⌉; items with neither are named ("No store link"). Kaizen never pays.
- **Plan A / plan B (owner, 2026-10-17; was ONE store product since 2026-10-15):** the FIRST Walmart/Amazon option is plan A
  (cart, Buy at, store per line use it), a SECOND is plan B (Items list tags it "plan B"); save refuses a third. `withProduct`:
  the bought product becomes plan A, the replaced plan A stays plan B. `setStoreLink` (broken link) replaces plan A, keeps plan B.
  2026-10-17 Walmart cart loaded: Wine glasses, Cooking utensils (36-pc set), new Mixing bowls + Dish rack (2-pack); plan A
  replaced (old → B): Blackout curtains (Sun Zero), Plates/Bowls (Walmart 2×12-pc, p16/p8), Knife set (Farberware 23-pc),
  Bath towels (Mainstays), Paper towel holder (Amazon OBODING); plan B added from Walmart "usuals": Toilet paper, Paper towels,
  Dish soap, Hand soap. Personal care (shampoo/conditioner/body wash…) skipped on purpose.
- **Orders from Slack (owner, 2026-10-15):** `@Kaizen order 2 paper towels y 1 Tide para LP-4212` → a draft in the thread (lines
  rules first, the AI only for the rest (`readOrderLines`, short rows; one line of words → `readRequestText`, furniture now kept), one place picked
  first — a house's supplies go to its closet/storage (`lineTarget`), Walmart cart / Amazon links; a pasted
  list, or `@Kaizen order` alone in its thread; the missing ones added all at once),
  saved on Confirm onto the thread's to-do's order (add/replace asked per clash) or a new "Buy supplies: …" to-do — `saveTodoOrder`,
  `newItems` (bulk, new), `learnAliases` (now one statement). Details in docs/modules/slack.md.
- **No place yet, Final cart, store per line (owner, 2026-10-15):** an order for a listing not in the Repository yet
  (a new unit) keeps lines with `place: ''` — "▲ No place yet (new listing)" in `PlaceSelect` (`none`, only on a to-do's
  order: `PurchaseForm noPlace`); `saveTodoOrder` keeps them (it used to DROP them silently — a to-do with no listing lost
  Build the cart's lines on Save order); recording still needs every place (`unplaced`, `checkPurchase` names the item).
  `FinalCart` (TaskPurchase, under the lines): per item place · store (`StorePick`: linked store by default, Walmart /
  Amazon / Another store… → order line `at`, ≤60 chars, no migration; another store leaves `CartLinks`) · ⓘ product/pack/link ·
  "! Already ordered" (another open order has it) · "! On hand" (`onHand`, only the to-do's listing's places — house, closet, the storage it draws from — unless "On hand at other listings' places too"; owner: never take one listing's stock to open another); "▲ Asked, not on the cart" = ✨ read lines on
  no line. After a read, `plannedAt` checks the store: "⇄ other store" (receipt store ≠ planned), "◇ bought elsewhere"
  (planned at a store no receipt is from — kept out of ▲ missing). `mergeOrder` keeps `at`. A to-do with no listing starts at "No place yet"
  (not the busiest storage). Slack's draft has the same "No place yet" (`NO_PLACE` = '-'). SOP #15 v22, SOP #8 v23.
  **Every order has an outcome (owner, 2026-10-15, review of the whole flow):** recording on a to-do's order computes
  `leftOver(ordered, bought for THIS order)` (splits/forTodo respected) and, as chosen in the form, puts it on a new
  to-do for later (`laterOrder` — same listing, place/none and `at` kept, noted on both; default, then closes), keeps it
  as this order (stays open) or drops it (closes). Before buying, lines taken off / reduced show as "Taken off the cart" →
  "Save them as a new order for later" (laterOrder + todoOrder); Save order alone warns once. Broken link: "link broken?"
  / "+ link" per Final cart row → `setStoreLink` (`storeLink` action: a Walmart/Amazon page replaces the store product,
  pack kept unless given; '' removes it). The Final cart hides after a receipt is read. **Closing any to-do with an order
  with lines and no purchase now needs a reason** (`/api/todos` 409 `unbought`, Todos.tsx `t.order`) — before, only
  cleaner/inspection requests did. **Final cart, a way out per item (owner: "act as a logistics professional"):**
  `CartEdit` (PurchaseForm's `buttons` gets `edit`: put/add lines without starting the form over — Build the cart uses it
  via `editRef`, so typed lines survive); `Aside` = set aside on purpose (on hand / another order), excluded from
  "taken off" and from what was not bought, ↺ put back, said on the to-do (`orderNote` action). On hand never discounts by
  itself: "don't buy it", or "correct the record" (a `count` at that place, note "Checked while ordering"). Store: `StorePick`
  + `linkOf` (store product, or a non-store option under the store's name) — `setStoreLink` now keeps other stores' pages
  by `label`; `storeAt` falls back to that label. Asked-not-on-cart rows replace the old "Not sure" block. Peek's pop-up keeps
  focus on a tap (mousedown prevented) so its buttons work on a phone. Splits show per part. **One cart (owner: two carts were confusing):** `cartTools(useCartUi(), …)` returns `{ top, row, bottom }`; PurchaseForm's `tools` draws `row` IN ItemLines (`row` prop: `sub` under the name = asked as / ! Already ordered / ! On hand, `cell` = Buy at column, `below` = the link or count field in a `cart-under` row), `top`/`bottom` around it; no separate Final cart table. `.slide-over:has(.task-buy)` widens the panel to min(92vw, 1240px); `.cart-lines` are cards ≤720px. SOP #15 v24.
  **One cart everywhere (owner: "an order is a purchase without a price and without a receipt"):** Inventory's `CartCard`
  replaces OrderPlan + RecordPurchase (OrderPlan stays only as the read-only view for roles without edit): "Working on" =
  a new cart (suggestion/draft → PurchaseForm with `hints`, cart tools, Send as order / Save draft / Record) or an open
  order (→ the same `TaskPurchase`; `openOrders` now returns `unitIds` + `asked`). TaskPurchase and `cartTools` use the
  screen's `InvApi` (Practice works; Practice handles todoOrder/laterOrder/orderNote). `createOrder`/`saveDraft` keep
  no-place lines and `at` (`orderLinesIn`/`nameOrderLines`). Recording: total required, no receipt → "Record it without a
  receipt?" modal; 💼 **Owner's expense** → `inventory_purchases.owner_charge` (096), Restock label/notes and the to-do say
  so — NOT sent to Hostaway (repairs do; ask the owner before doing it for purchases). Inspections need nothing: their
  purchases become one to-do whose order opens in this cart. "On hand" also looks where each line goes (an Inventory cart
  has no listing). SOP #15 v25. Open: report a broken link from Slack's draft (only in Kaizen); abandoned
  **2026-10-16 (owner):** an open order's stage pill reads **Purchase** (was "Ordered" — it read as already bought; Slack the same, `STAGE_WORD`);
  "▲ Asked, not on the cart" → "+ New item…" opens a pop-up (name, size, counted in, type, how many — prefilled from what ✨ read,
  never created as read; link later on the cart). `slack_order_drafts` rows are never cleaned. Not yet seen on screen (owner's tokens) — check it in use.
- **Sets (owner, 2026-10-15):** one store product on several supplies = a set (Swirl flatware on Forks ×16 / Knives ×8 / Spoons ×24,
  Quatish on Plates ×8 / Bowls ×4; only when someone puts the same link on several items). `readOrder` splits its line into one
  line per supply (`match` 'product', its pieces, the price shared evenly, leftover cents on the first) and `cartLinks` buys it
  as often as the neediest supply asks (max, not sum). Deterministic, by product number — the AI photo path is unchanged.
  SOP #15 v19 says so; Items list → Buy at "?" too.
- **Every read is checked (owner, 2026-10-15):** `orderWarnings` — no order number/date (a Walmart selection started below the
  title), products ≠ subtotal (left out), items ≠ "Subtotal (N items)" → ▲ in the read message; also in SOP #15 v17.
  Tested on real data (read-only): Walmart 2000156-31789057 6 lines, 19 items, 38.67 + 3.19 = 41.86; Amazon 113-2518508-6894635;
  against production supplies every line was ≈ with the right supply first (no store products saved yet).
- **Store purchases and online returns (2026-10-15, real .md of Sep 11/12 and Oct 5):** a Walmart store purchase prints each
  scan as its own block (15 towels = 15 pictures) → a new picture of the same product is another block, added up (same pack);
  its TC# stands for the order number and "Sep 12, 2026 purchase" dates it. An online order lists what was returned
  ("Return to Walmart store") and never came ("N unavailable items") after what was bought → cut to "How can we help?".
  Prices skip the list price ("$14.97/ea"), "$2.00 from savings" and "Was $…"; "Multipack Quantity: 6" × the name's count = pack;
  Walmart's one-product price = line ÷ qty (its "$1.00 ea" on a 6-pack is one mug's).
- **Store products loaded (owner, 2026-10-15):** 31 of 45 supplies got their ONE store product (one-off script, deleted) — the
  one bought **most in the last two months across Amazon and Walmart** (orders, then units in the supply's measure, then the most
  recent, then price per unit): Amazon Business CSV (an order × ASIN once — the file repeats a line per payment), the Walmart .md
  receipts and an Amazon cart .md. Personal-use buys left out. Packs not printed were left empty (Swirl 49-piece flatware on
  Forks/Spoons/Knives, Quatish 16-piece set on Plates/Bowls). An Amazon cart saved with MarkDownload kept 2 of ~12 products
  (the rest lost their links).


## Tables

`cleanings` (record: `void_reason`, `decided_by` rule / rule:stars / override:…, `source` kaizen/sheet/manual/history,
`MAN-<n>` manual rows), `turnover_overrides` (NULL = the rule decides), `cleaners` (roster,
rate cards, `stars` 1–5, `zones` [] = all, `max_per_day` NULL = no limit, `email`, `invoice_period`,
`link_token_hash`), `accounts.assign_rule`, `accounts.crew_calendar(_days)`, `crew_extras_folder`,
`cleanings.flag_note/flagged_by/at`, `cleaning_extras` (+ `cleaning_extra_files`), `crew_declines`,
`crew_schedule_confirms` (snapshot jsonb), `crew_accepts` (097), `accounts.ops_rules` / `ops_mode`, `stay_notes`, `inspections`,
`extra_inspectors`, `host_note_pushes`, `stay_time_pushes` (078, 080), `inventory_items`, `inventory_moves` (057; kind `taken` 061; `place` 068, `purchase_id` 069),
`inventory_place_mins` (068), `inventory_orders`, `inventory_purchases` (069), `inventory_items.size` + `inventory_receipt_aliases` (085), `todos.clean_key` (069) + `clean_group` (070), `inspection_checks.supply_id/qty` (069),
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
- **Early check-in / late check-out reach the guest (§154, §156, owner, 2026-10-13).** Whole hours only (Hostaway's
  `checkInTime` / `checkOutTime` are integers 0–23; the server refuses minutes).
  **The board READS the reservation's hours** (`checkInHour` / `checkOutHour` from the reservations list, no extra calls):
  time = Kaizen's copy if it holds one, else the reservation's hour, else 10:00 AM / 4:00 PM (`stayTime`, `row.timeFrom`).
  "Agreed" (highlighted, `manual.time`) = off the listing's standard (`checkInTimeStart` / `checkOutTime`, `row.standardHour`).
  **Kaizen holds a time only until Hostaway confirms it**: on a confirmed write its `turnover_overrides` column is cleared, so a
  change made later in Hostaway itself is what the board shows; a failed one stays (⚠, "Send again" = `resendTime`).
  **Every change asks first** (`TimeCheck` pop-up in the editor): the clean's cleaner (checkout) or the same-day clean's
  (check-in), whether a guest arrives that day, the last-minute-booking warning; "Checked with" (required) → save.
  After saving (`waitUntil`, live mode): PUT of just that hour, read back; cleared → the listing's standard; a **later check-out
  with nobody arriving that day closes that night** in Hostaway (checkbox, on by default; `blockNight` refuses a night that is
  not open; `setNightOpen` reopens — tested on Amber 2027-03-09, restored exactly); a **reminder in the cleaner's OWN Slack
  channel** only (owner), in their language (`timeReminder`) — no channel → "not sent — X has no channel" in the log.
  Every attempt = a `stay_time_pushes` row (078; 080: checked_with, block_night/ok/detail, reminder) = a Notes log line.
  Not built: reopening the night when a late check-out is taken back (do it in Hostaway); a reminder to the team channel.
  SOP #32 "Early check-in or late check-out" (draft, operations.board).
- "Not needed" / "TBD" are states, not cleaners; match on words, not emoji (§57).
- Bulk writes with `unnest`, never one INSERT per row (§62).
- Ops role sees the board without booking values (`money` permission) (§63, §65).
- Board chips (2026-10-15, owner): an arrival's "ID in Drive" / "signed" chips take a dropped file (or click) and file it
  in Drive (`DocChip`, same `uploadGuestDoc` as the row's Guest documents) — dashed while missing, solid green once filed.
  The row's "Guest documents" panel is gone; opening an arrival still files Hostaway's signed agreement (`syncAgreement`).
  "Set by hand" and "by levels: …" are a hover on a ✎ / ⇄ beside the 👁, not text; the deep-clean pay note is a "?".

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
- **Cleaners, the team's edits (owner, 2026-10-24):** a cleaner's page in Operations → Cleaners has the invoice periods as
  presets plus "Last 7/30 days" and two dates (`?period=<from>&to=<to>`, team only; ≤92 days, ≤30 ahead; `customPeriod`,
  `Period.custom` — pay never moves, each clean is paid with its invoice period). Per clean: the Movements `FlagControl`
  (deduct $ or corrected pay), ✎ Correct, **○ Not paid…** (`notPaid`: before today only — the record rewrites today+;
  `void_reason = 'not paid by the team — <why>'`, leaves the invoice and Costs; `restorePaid` undoes only that prefix),
  and **+ Add a clean** (ManualCleanForm with the cleaner preset). Extras on a void clean leave Costs too (field-costs.ts).
  SOP 10 v4 done.
- **A cleaner's purchase pays her back (owner, 2026-10-24, 098):** approving it ("Approve — record in inventory") also writes an
  approved `cleaning_extras` row with `field_expense_id` on the clean it was bought for (that clean's cleaner — a helper's is their
  cleaner's) → on the invoice; never a second Costs row (the purchase is already Restock; `syncCleaningCosts` skips them). No clean
  with a cleaner → the purchase gets `paidBy` = Costs' "To pay back". A duplicate extra the cleaner also sent is denied by hand.
  098 backfilled the one approved before (Irene, $35.58, CL2450 Oct 18).
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
- **Confirm a clean (owner, 2026-10-17, 097):** "✓ I'll do it" / "La hago" left of "Can't do it" (UpcomingRow + today's
  CleanCard, `ConfirmButton` in Crew.tsx) → crew action `accept` (same "on your schedule" check as decline) → `crew_accepts`
  (key, cleaner, clean_on). Shown back as "✓ Confirmed"; it locks nothing — a decline deletes it. Counts only for the same
  cleaner AND day (moved/reassigned = asked again). Board: `loadOps` sets `row.confirmed` → ✓ (done icon) beside 👁, hover
  "X confirmed it — Oct 17, 3:12 PM". Not on manual-clean rows of the board yet (MAN- can be confirmed; the page shows it).
- **Picking a cleaner in Operations → Cleaners leaves the URL alone (owner, 2026-10-17)** — no `#crew/<name>` rewrite; an incoming
  `#crew/<name>` still opens that cleaner. "View as cleaner ↗" = new tab (`#as-cleaner/<name>`). The secret crew link is unchanged.
- **Invoice per cleaner on their page (owner, 2026-10-17):** Operations → Cleaners → pick a cleaner → "Invoice" select above the
  page → crew-admin `invoicePeriod` (same `cleaners.invoice_period` Setup edits). An open Setup tab with an older roster
  would write its value back on "Save addresses and invoices". SOPs #10 v3, #11 v2, #12 v3, #13 v3 (`.sop-097.mjs`, run after deploy).

- **Only confirmed stays (2026-10-16).** `reservationCounts` (`src/lib/finance.ts`, re-exported by hostaway.ts) is an
  ALLOW-list: `new`, `modified`, `ownerStay`. Everything else — inquiry*, `unconfirmed` (Vrbo request to book), `pending`,
  awaitingPayment, expired, declined, cancelled, any status Hostaway adds later — schedules no clean and counts no revenue.
  Statuses seen in all 2,164 reservations (2026-10-16): those three + cancelled, inquiry, inquiryPreapproved,
  inquiryNotPossible, expired, declined, unconfirmed. Trigger: a Vrbo request (DeLynn Smith, Timber Crest 16→17 Oct) was
  given a clean; the next pass voids it with the generic "booking cancelled in Hostaway" wording; accepted, it turns `new`
  and the clean comes back. Cancelled after arrival stays as §123.
- **A clean that leaves the window is asked about, not voided (2026-10-16, owner: "no se nos pierda una cancelada después
  del check-in").** The board only sees today on, so a recorded clean missing from it used to be voided as "cancelled before
  arrival" — also stays SHORTENED into the past and stays CANCELLED after arrival whose checkout had passed. `settleGone`
  (ops.ts) asks Hostaway (`fetchReservationDetail`, via `OpsState.lookup`): confirmed → the clean moves to its checkout;
  cancelled → §123 on its own dates (held or voided); a request never confirmed → void "booking request not confirmed in
  Hostaway (<status>)", decided_by "never confirmed"; no answer → voided as before.
  **`reconcileRecent` had never run** (`/api/cron`, behind Access, nothing calls it): it now runs with `recordCleanings`
  on the hourly Host Notes tick in `/api/slack-cron`. Its first run (dry-run 2026-10-16) holds 4 cancelled-after-arrival
  cleans that had been voided (66756414, 66091503, 65840732, 67232727 — Cynthia DallOglio) and restores 2 shortened stays
  voided as cancelled (66383376 P2-4308, 63723324 CL 1446). Those two were restored by hand (owner): back to who had them,
  Karina and Marvin $120 deep on 22 Sep, Michelle $35 on 26 Sep. A restore now gives the clean back to the cleaner the void
  noted in decided_by ("— it was X's"), unpriced.
  Not fixed: 10 cancelled-after-arrival stays from before §123 (Aug–3 Oct, e.g. Christine/Kobie Dunbar) never had a row.

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
  Maintenance needed). Repairs/purchases are mirrored to Hostaway (pushWork after the response), then
  announced in Slack's tasks channel like app work (`notifyTask` created, the work order and the order only — 2026-10-14, owner). Inspections view: Inspect now / Schedule, month calendar (○ ◐ ✓ ▲), ▶ Start/Continue,
  View report; the old log form is folded ("past inspection without the checklist").
  **Inspect now reuses an overdue plan** (2026-10-14): a unit with an open plan dated ≤ today (e.g. the monthly
  auto-schedule) runs that plan, moved to today, instead of a new row that left the plan open (4308: #25 vs #16).
  **📅 Move** (2026-10-14): `/api/inspections` action `reschedule` {id, date, inspector?} — plans only, refused if the
  unit already has one that day; a sent link's `link_expires_on` follows (day after). Form `MoveInspection` in Operations.tsx.
  SOP #14 v3 says so (plus free-text purchases, photos optional). Plan #16 (empty) deleted.
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
  (▶ Start/Continue/Review · 🔗 Link · 📅 Move · cancel) — they were in the last column, scrolled out of sight.
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
- **What is in view is held (owner, 2026-10-17)** — `applyHold` (src/lib/operations.ts): a rule's pick
  recorded for a checkout within `crew_auto_days` (same day, cleaner active, not declined) stays theirs and
  counts toward their max that day; the star/levels rule shares only what is left. Recorded as
  `rule:kept — already in the cleaner's view`. Trigger: Karina saw Timber Crest on Sun 18 Oct; P2-4212 landed
  that day, the rule re-ran, she got P2-4212 and Timber Crest went to Veronica (who declined it). Before, only
  overrides and carried cleans took a slot — every re-run re-shared the 4 days.
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

- **Storage and Houses (§165, owner 2026-10-15):** Inventory has two views — Storage · supplies (storages + houses'
  closets) and Houses · furniture (every active unit with a Repository record). **A house's place = `<record>#house`**
  (`houseKey`); its closet = the record key. **Supplies live only in a storage or a closet** (outside one they are used
  up): the server refuses a supply into a house (`fitsPlace`, every write); a supply's picker has no houses. Furniture
  can be in the house and in a storage/closet ("Furniture here" section) and **⇄ moves** between them (`transfer`, two
  `adjust` moves). "Goes to" a unit = furniture to the house, supplies to its supplies place (`destFor`); place checks
  `findPlace`, text `placeWord`. A receipt's new line is corrected before it is added (how many, counted in, type);
  matched quantities editable; "✎ new item" (`editItem`, only while the item has no moves). Migration 089.
- **Closets and refills (owner, 2026-10-15, 090):** Repository **Has closet** (`has_closet`, checkbox after Closet code in the 3
  Units tables; filled: every house ✓, The Links/P2 ✓, Cortland ✗). With a closet the unit's place is ITS OWN closet (the record
  key, `self`) — cleaners see and take from it only (step 2 "from the closet") — and its `storage` names what REFILLS it
  (`SupplyPlace.from`; blank or its own name = nothing). `inventoryPlaces` gives the closet `from` and the storage `refills`.
  Overview: a refilled closet's supplies show **To refill** (`toRefill` = cleans ahead + min − held, counted only; `toOrder` 0, no
  "Draft order"); what it is short (never counted: its cleans ahead) is added to the storage's need → the STORAGE is ordered.
  **⇄ Refill from S1105** on the closet (`refill` → `refillCloset`, two `adjust` moves per item via `moveLines`, same limit as
  ⇄ move); a low-stock to-do on such a closet says refill, not buy. Setup → Places: a storage zone lists the closets it refills
  ("· closet"), "Own closet, nothing refills it", and a **Has closet** switch per unit (`inventory-items` `closet`, written to the
  Repository, audited). **Counted in** editable anywhere it shows (`MeasureEdit` on order and purchase lines → `measure` /
  `setMeasure`): the label only, quantities never converted. Practice has a closet (Practice Apt 2) refilled from S100. SOP #15 v16.
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
- **How the storage looks (owner, 2026-10-14, 084 `inventory_place_looks`):** the count sheet ends with 📷 up to 5
  photos (PhotoPicker, shrunk) + a note, both optional; saved with the count (multipart `count`, `counts` as JSON text,
  `look` = the note) to Drive "Kaizen — field reports" (`fieldPhotos`), one row per count that had any (`recordLook`).
  Photos/note alone save without counting ("Save photos & note"). The place card shows only the latest
  (`InvPlace.look`: "📷 How it looked <date> · who — note · photo 1…"); older ones are in the table/Drive, not shown.
  Practice keeps the count, drops the photos. SOP #15 v12.
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
- **Items list: Type and Buy at (§150, owner, 075):** Setup → Inventory → Items list — first column **Type**: 🧴 Supplies
  (`inventory_items.kind = 'supply'`, what cleans consume) or 🪑 Furniture (linens, dishes, equipment, hardware — counted,
  never handed out; the 29 items of 2026-10-13 are furniture); last column **Buy at** (`buy_options` [{label, url}], as many
  as there are). Cleaners' step 2 (crew page, helper link) lists supplies only, and only those their unit's place keeps
  (`UnitAccess.supplies.skip` = its "not kept here").
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

- **To evaluate (owner, 2026-10-15): the Amazon Business Cart API** for an "Add to Amazon cart (n)" like Walmart's — Kaizen has
  Amazon Business; `addItems` (ASIN + qty) fills a user's cart, the person checks and pays (Kaizen never pays). Needs the account's
  admin to register API access on the Amazon Business developer portal (approval time unknown) + a one-time OAuth, its token kept
  encrypted (like Hostaway's). The ASINs and packs already come from the .md receipts (`buy_options`). Ruled out: the public
  add.html link (opened the cart as it was), someone else's Associate tag (commission + their reports see what Kaizen buys;
  fragile), "Share your Amazon Business Cart" (only built by hand in Amazon), "Bulk order products" (quotes, not a list upload).
  Docs: https://docs.business.amazon.com/docs/cart-api-overview · /reference/additems
- **Store carts & .md receipts (2026-10-15):** Amazon has no working multi-item cart link (add.html opened the old cart; untried:
  `gp/aws/cart/add-res.html`). Several stores' links per item: later, when the owner asks. The UI flow (read → flags → record →
  product learned) was not run end to end — check it on the first real receipt.
- **Store products, open (2026-10-15):** 34 of 45 active supplies have one. Owner: Bath mats = the Walmart bath rug; Blankets /
  comforters split by size (Queen = id 22, Twin = new id 46, each its Utopia product). Packs from the web: Quatish set (model
  QT-TU-WHEAT-16P-BK) = 4 dinner + 4 salad plates, 4 bowls, 4 cups → Plates 8, Bowls 4; Swirl 49 = 8 dinner + 8 salad forks,
  8 knives, 8 dinner spoons + 16 teaspoons → Forks 16, Knives 8, Spoons 24 (read from the teal version's listing — check one box).
  Coffee pods switched off (owner: not used). Pillowcases on their own (owner: bought separately too — Walmart's 2-piece sets;
  no product link yet). No product, on purpose: Cooking utensils (later),
  Wine glasses, the safety/hardware items. Sheet sets and Mattress protectors still have no size (Queen products).
- **Sept 1 – Oct 13 store orders = Costs only (owner, 2026-10-15):** 53 one-time shared Restock expenses ($6,845.34: Amazon 28 =
  $3,357.70 from the Business CSV, Walmart 25 = $3,487.64 from order pages and purchase history), `source = 'store-order'`,
  `external_ref` `amazon-<order>` / `walmart-<order or TC>`, notes = the order's lines; no unit, **no stock** (where things are is
  unknown — counting starts with the next purchases, recorded as purchases). Personal-use orders left out. Not entered: Walmart
  Sep 9 pickup (Frisco Preston — the history page shows no total), 200015283257285 $185.88 (not delivered, returned to the store),
  2000156-31789057 $41.86 (ready for pickup Oct 15, not picked up). Walmart's purchase history page has no product links (pictures
  only) — good for totals, not for store products.
- **Catalog filled from the Sept–Oct orders (owner, 2026-10-15):** 53 items added (98 active) so every thing bought has an
  item: TV 55" / 43", TV wall mount, Bed frame Queen, Mattress topper, Nightstands, Floor / Table lamps, patio set, string
  lights, outdoor rug, coffee maker, kettle, toaster, knife set, hair dryer, shower curtain + liner, bathroom trash can, soap
  dispenser, plunger, broom, hangers, curtains, rods, mirrors, wall art, throw blanket, Duvet covers Queen/King, Sheet sets
  King, comforter King, lockbox, fridge lock, key tags/chains, chargers/cables, AA/AAA/CR2032, coffee filters, salt & pepper,
  all-purpose cleaner, bathroom bags, whitener, pest control — each with one store product when an order page gave a link
  (purchase-history-only ones have none). Coffe → Coffee; Sheet sets / Mattress protectors (21) = Queen; 45 = Mattress
  protectors King. Still not assigned to a unit and no stock (where each one went is unknown — the inventory session).
  Items list shows a pack as "pack of 200" (was "×200", read as buying 200). Then every bought thing got its product: links
  looked up on walmart.com for the purchase-history-only ones (TV 43", curtains, rods, mirrors, key chains, charger, cable,
  CR2032, trash can, paper towel holder, pillowcases, mouse repellent; throw blanket = the Amazon one), and each size bought is
  its own item with its own product (Sheet sets Twin/Queen/King, Duvet covers and Mattress protectors Twin/Full/Queen/King,
  Bed frame Full/Queen/King, comforters Twin/Queen/King, TV 43"/55") — 107 active. No link, never bought: Fire extinguisher, CO / Smoke detector, First aid kit, HVAC filter, Tub / Sink stopper, Cabinet knob, Ring.
- **One item per thing (owner, 2026-10-15):** `itemKey`/`sameItem` (src/lib/inventory.ts) — case, punctuation, "&"/"and" and
  plurals ignored; Setup's save refuses a second one of the same size, `newItem`/`newItems` (purchase form, Slack order) reuse it.
- **Later (owner, 2026-10-15):** an inventory session (where things are, counts); a screen to upload a purchase and pick where
  each thing went.
- **Access for cleaners (§136):** all 21 active units complete (2026-10-12, after the owner filled Bobcat
  House and the lockboxes of P2-4212 / P2-4315). A new unit shows in Setup → Crew pages → "How cleaners
  get in" with what it lacks.
- **Later (owner): a code of their own for each cleaner** instead of one shared Cleaner Code per unit —
  for security (revoke one person without changing everyone's code). Needs per-cleaner codes on the smart
  locks (Schlage / Yale) and a place to keep them encrypted; the access box would then show the cleaner's own.
- The helper link shows the codes while it is valid (until 2 days after the clean): anyone the link is
  forwarded to sees them. The per-cleaner codes above are the fix.

- **Shannon H.'s monthly checklist (2026-10-13, owner):** the Kaizen checklist gained what hers checks (area Laundry +
  18 items: extinguisher, alarm dates/batteries, first aid kit, cameras, keys/openers, HVAC filter, vents, water heater,
  washer, cabinets, stoppers, bath mats, towel bars/mirrors, outdoor furniture/gazebo, drainage, landscaping, Napa's
  projector) with supplies preset; 29 supplies added (linens, dishes, cutlery, safety items, filters, stoppers, handles —
  no minimums). **Napa Valley 10/08 entered as hers: inspection #24** (7 ▲; work order #67 pantry knob; order #69:
  extinguisher, first aid kit, drinking glasses; follow-ups #73 gardener Pedro, #74 grill, #75 landscaping photos) and
  her count at Napa's own place dated 10/08 — unclear lines counted 0 "for Shannon to verify". **Concord: she enters it
  herself (#22)** — compare on 2026-10-14 with `docs/reference/inspection-expected-2026-10-01-concord.md`.
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

- **§165** deployed 2026-10-15 (089 applied). Not exercised end to end: a real
  receipt with a new line through ✨ (the AI's `measure`/`furniture` fields) — try it on the next purchase.

## History

§18a, §53, §56–§64, §68, §70, §79, §80, §121, §122, §123, §124, §133, §134, §135, §136, §137, §138, §139, §140, §141, §142, §147, §150, §154, §156.
- **A to-do's order is a purchase with no price (owner, 2026-10-13):** `TaskPurchase` opens as "🛒 Purchase order" — items,
  quantities, places, 💾 Save order (`todoOrder`). Total paid / paid by / receipt / "close this to-do" appear only after
  "🧾 Bought — record it" (← back to the order returns). The to-do row's link reads "+ 🛒 purchase order".
- **A to-do's purchase order = the Record-a-purchase form (owner, 2026-10-14):** `TaskPurchase` shows items, total, paid by,
  note, receipt at once; 💾 Save order = the order (draft, no price), 🧾 Record the purchase = the order processed. The
  two-step "Bought — record it" is gone. SOP #15 v13 has the new wording.
- **✨ Read receipt (owner, 2026-10-14):** the three purchase entries are one `PurchaseForm`. With a receipt attached (or a
  cleaner's own, read from Drive by `fieldExpenseId`) "✨ Read receipt" → `/api/inventory` `readReceipt` → Gemini reads it
  with the supplies list (id | name | measure) and the open orders → `{store, date, total, tax, lines}`; `readReceipt` (pure)
  keeps a supply only when the model says `sure` AND it exists, else the line asks "Is it one of these?" (model's alternatives
  + look-alikes), "+ Add “…” as a new item" (editable name, `newItem`) or Skip. Workers AI cannot read images: no Gemini →
  "Could not read the receipt — fill it in by hand" (`ai_last` records who answered / the errors). Filled fields read
  "✨ from the receipt" until touched; order lines not on it "▲ not on the receipt"; total vs Σ lines (+ tax if no tax line)
  shows the difference. Saves nothing. **One receipt, several orders:** if a line fits another open order, each item gets
  "For the order"; ≥2 orders → `splits` (shares by `splitTotal`, editable, must sum to the total) → `recordPurchases`
  (all checked before any write; one Drive upload; note "part k of n of one receipt"). The receipt's date (≤60 d back)
  dates the Restock expense ("Bought on"). Cleaner's approval: total fixed to what they paid, no split. Practice refuses
  ✨ (nothing leaves the browser). Tested 2026-10-14 locally with a generated store receipt (JPG + PDF; no real store
  receipt was at hand), nothing recorded: 9/10 lines matched, microfiber cloths → doubt, extinguisher → Napa's order #69.
  Open: test with a real phone photo of a receipt; a cleaner's approval was not exercised in the browser.
- **Sizes, several receipts, learned lines (owner, 2026-10-14, 085):** `inventory_items.size` — one item per size, same name
  (unique on name + size); `invItems` returns `name` = "Name — Size" (`itemLabel`, so every screen, order, expense and the
  crew page show it), `baseName`/`size` for editing (Items list → Size column; ✎ Edit settings edits the base name).
  The AI returns each line's `size` and a short generic `name`; `wrongSize` (pure) never matches another size, nor the
  plain item when a sized twin exists. A doubt's "+ Add" has name + size filled in. A line a person decides is learned in
  `inventory_receipt_aliases` (`aliasKey` text → item; sent as `aliases` with the purchase or the field approval) and wins
  over the model next time. **More than one receipt per purchase:** 📎 adds files; "✨ Read the new receipt" reads only the
  unread ones and ADDS lines and total (note "A + B" while untouched; the first date stays); "Read it again" restarts from
  the lines before the first read. Lines show "qty × unit price". Instructions moved behind "?" (to-do order, cleaner's
  approval, split). Tested locally 2026-10-14 with two generated receipts (store + online order): totals added, King /
  Queen shown, bundle and King protector asked. flash-lite still marked microfiber → washcloths sure once — the learned
  lines fix it after the first correction.

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only; tokens and shared components from `docs/design-system.md`.
- **Movement kind badges** (`.ops-kind`) are neutral: OUT filled ink, IN outlined, CLEAN dashed. They were
  amber/green/blue, which read as attention/confirmed/action — the kind is a fact, not a state.
- **Flags** (`.ops-flag`): `urgent`/`req` (same-day, cancelled, open repair, inspection required, the crew
  page's check-in time) are amber = attention; `due`/`deep` (monthly, deep, to-dos, corrected) are neutral.
  Red is no longer used for any of them (red = failure).
- Phone: Operations' eight views keep scrolling sideways (they cannot fit 390), with a faded right edge.
- Open: the crew page's unit title is large on a phone (title1, 28 px) — kept, it is what the cleaner
  scans for; revisit with a cleaner if it wraps on long unit names.
- **Round 2 (§159):** inspection repairs: one work order with a smaller **work order** per repair inside (were "task"
  sub-tasks) and no "Assign and schedule" (the empty Owner says it). Board and Home: inspection / same-day / deep are
  icons with the word on hover (`IconFlag`, Hint.tsx); the rule's reasoning in an open row is behind "The rule says X"
  (Peek); a flag's explanation behind a "?"; "n to-dos / work orders" open Operations → To-do filtered by that unit
  (`kaizen:work-for` event → `WorkView unit`). **Manual cleans can be changed** (owner: "mid-stay cleans can't be fixed"):
  `/api/manual-clean` `update` (cleaner, deep, note, day — not an early departure's day), price re-rated only when the
  cleaner or deep change; "Change…" on the row. Old "Assign and schedule" sub-tasks already in production stay as they are.
- **Round 3 (§159):** the board's flags sit in three fixed slots (icons: same-day · inspection · deep; work: work orders ·
  to-dos; documents: agreement · ID) so each lines up down the column; "deep suggested" is an amber ⚠ icon with the
  nights on hover. Top of Operations: only the board's days and the gear — no Refresh (it reads on opening), no date line
  on other views, no "Live" banner while live and healthy (a green dot on the gear, the sentence on its hover; failures
  and shadow mode still take a banner). On a big screen the view strip is replaced by the side rail + "Operations › View".
- **Round 4:** Operations' top is one line — "Operations › View" and a dark gear alone (icon only, a green dot while live); the control bar shows only on Movements (its days).
- **§163 (2026-10-15):** the gear is no longer a dark disc — card + hairline + ink icon (turns 45° on hover). On a phone the views' strip moves into `.ops-top` and the gear closes that line on the right (56 px, tint, `--r`, same height as the strip); on desktop the strip stays hidden and the line is crumb + gear.
- **Purchase orders (§159 round 5, owner 2026-10-14):** what a cleaner or an inspector asks to buy IS a purchase order
  from the moment it is asked. `openOrders` also lists open `clean_group IN ('request','inspection')` to-dos with no lines
  yet (so they sit under Purchase orders and the receipt reader can match them). A clean's request: each thing asked is
  appended to the order's description ("• Name: …", photos indented) — no sub-task per request (`cleanTodo`); "not found"
  items (`ranOut`) also go in as lines (qty 1, the unit's place; none when the unit has no supplies place). A request with
  no clean (helper/link) is marked `request` too. Inspection purchases: "Purchase order for X: n items", no sub-task per item
  (lines from the picked supplies as before). **✨ Build the cart** (`/api/inventory` `readRequest` → `functions/_lib/request-read.ts`,
  the AI chain + `readReceipt`'s checks + learned aliases): sure lines go into the cart, the rest "is it one of these?";
  it reads the description and, on older requests, the open sub-tasks; nothing is saved until 💾 Save order. **!** beside
  what is already on hand (`onHand`, src/lib/inventory.ts — places with a counted quantity > 0), the places on hover.
  **+ Purchase order** (Purchase orders tab, Home and To-do): free text + listing → a to-do created `asOrder` (clean_group
  `request`), opened in a pop-up on its form. Opening any order lands on its form. Closing one unbought still asks why
  (wording now "this purchase order"). Tested: ✨ on a real request (6 lines, 3 marked on hand). **Not exercised: a
  cleaner's new request through the field link** (writes production; try it with the practice page's flow or a test clean).

- **§164 (owner, 2026-10-15):** the field report form no longer asks urgency (the team validates it — work module); purchase
  orders from Inventory / low stock / a field to-do keep their items as order lines, not sub-tasks; inspection repairs are titled
  by the inspector's note (`repairTitle`).
