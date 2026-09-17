# Kaizen OS — session context

**Read this first.** It is the single source of truth for how this project is built and why. It
exists so a new session does not re-read the code, re-derive the architecture, or re-argue
decisions already made. Update it when a decision changes; do not let it drift.

---

## 1. What this is

A short-term-rental management platform for Kaizen Guest Properties — ~27 units, currently run
out of Hostaway plus a Google Sheet. It measures **profit per unit**, not occupancy, shows which
units are mispriced, lets the team record costs and claims, and alerts by SMS.

It is a product the client owns, on infrastructure the client controls. Not a spreadsheet.

## 2. The stack

| Layer | Choice | Free tier | Commercial use |
|---|---|---|---|
| Repo + scheduled jobs | **GitHub** + Actions | 2,000 min/mo private | yes |
| App + API | **Next.js on Vercel** | Hobby | ⚠️ see §2a |
| Database | **Neon** (Postgres) | 0.5 GB, always-free | yes |
| Auth | **Auth.js** + Google provider | — | yes |
| SMS | **QUO** (formerly OpenPhone) | client's account | — |
| Domain / DNS | **Cloudflare** | registrar at cost | yes |
| Email | **Resend** | 3k/mo | yes |

This is essentially the stack the client asked for, and it is the right one. An earlier draft of
this project routed around it with Google Apps Script and Sheets — that was a mistake born of
over-reading the "no server" constraint. *Serverless functions are not a server.* A Vercel route
holds a secret exactly as safely as Apps Script does, and the client ends up owning a real
platform instead of inheriting a spreadsheet script.

### 2a. The one licensing risk

**Vercel's Hobby plan is licensed for non-commercial use**, and this is a commercial business.
Many commercial projects run on it anyway; it is a risk to know, not necessarily to act on.
The clean exits, in order of cost:

1. **Cloudflare Pages + Workers** — free tier permits commercial use outright. Next.js runs
   there via `@cloudflare/next-on-pages`.
2. **Vercel Pro** — ~$20/mo.

Everything in §3 is host-agnostic on purpose: API routes, a Postgres URL, and cron. Moving hosts
is an afternoon.

## 3. Architecture

```
┌── GitHub ─────────────────────────────────────────────────┐
│  repo + Actions (cron: sync, scrape, alerts)              │
└───────────────┬───────────────────────────────────────────┘
                │
┌── Vercel ─────▼───────────────────────────────────────────┐
│  Next.js                                                   │
│    app/           React Server Components, dashboards      │
│    app/api/       route handlers — the ONLY place secrets  │
│                   are read                                 │
│    src/lib/       pure analytics: proration, ranges,       │
│                   series. No network, no framework         │
└───────┬───────────────────────────┬───────────────────────┘
        │                           │
  ┌─────▼──────┐            ┌───────▼────────┐
  │  Hostaway  │            │  Neon Postgres │
  │  (live)    │            │  costs, claims,│
  │            │            │  decisions,    │
  │            │            │  scraped prices│
  └────────────┘            └────────────────┘
```

**Secrets live in exactly one place:** Vercel environment variables, read only inside
`app/api/**` and in GitHub Actions. Nothing that runs in a browser ever sees a key. A static
site calling Hostaway directly would ship the account ID and API key in its bundle, handing
anyone with devtools full read/write on bookings and guest data.

**`src/lib/` is pure.** No fetch, no React, no env. It takes rows and returns numbers, which is
what makes it testable with `node src/lib/finance.test.ts` and portable if the host ever changes.

## 4. Where each number comes from

| Data | Source | Why |
|---|---|---|
| Listings, calendar, **reservations** | Hostaway API, live | Theirs. Caching only adds staleness and a refresh nobody presses |
| Costs — fixed and variable | Postgres | Hostaway has no idea what the lease is. Entered by the team in-app |
| Claims | Postgres | Same — does not exist upstream |
| Airbnb live price + ratings | Postgres | Scraped by a scheduled job, not an API |
| Pricing decisions + outcomes | Postgres | Our own derived history |

## 5. Scope — what this is and is not

| In scope | Notes |
|---|---|
| Profit per unit, per period | The headline. Every screen ends in a net number |
| Portfolio scoreboard vs target | Target is **computed**, never hardcoded — §6 |
| Charts over time, draggable ranges | §7 |
| Expense entry by the team | Fixed and variable, multiple people |
| Claim entry by the team | Severity, cost, status |

| Out of scope for now | Why |
|---|---|
| Outbound CRM | A product on its own |
| Review dispute tracker | Needs per-platform review APIs we do not have |
| Channel live/dark probing | Costly; low value until the basics are trusted |
| Agents that send anything | Agents draft. Humans send. Always |

**Wanted later, schema already allows it:** expense import from Walmart and Amazon invoices. The
`expenses` table carries `source` and `external_ref` from day one, so that import is a new writer
against an unchanged table rather than a migration.

## 6. Units and targets are variables, never constants

The client's spec prints *"22 live units × $1,500/mo = $33,000"*. Do not hardcode any of the
three.

- **Units go on and off.** The live count is derived at read time from Hostaway (`isListingActive`),
  never counted by hand, never stored.
- **The per-unit target is config**, editable without a deploy.
- **The portfolio target is their product**, so taking a unit offline moves the target instead of
  making the portfolio look like it missed.
- **Monthly targets scale to the period.** Eleven days judged against a month's target is a
  guaranteed red that means nothing.

Every screen showing a target states the unit count it was computed from.

## 7. Graphs and dynamic ranges

The browser fetches once per session and computes every range itself. Dragging a date range must
not hit the network — a chart needs 30–90 buckets and a slider fires per frame.

- Presets live in `src/lib/ranges.ts` and are shared by every screen: MTD, Last 30, Last 90,
  Last month, QTD, YTD, Custom.
- **Bucket granularity is derived from the span**, not offered: ≤31 days daily, ≤120 weekly,
  beyond that monthly. Two years of daily bars is 730 unreadable bars.
- **Buckets clip to the range**, so a part-month reports the part it covers.
- **Partial buckets are flagged**, so a chart can draw the still-filling last bucket differently
  instead of appearing to collapse at its right edge.

## 8. Database

Postgres on Neon. Migrations in `db/migrations/`, plain SQL, applied in order.

```
units              mirrors Hostaway listings; cached for joins, refreshed by the sync
expenses           id, unit_id (null = shared), start_date, end_date, category,
                   frequency, amount, source, external_ref, notes, created_by, created_at
claims             id, unit_id, date, category, severity, status, description,
                   refund, repair_cost, resolved_on, created_by, created_at
price_observations unit_id, observed_at, hostaway_rate, airbnb_rate, stay_nights, window_start
pricing_decisions  unit_id, detected_at, old_price, new_price, context jsonb,
                   outcome, days_to_book, resolved_at
```

**Append-only where it matters.** `expenses`, `claims`, `price_observations` and
`pricing_decisions` are never updated in place except to resolve an outcome. A retry cannot
double-count and yesterday's dashboard stays reproducible.

## 9. What carries over from `../price-monitor`

A working Apps Script panel against the live Hostaway account. **Port the logic; do not port the
platform.** These are proven against real data and worth reading before rewriting:

| From | Worth keeping because |
|---|---|
| `Code.js` — Hostaway auth, calendar fetch | The API ignores its own filter params; the code re-clamps results and caches which URL spelling works |
| `Finance.js` — proration, reservation handling | Already ported to `src/lib/finance.ts` with tests |
| `Agent.js` / `Checkout.js` / `Ratings.js` | Airbnb price + rating scraping ladder. Fiddly, works |
| `Notify.js` — QUO/SMS | GSM-7 folding and segment counting, already debugged |
| `PriceSuggest.js` — peer pricing | Prices each unit against comparable units in the same portfolio. No scraping needed |
| `Decisions.js` — the decision log | Detects price changes, records outcomes |

**Hard-won lessons that still apply** (the rest were Apps Script quirks and are now irrelevant):

- Airbnb search results with dates show **whole-stay totals**, not nightly rates.
- Hostaway reservations with `totalPrice = 0` are iCal blocks and owner stays; the listing's
  default cleaning fee still resolves, and subtracting it invents negative revenue.
- Hostaway `propertyTypeId` is opaque per account — id 1 and 2 on this account mean apartment and
  house, confirmed against the listings themselves.
- Airbnb says "Entire condo" for most US apartments; matching on exact type strings throws away
  most of the real comp set.

## 10. Decisions already made — do not re-open without a reason

1. **Postgres, not Sheets.** The client owns the platform. Hand-entry happens through app forms.
2. **Secrets only in API routes and Actions.** Never in a component, never in a public env var.
3. **`src/lib/` stays pure.** No fetch, no framework. It is the part that outlives host choices.
4. **Profit is the headline**, not occupancy. Every screen ends in a net number.
5. **Agents draft, humans send.** Nothing writes a price to Hostaway. Autonomy is earned through
   the decision log.
6. **Alert on change, not on state.** Fire once when a condition begins, once when it resolves.
7. **Ugly and working before pretty.** The client's own spec puts the visual layer last.

## 11. Build order

| Phase | Ships | Status |
|---|---|---|
| 0 | `src/lib/` analytics — proration, ranges, series | **done**, tested |
| 1 | Next.js scaffold, Auth.js + Google, Neon connected, migrations | **next** |
| 2 | Hostaway client in `src/lib/hostaway.ts` + `/api/portfolio` | |
| 3 | Money screen: scoreboard → per-unit tile → per-unit P&L | |
| 4 | Expense + claim entry forms | |
| 5 | Charts and range control | |
| 6 | GitHub Action: nightly sync, scrape, QUO alerts | |
| 7 | Decision log view | |

Phases 1–5 are the demo.

## 12. Open questions — need a human, do not guess

- Neon project and connection string — who creates it.
- Which Google accounts may sign in.
- Domain: none yet. Vercel's free URL is enough until the client has seen it work.
- `TARGET_NET_PER_UNIT` — the spec says $1,500; confirm it is current.
- The spec says 22 units; Hostaway returns 27. Confirm before it goes on a screen.
- Ownership and payment terms. **Not a technical question — do not resolve it in code.**

## 13. Conventions

- **Comments explain *why*, never *what*.**
- **Verify before building on it.** Static checks do not catch runtime or layout failures. If a
  layer has never run, say so rather than stacking another on top.
- **Delete work that nothing reads.**
- **State limitations in the UI**, not only in comments. A number whose basis is thin says so.
