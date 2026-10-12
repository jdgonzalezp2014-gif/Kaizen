# Module: operations

Kaizen runs the day's operations (the daily file sheet is an archive). Tab **Operations**:
Next 10 days (board) · To-do (→ work module) · Calendar · By cleaner · Crew · Inspections ·
Notes log · Rates & rules · Setup. Plus the **crew page** each cleaner sees (§122).

## Files

- Screen: `src/screens/Operations.tsx` (Board, Setup incl. StarSetup/CrewSetup, Inspections, CleaningsMonth…),
  `src/screens/Crew.tsx` (CrewHome = the cleaner's page, CrewAdmin = Operations → Crew; one CrewView for both),
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
- Script: `scripts/whatsapp-cleanings.mjs` (crew chat history, one-off).

## Tables

`cleanings` (record: `void_reason`, `decided_by` rule / rule:stars / override:…, `source` kaizen/sheet/manual/history,
`MAN-<n>` manual rows), `turnover_overrides` (NULL = the rule decides), `cleaners` (roster,
rate cards, `stars` 1–5, `zones` [] = all, `max_per_day` NULL = no limit, `email`, `invoice_period`,
`link_token_hash`), `accounts.assign_rule`, `accounts.crew_calendar(_days)`, `crew_extras_folder`,
`cleanings.flag_note/flagged_by/at`, `cleaning_extras` (+ `cleaning_extra_files`), `crew_declines`,
`crew_schedule_confirms` (snapshot jsonb), `accounts.ops_rules` / `ops_mode`, `stay_notes`, `inspections`,
`extra_inspectors`, `host_note_pushes`.

## Rules that bite

- **`ops_mode = 'live'` since 2026-09-25**: Kaizen decides and writes Host Notes; the
  Cleanings Log import refuses in live mode. One writer per record (§64, §68).
- The board = Hostaway (stays) + overrides + rules; nothing re-decided from the sheet.
  "Today" is New York's (§63, §64).
- Live rules: next-booking horizon 10 days, long vacancy 7 days. The team assigns
  P2 → Veronica, CL → Michelle by hand (overrides), not by the tier rule (§65) — zones replace that.
- Stars (§121): required = band of the next guest's **price per night** (inside the horizon; else
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
- "Not needed" / "TBD" are states, not cleaners; match on words, not emoji (§57).
- Bulk writes with `unnest`, never one INSERT per row (§62).
- Ops role sees the board without booking values (`money` permission) (§63, §65).

- Crew page (§122): a cleaner = an Access sign-in whose email is on the roster → role `cleaner`,
  permission `crew` (not assignable; opens /api/crew + /api/settings only); exempt from the
  allow-list; a member row for the same address wins and roster save refuses a member's address.
  **Cleaners never see stars** — stripped from the payload, not just hidden.
- Invoice = done, assigned, not-void cleans in the period — per cleaner: **weekly Saturday–Friday, paid
  the next Saturday**, or monthly, paid the first Saturday after the month (assumed) — + approved extras on
  them; void rows listed as "not paid" with the reason; unpriced counted, never $0.
- Extras: cleaner, own clean, done, ≤60 days, ≤$500, optional receipts/photos (≤5, 15 MB, image or
  PDF) to Drive "Kaizen — crew extras" uploaded BEFORE the row is saved. Team approves (note
  optional) or denies (note required); only pending can be decided or withdrawn.
- Flag by hand = a note the cleaner reads; does not change pay.
- Schedule shown only with `crew_calendar` on (Setup → Crew pages): live board, `crew_calendar_days`
  ahead. The team **confirms** it (Operations → Crew) = a snapshot; cleaners see "last confirmed"
  and movements since (moved/extended, shortened, cancelled, declined, reassigned, new, time);
  after the snapshot's last day = "not confirmed yet".
- Decline: only with the calendar on, only a clean the board gives them now → override `tbd`
  (`declined by <name>`) or, for MAN-, the record set tbd; `crew_declines` row; the star rule
  never hands it back to them; board shows "▲ declined by X — reason"; live mode pushes the Host Note.

## Open items

- **Stars built, tiers still deciding (§121).** `accounts.assign_rule = 'tiers'`; the board shows
  "needs ★N · has ★M ✓/▲" and "by stars: X" beside each clean. Next: the owner sets each
  cleaner's stars and zones by hand (seeded from tiers: Veronica and Michelle ★2, Irene ★3,
  K&M ★5 — 12 of 27 cleans read "below" on 2026-10-11, mostly Veronica's hand-set P2 cleans),
  watches a week, then Setup → Preview → **Save and switch to stars**. After the switch: drop
  the tier rule (`assign`, `primaryFor`, `cleaners.tier/position`, tier rules) once nothing reads it.
- **Crew page built, not switched on (§122).** To start: set each cleaner's email (Setup → Crew
  pages); in Cloudflare Zero Trust add those emails to the Kaizen Access policy with One-time PIN
  on. Calendar stays off until the star schedule is checked; then turn it on and Confirm in
  Operations → Crew. Fallback links need an Access Bypass app for `/crew`, `/assets/*`,
  `/api/crew-link` (not created). Not built: notifying the team on a decline (Slack), approved
  extras in Costs (they are only on the invoice), payment status ("paid") on invoices.
- Stars limitations: manual cleans (`MAN-`) don't count toward a cleaner's daily max; zones are
  derived from unit names (building prefix, else Houses) — a house can't be its own zone yet.
- Cleanings Log header row is blank in the daily file (read by column order) — **ask before
  touching that sheet**.
- Not built: Sheets mirror with the crew's Spanish tabs; crew cleaning sessions.
- Cleaner Slack channels: prepared, sent by hand only (see slack module).

## History

§18a, §53, §56–§64, §68, §70, §79, §80, §121, §122.
