# Kaizen OS as a product (running notes)

Kaizen OS started as Kaizen Guest Properties' internal tool. The goal now (owner, 2026-11-13/15) is software other
short-term-rental hosts can buy. **This file is the parallel track.** Every session that adds something adds a line here:
what is already reusable and what is still hard-wired to Kaizen. Keep it short and factual.

## Principles
- **Each company brings its own accounts.** Hostaway, Stripe, Slack, Google, AI keys, Quo are entered in **Settings →
  Integrations** and stored encrypted per account. They are never in code or env files.
- **Multi-tenant by shape.** Tables carry `account_id`, but almost every query still reads `account_id = 1` (see the debt below).
- **The guest never logs in.** One signed link per reservation (`/guest/<id>.<sig>`).
- **The vendor experience stays simple:** one portal for cleaners and handymen.
- **No paragraphs on screen.** How-to text goes behind a "?". This holds for every tenant.

## Modules (target structure)
Core (listings + Repository, reservations, users/roles, integrations) · Leadership · Guest Services (upsells, claims,
messages inbox + AI with human escalations) · Operations · Guest Experience · Finance/Data/Tech · Shared tools ·
Vendor portal · Guest portal. Future: Sales & Growth, Schedules.

## Integrations (Settings → Integrations, 2026-11-15)
| Service | Used for | Where the key lives |
|---|---|---|
| Hostaway | listings, reservations, calendar, door codes (`doorCode`), photos (`listingImages`), messages | `accounts.hostaway_*_enc` |
| Stripe | guest payments (waiver, deposit hold, extras) + vendor payouts (Connect); webhook into the books | `accounts.stripe_secret_key_enc` (099), `stripe_webhook_secret_enc` (119); test keys only for now |
| Slack | team alerts, approvals | `accounts.slack_*_enc` |
| Google Drive | Repository files, check-in photos | OAuth per account |
| Claude / Gemini | AI drafts, guest replies (next), pricing | `accounts.*_api_key_enc` |
| Quo | SMS | `accounts.quo_*` |
| Identity | ID + selfie at check-in | not chosen (Truvi vs Stripe Identity) |

**Payments, decided for replicability:** the guest pays on **Stripe Checkout** (Stripe's hosted page). Reasons: it
needs no publishable key and no Apple Pay domain registration per tenant, it shows Apple Pay / Google Pay / Link / cards
automatically, and each tenant brands it in their own Stripe dashboard. The deposit is a Checkout payment with
`capture_method=manual` (a hold, ~7 days) or a saved card (SetupIntent) for longer stays. An embedded Payment Element can
come later for a fully in-page look. Built 2026-11-15 (`functions/_lib/guest-pay.ts`, the tenant's own key; test mode only).

## Hard-wired to Kaizen today (debt to clear before selling)
- `account_id = 1` in queries throughout `functions/` → needs the signed-in user's account.
- Cloudflare Access + one Pages project → each tenant needs sign-in by account (or one Access app with many accounts).
- Guest portal brand: Kaizen's black + gold and Quattrocento / Open Sans (`.guest-brand`). Should become per-account
  (logo, 2 colours, 2 fonts).
- Times: Texas (`America/Chicago`) for the 8 PM early/late cut-off; New York for the board. Should be a per-account time zone.
- Prices: early / late $20/hour, damage-protection defaults by unit type (`PROTECTION_DEFAULTS`), upsell placeholders.
  Should be per-account settings, with per-listing overrides in the Repository (migration 110 adds the listing part).
- Repository tables `houses`, `the_links`, `cortland_legacy` are Kaizen's portfolios. A new tenant starts from one generic Units table.
- Slack texts and SOPs mention Kaizen's people and channels.
- Cleaning zones come from unit names (`zoneOf`: "CL 1125" → CL, "P2-1406" → P2, anything else → Houses). The zones rule
  (§174) is generic; the zone of a unit should become a Repository field (or `units.unit_type`) per account.

## Log
- 2026-11-15 — Guest portal online check-in (636c53a): details from Hostaway, identity placeholder, waiver/deposit,
  rules, extras, pay (mock), door code. Cover photo from Hostaway, early/late $20/h + 8 PM rule (d438c3d).
  Settings → Integrations panel. This file started. Integrations became a menu: each service unfolds its own settings.
- 2026-11-15 — Who cleans by zone (§174): main zones per cleaner + overflow past their max. Reusable as is.

- Stripe inside the guest portal (2026-11-16): publishable key per account (accounts.stripe_publishable_key, 115) and wallet domains registered per account from Settings (/api/stripe-domains) — reusable; each tenant registers its own domains.
- 2026-11-16 — **Menu by modules** (`src/lib/modules.ts`): the product's map is data, so a tenant's menu can later be cut by plan as it is
  by role. **Guest Services → Inbox (CRM)**: reusable as is — conversations from the tenant's Hostaway, SMS from its Quo, the reply AI
  with the tenant's own key and a model it names, sending staged until the tenant turns it on (Settings → Integrations → Guest
  messages & AI). New debt: `GUEST_TZ` America/Chicago for message moments; `account_id = 1` in the new routes like the rest.
  **Guest portal on its own domain:** `accounts.guest_portal_url` is the only source of portal links (`portalLink` + `signGuest`);
  the nav's "Guest portal → Preview" still opens `/crew/guest-demo` on the team app — repoint it when the portal moves.

- 2026-11-16 (inbox, phase 1): automations, `guest_checkins`, `guest_events` and the watch are per `account_id`; the webhook secret is
  derived from the tenant's own key. **Hard-wired to Kaizen:** `GUEST_TZ` (America/Chicago) for every moment, the Slack topic
  `escalations` as the only place the watch reports, account id 1 in every query, English-only recipes and triage prompt.
- 2026-11-19 (guests, upsell charges §178): per account — `upsell_charges`, the pay link's host from `guest_portal_url`, Stripe key from Settings.
  **Hard-wired:** $20/hour for early/late, the 8 AM–6 PM hour window, Airbnb's URLs (Resolution Center, host reservation page), English guest texts.
- 2026-11-19 (inbox, guest AI audit): company facts per account (`guest_ai.business`). **Hard-wired:** `GUEST_SECTIONS` (Kaizen's SOP
  section keys), the Repository column keys `listingFacts` reads (`max_guests`, `hw_*`, fees…), `UNIT_TABLES`, the English playbook prompt.
- 2026-11-23 (inbox + guests, drafts on arrival / portal first): per account — `guest_ai.autoDraft|portalFirst|oldPortalNotice`, protection values
  per listing in the Repository. **Hard-wired:** the protection defaults ($300 deposit, $12/night waiver, $70 minimum — `PROTECTION_DEFAULTS`),
  "old check-in" = Hostaway's agreement signed / ID verified, `scripts/description-protection-notice.mjs` (Kaizen's English text and Hostaway fields).
- 2026-11-23 (guests, the portal's real door): per account — `guest_flows`, the stay link's HMAC. **Hard-wired:** the release time (noon Central
  the day before arrival, `RELEASE_HOUR` / `STAY_TZ`), English guest texts and to-do titles, Cortland's / The Links' building guides (data, not code).
