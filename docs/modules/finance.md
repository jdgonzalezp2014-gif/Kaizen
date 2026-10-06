# Module: finance

Profit per unit, pricing advice, costs, ratings and alerts. Tabs: **Units** (first tab),
**Revenue**, **Costs** (fixed · one-offs · cleanings cost view).

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
- Money formatting pinned to `en-US` (§20). Dates: an optional filter is `null`, never `''` (§54).

## Open items

- Market / comp data: an intentional empty slot ("not connected").
- QUO SMS still staged.
- Cloudflare Functions placement → Smart (no code).

## History

§4–§7, §9, §14–§28, §30–§48, §50, §53–§54, §62, §69.
