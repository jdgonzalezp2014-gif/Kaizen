# Module: operations

Kaizen runs the day's operations (the daily file sheet is an archive). Tab **Operations**:
Next 10 days (board) · To-do (→ work module) · Calendar · By cleaner · Inspections ·
Notes log · Rates & rules · Setup.

## Files

- Screen: `src/screens/Operations.tsx` (Board, Setup, Inspections, CleaningsMonth…),
  `src/components/CleaningCalendar.tsx`, `DayPicker.tsx`.
- API: `operations.ts`, `turnover.ts`, `inspections.ts`, `manual-clean.ts`, `ops-settings.ts`,
  `stays.ts`, `cleaning-log.ts`, `cron.ts` (Host Note pass, reconcile).
- Server libs: `ops.ts` (recordCleanings, reconcileRecent, pushHostNotes, opsConfig),
  `daily.ts` (daily-file CSV readers), `cleanings-import.ts`, `sync.ts`.
- Pure lib: `src/lib/operations.ts` (star rule: zoneOf, requiredStars, pickByStars,
  assignByStars, typicalNightly; old tier rule `assign`; rateFor, sameGuest,
  oneCleanPerUnitDay, mergeHostNote, proposeInspections, hostawayReservationUrl), `dates.ts`.
- Script: `scripts/whatsapp-cleanings.mjs` (crew chat history, one-off).

## Tables

`cleanings` (record: `void_reason`, `decided_by` rule / rule:stars / override:…, `source` kaizen/sheet/manual/history,
`MAN-<n>` manual rows), `turnover_overrides` (NULL = the rule decides), `cleaners` (roster,
rate cards, `stars` 1–5, `zones` [] = all, `max_per_day` NULL = no limit), `accounts.assign_rule`, `accounts.ops_rules` / `ops_mode`, `stay_notes`, `inspections`,
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

## Open items

- **Stars built, tiers still deciding (§121).** `accounts.assign_rule = 'tiers'`; the board shows
  "needs ★N · has ★M ✓/▲" and "by stars: X" beside each clean. Next: the owner sets each
  cleaner's stars and zones by hand (seeded from tiers: Veronica and Michelle ★2, Irene ★3,
  K&M ★5 — 12 of 27 cleans read "below" on 2026-10-11, mostly Veronica's hand-set P2 cleans),
  watches a week, then Setup → Preview → **Save and switch to stars**. After the switch: drop
  the tier rule (`assign`, `primaryFor`, `cleaners.tier/position`, tier rules) once nothing reads it.
- Stars limitations: manual cleans (`MAN-`) don't count toward a cleaner's daily max; zones are
  derived from unit names (building prefix, else Houses) — a house can't be its own zone yet.
- Cleanings Log header row is blank in the daily file (read by column order) — **ask before
  touching that sheet**.
- Not built: Sheets mirror with the crew's Spanish tabs; crew cleaning sessions.
- Cleaner Slack channels: prepared, sent by hand only (see slack module).

## History

§18a, §53, §56–§64, §68, §70, §79, §80, §121.
