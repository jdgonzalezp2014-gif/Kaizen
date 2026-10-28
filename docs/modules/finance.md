# Module: finance

Profit per unit, pricing advice, costs, ratings and alerts. Tabs: **Units** (first tab),
**Revenue** (Profit · Claims & upselling), **Costs** (fixed · one-offs · cleanings cost view).

## Files

- Screens: `src/screens/Units.tsx`, `Revenue.tsx`, `Costs.tsx`, `Cleanings.tsx` (cost view),
  `ImportPanel.tsx`; components `charts.tsx`, `Filters.tsx`, `RangePicker.tsx`, `Glossary.tsx`, `Loading.tsx`.
- API: `portfolio.ts`, `units.ts`, `forward.ts`, `pricing.ts`, `suggest.ts`, `market.ts`,
  `expenses.ts`, `import.ts`, `cleanings.ts`, `cleaning-log.ts`, `feed.ts`, `observations.ts`, `cron.ts`.
- Server libs: `classify.ts`, `gemini.ts`, `airbnb.ts`, `feed.ts`, `outcomes.ts`, `quo.ts`,
  `cleanings-import.ts`, `csv.ts`.
- Pure libs: `finance.ts`, `revenue.ts`, `verdicts.ts`, `forward.ts`, `breakdown.ts`, `ranges.ts`,
  `series.ts`, `channels.ts`, `scrape.ts`, `alerts.ts`, `sms.ts`, `format.ts`, `progress.ts`.

## Tables

`units` (special_status, parked), `expenses` (fixed monthly rows + one-offs; `source`,
`external_ref`), `pricing_decisions`, `price_observations` (`feed_key`), `listing_platforms`,
`alert_state`, `alert_log`, `cleanings` (shared with operations).

## Rules that bite

- Hostaway is read live, never cached; ask only for the dates on screen
  (`fetchReservationsTouching`, pages of 100, 8 at a time); the token is kept encrypted (§69).
- Profit is the headline; occupancy is a guardrail beside it (§18). Occupancy uses
  **sellable** nights — blocked ≠ empty (§15).
- Targets are computed: per-unit target × units **active and not parked**; revenue counts
  every listing including archived; shared costs divide among live units (§6, §31, §50).
- Active = Hostaway `specialStatus` null (§31). `bookingengine` = Direct; `customIcal` = blocked (§23).
- Fixed costs: one row per month per line, grid by unit × type; variable costs dated (§16).
- Price changes are recorded **before** they are pushed; push_status says what landed (§17).
  Nothing writes a price without a person.
- Gemini: only this account's figures, a `missing` field, output bounded; never writes;
  logged as `origin='agent'` (§21, §25, §26). Model default `gemini-3.6-flash`.
- Thresholds are calibrated on the portfolio's own distribution (§19a); the verdict leads (§19b).
- Ratings come only from the Apps Script scraper (`../price-monitor`, script
  `1jLlH2RIp-mcbtQ9ganST7S2jwCwFJZg2OoOLrg_wS53kWnawN9nlQsnm`): published CSV feed twice a day
  + `/api/observations` (token = its `KAIZEN_TOKEN`). Airbnb refuses Cloudflare's egress.
  Hostaway's rating is never used. 5-point scale. The feed's price is a 30-night **total** —
  divide by nights once, in one place (§32–§41, §48).
- Alerts fire on change, never on state; red needs ≥ $2,000 at stake; QUO is staged
  (`quo_live` false) (§44, §45).
- Cost categories live in `src/lib/costs.ts` (one list for Costs and Slack); one-offs can
  also be logged from Slack (§117).
- **Everything spent reaches Costs (§137, the owner).** Profit = revenue − `expenses`, so every
  money flow writes an expense, each keyed `(source, external_ref)` so it is idempotent:
  `cleaning` (every clean done and priced — key = clean key, its unit and day, category Cleaning),
  `cleaning_extra` (approved extras), both kept in step nightly by `syncCleaningCosts`
  (`functions/_lib/field-costs.ts`, run by /api/cron and after an extra is approved; a voided or
  re-priced clean follows); `repair` (a work order — or §137 any to-do — completed with a cost, except a repair charged to the owner, §167:
  `settleRepair`; Repairs, "Buy…" = Restock, else the title's category); `inventory` (the team's
  purchase with a cost, Restock); `field` (money paid in the field — a cleaner's, helper's or
  handyman's — once a person approves it: `field_expenses`, Operations → Cleaners). Before §137 Costs
  held only three manual rows: the cleaners' pay ($26.7k since April) was missing from profit.
- Approvals Home door: pending `cleaning_extras` + `field_expenses` surface as a Pulse on Home
  (count + $ at stake, gated on `operations.edit`) that opens Operations → Cleaners — nothing
  else on Home shows them, and a field purchase stays unpaid until approved.
- Money formatting pinned to `en-US` (§20). Dates: an optional filter is `null`, never `''` (§54).

## Open items


- Market / comp data: an intentional empty slot ("not connected").
- QUO SMS still staged.
- Cloudflare Functions placement → Smart (no code).

## History

§4–§7, §9, §14–§28, §30–§48, §50, §53–§54, §62, §69.

- **One-off & repairs: filters, groups, open orders (§150, owner, 2026-10-13):** From/To (default this month; asked
  of `/api/expenses?from=&to=`, up to 3000 lines, ▲ said if capped; no dates = the latest 500 as before), unit,
  category, Find; Group by unit / category / month — a folded line per group with its subtotal; the total of what
  is shown. Dates read `YYYY-MM-DD` (the API returns `start_date::text`; it used to show the ISO timestamp). On top,
  **🛒 Orders not bought yet** (`OpenOrders`, from `/api/inventory`): the draft order and open orders with no
  purchase — hidden for roles that cannot read Inventory.

## Redesign (§158, 2026-10-14, branch `redesign`)

UI only; tokens and shared components from `docs/design-system.md`.
- "Too early to tell" (`tone-info`: the light, the bar, the open row's edge, the verdict) is muted, not
  blue — blue is reserved for actions; it keeps its ● shape and its words.
- Sideways-scrolling grids (`.grid-scroll`: the fixed-cost matrix, the board) sit on the card surface: the
  editable cells were on the grey page and read as disabled.
- Phone: the summary strip is a real two-column grid with hairlines; an odd last figure spans the row.
- Emoji → one-colour icons (phase 0b), e.g. the cost kinds and the Gemini advice.
- **Claims & upselling are income, not cost (§162).** What a case received (`claims.refund`) is `otherIncome` in net
  (`/api/portfolio` → `income`, dated when the case closed); not revenue/ADR/RevPAN. A claim's repair work is already in
  `expenses` through its work orders and purchases — shown in Revenue → Claims & upselling to net a claim, never added.
  That view (`src/screens/Claims.tsx` `ClaimsMoney`, `/api/claims-money`) needs `claims.money`. Alterations are not
  upselling unless collected through the Resolution Center or unpriced on the reservation.
- **§167 (owner, 2026-10-15):** claims & upsells income is dated `received_on` and is Kaizen's part only — when the repair
  was charged to the owner the reimbursement is the owner's up to that cost (`caseResult`); Revenue's "Claims & upsells"
  equals "In net" in Revenue → Claims & upselling. That view: received by day, recovery and result over the cases raised,
  By listing, and Finance can correct the team's figures (same rules, `saveCaseMoney`). A repair charged to the owner is
  not in Costs (`settleRepair`). The team enters the money in Operations (work module).

- **Every line of Costs is audited (owner, 2026-10-28, §171):** a click on a one-off line opens where it comes from —
  `ExpenseAuditPop` (src/components/ExpenseAudit.tsx) ← `GET /api/expenses?audit=<id>` (`auditExpense`,
  functions/_lib/expense-audit.ts, read by `(source, external_ref)`). A `repair` line opens its to-do's own side panel
  straight away (`TodoList task=<id>` ← `GET /api/todos?task=<id>`, any age, with parent and sub-tasks): photos, charges,
  timeline. Purchase / field charge / cleaner extra / clean / store order / typed: facts (who, when, approved by, the clean),
  the text, the receipts (through `/api/comment-image`, which now serves purchase and field receipts too) and "Open the
  to-do #N ›" when there is one. Each line shows its source (icon + word) and its note's first line; only a typed line has ✕
  (automatic lines follow their source). The "?" on Note explains it.
