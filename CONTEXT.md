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

| Layer | Choice | Free tier |
|---|---|---|
| Repo + scheduled jobs | **GitHub** + Actions | 2,000 min/mo private |
| App + API | **Vite + React on Cloudflare Pages**, API via Pages Functions | unlimited static, 100k fn req/day |
| Database | **Neon** (Postgres) | 0.5 GB, always-free |
| Auth | **Cloudflare Access** — Google sign-in, no auth code | 50 users |
| SMS | **QUO** (formerly OpenPhone) | client's account |
| Domain / DNS | **Cloudflare** | registrar at cost |

This is essentially the stack the client asked for, and it is the right one. An earlier draft of
this project routed around it with Google Apps Script and Sheets — that was a mistake born of
over-reading the "no server" constraint. *Serverless functions are not a server.* A Vercel route
holds a secret exactly as safely as Apps Script does, and the client ends up owning a real
platform instead of inheriting a spreadsheet script.

### 2a. Two choices worth understanding

**Vite, not Next.js.** Next.js earns its keep with server rendering, and this is an auth-gated
dashboard: no SEO, no public pages, and every number is computed in the browser by design (§7).
Running it on Cloudflare needs the `next-on-pages` adapter, which is another moving part that can
lag Next releases. Pages Functions are native — a file at `functions/api/x.ts` *is* the route
`/api/x`, with no adapter. If the client insists on Next.js later it is a contained swap; the
analytics core and the Functions do not change.

**Cloudflare Access, not Auth.js.** Access sits in front of the whole site at the edge, so an
unauthenticated request never reaches a Function at all. It provides Google sign-in, an email
allowlist managed in a dashboard rather than a deploy, and it is free to 50 users. Auth.js would
have meant a session store, a callback route, a login page and secret rotation to arrive at the
same place. **There is no auth code in this project, and that is the point.**

Access forwards the verified identity as `Cf-Access-Authenticated-User-Email` *after* validating
its JWT. It cannot be spoofed from outside because a spoofed request never gets past Access.
Locally there is no Access, so the header is absent and `functions/_lib/auth.ts` falls back to a
loud placeholder — a row written in dev says so in `created_by` rather than impersonating anyone.

### 2b. Runtime constraints that are not preferences

- **No raw TCP on Workers**, so `pg` cannot connect. `@neondatabase/serverless` speaks HTTP.
  This is why the driver choice is not interchangeable.
- **No ambient `process.env`.** Cloudflare passes bindings to the handler, so server modules take
  credentials as arguments. That also makes them testable and gives them no hidden inputs.
- **`functions/` is invisible to Vite.** Server code physically cannot reach the browser bundle —
  a stronger guarantee than a convention about what not to import.

## 3. Architecture

```
┌── GitHub ─────────────────────────────────────────────────┐
│  repo + Actions (cron: sync, scrape, alerts)              │
└───────────────┬───────────────────────────────────────────┘
                │  push → build → deploy
┌── Cloudflare ─▼───────────────────────────────────────────┐
│  Access          Google sign-in at the edge, 50 users     │
│  Pages           static Vite build                        │
│    src/lib/      pure analytics — no network, no framework│
│  Pages Functions functions/api/* — the ONLY place secrets │
│    functions/_lib/   server-only clients                  │
└───────┬───────────────────────────┬───────────────────────┘
        │                           │
  ┌─────▼──────┐            ┌───────▼────────┐
  │  Hostaway  │            │  Neon Postgres │
  │  (live)    │            │  costs, claims,│
  │            │            │  observations, │
  │            │            │  decisions     │
  └────────────┘            └────────────────┘
```

Cloudflare Pages builds from GitHub on every push, with a preview URL per branch and per pull
request. Deployment is `git push`; there is no deploy step to run or forget.

## 4. Where each number comes from

| Data | Source | Why |
|---|---|---|
| Listings, calendar, **reservations** | Hostaway API, live | Theirs. Caching only adds staleness and a refresh nobody presses |
| Costs — fixed and variable | Postgres | Hostaway has no idea what the lease is. Entered by the team in-app |
| Claims | Postgres | Same — does not exist upstream |
| Airbnb live price + ratings | Postgres | Scraped by a scheduled job, not an API |
| Pricing decisions + outcomes | Postgres | Our own derived history |

## 4a. Multi-tenant by shape, single-tenant in fact

Hostaway credentials are **entered in the app and stored per account**, not baked into a
deployment as environment variables. That was a deliberate call: env-var credentials work exactly
once — one deployment, one property manager, forever — and the intent is to be able to sell this
to other hosts.

**Done now because it is nearly free now and brutal later.** Adding `account_id` to five
populated tables, backfilling it, and auditing every query for a missing filter is the class of
migration that leaks one customer's revenue into another's dashboard. Done while `units` was
empty, it cost one file.

**What it is not:** a single-row `accounts` table is not production multi-tenancy. There is no
row-level security, no per-tenant rate limiting, no onboarding, no billing. What it buys is that
adding those is additive rather than a rewrite.

Two details that matter:

- **`units` is keyed on `(account_id, id)`.** A Hostaway listing id is unique only within its own
  Hostaway account; two customers can both own listing `366041` and they are different
  apartments. Every foreign key is composite for the same reason.
- **The backfill `DEFAULT 1` is dropped immediately after.** It existed to fill the one row that
  already existed. Left in place, a future insert that forgets `account_id` would silently file
  another tenant's data under account 1 instead of failing.

**Credentials are encrypted at rest** (`functions/_lib/crypto.ts`, AES-256-GCM via WebCrypto).
The master key lives in `ENCRYPTION_KEY` in the environment, never in the database — an attacker
needs both the dump and the deployment's secrets. GCM rather than CBC because it authenticates:
tampered ciphertext fails to decrypt instead of producing garbage that gets sent to Hostaway as a
credential. The plaintext key never travels back to a browser; a settings screen shows
`maskKey()` output.

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

**Onboarding is self-service.** A new host enters their own Hostaway credentials in Settings and
imports their existing costs/claims spreadsheet as CSV. Nothing about adding a customer touches a
deployment. `/api/import` always previews before writing — an import is the one operation where
being wrong is both easy and invisible — and reports unmatched rows rather than guessing or
silently dropping them.

**Wanted later, schema already allows it:** expense import from Walmart and Amazon invoices. The
`expenses` table carries `source` and `external_ref` from day one (CSV imports already write
`source = 'import:csv'`), so that is a new writer against an unchanged table rather than a
migration.

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

Postgres on Neon — project `frosty-math-62141251`, branch `production`.

Migrations are plain SQL in `db/migrations/`, applied in filename order by `npm run migrate`.
The runner records what it applied in `_migrations`, so re-running is a no-op — a migration you
are afraid to run twice is one nobody runs at all. Each file runs in a transaction, so a syntax
error halfway down leaves no half-built schema.

It connects on `DATABASE_URL_UNPOOLED`: Neon's pooler multiplexes sessions and DDL wants one to
itself. `neon link` writes both URLs into `.env.local`, which is gitignored.

**Applied:** `001_init.sql` (7 tables, 14 indexes), `002_accounts.sql` (tenant scoping,
composite keys, encrypted credentials).

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
| 1 | Vite scaffold, Pages Functions, Hostaway client, `/api/portfolio` | **done**, builds |
| 2 | Neon project linked, schema applied, migration runner | **done** |
| 3 | `/api/sync-units` — populate `units` from Hostaway | built, **not yet run** |
| 3b | Settings screen — credentials, targets, sync | **done** |
| 3c | CSV import for existing costs and claims spreadsheets | **done** |
| 4 | Connect GitHub → Cloudflare Pages, enable Access | needs a human |
| 5 | Money screen: scoreboard, net by unit, net over time | **done** |
| 6 | Expense + claim entry forms | |
| 8 | GitHub Action: nightly scrape + QUO alerts | |
| 9 | Decision log view | |

Phases 2–3 are account setup, not code. Everything after is the demo.

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
- **State limitations in the UI**, not only in comments. A number whose basis is thin says so. The
  Money screen refuses to show a clean green board when no costs are recorded — it says net is
  revenue only, because a board that means "we have not entered our expenses" is worse than none.
- **Charts follow `dataviz`.** Status colours are the validated trio (`#0ca30c` / `#fab219` /
  `#d03b3b`) and always ship an icon and a word: warning sits below 3:1 on a light surface by
  design, so colour never carries meaning alone. Bucket granularity comes from the range length,
  partial buckets are hatched rather than hidden, and axis labels are selective.
- **"It deployed" and "it works" are different claims.** Three times now something typechecked,
  built and was wrong in a way only a real request could show: two Apps Script load-time crashes
  and an auth helper that failed open. Static checks verify the code does what it says; they
  cannot tell you the assumption underneath was false.

## 14. Hostaway fields, confirmed against the live account

Probed 2026-09-17 on account 144914. These are observed values, not
documentation — the published reference does not describe most of them.

**On a listing** (`GET /listings`):

| Field | Meaning | Trap |
|---|---|---|
| `price` | default nightly rate | the calendar overrides it per night |
| `cleaningFee` | what the **guest is charged** | this is REVENUE, not the cleaner's pay |
| `weeklyDiscount` | **multiplier**, e.g. `0.85` = 15% off | `0` means unset, and `(1-0)*100` is a free stay |
| `monthlyDiscount` | multiplier, e.g. `0.75` = 25% off | same |

Conversion lives in `discountPct` / `discountMultiplier` in
`functions/_lib/hostaway.ts` and nowhere else. The zero guard is the
whole reason they are functions.

**On a calendar day** (`GET /listings/{id}/calendar`): `date`, `price`,
`status` (only ever `available` | `reserved` | `blocked` on this
account), `isAvailable`, `minimumStay`.

**The cleaning number is two numbers.** Hostaway's `cleaningFee` is what
the guest pays. What the cleaner is paid lives in the host's own sheet
and comes in via `/api/cleanings`. Conflating them is wrong twice over —
it inflates revenue and deletes a cost on the same booking.

### Writes
`PUT /listings/{id}` takes a partial object and is documented.
The calendar write is **not** documented — `functions/_lib/hostaway.ts`
tries `PUT`, then `POST`, then an array body, and decides success only by
**reading the range back**. A 200 that changed nothing is the one outcome
the decision log must never record as applied.

## 15. Blocked is not empty

Four units in this portfolio are blocked solid for the next 30 days.
Occupancy is measured against **sellable** nights (open + sold), never
calendar nights, so those units report as `offline` rather than 0%.

With calendar nights as the denominator they read 0% and sort to the top
of "needs a discount" — recommending a price cut on units nobody can
book. `src/lib/forward.ts` holds the rule and `forward.test.ts` pins it,
along with the related trap that `occupancy || fallback` treats a real
0% as missing and buries the most urgent row in the table.

Three states that must stay distinct: **sold**, **open**, **blocked**. A
unit that is 100% blocked is neither fully occupied nor empty; it is out
of service.

## 16. Costs have two shapes

**Fixed** is a recurring *line* — Lease, Internet — with **one row per
month**. Editing August edits August; last year does not move. A line is
identified by `(account_id, label, unit_id, start_date)` and a unique
index makes "carry forward" idempotent, which matters because the button
gives no sign it worked the first time and will be clicked twice.

**Variable** is dated and one-off, charged to a unit (a repair) or shared
and divided across active units.

Fixed is presented as a **grid: one row per unit, one column per cost
type** (Lease, Internet, Pool maintenance…), one month at a time. A flat
list answers "what did we spend"; the grid answers "what does each unit
cost to keep", which is the question behind every per-unit number here.
It also makes a hole visible — an empty cell in a column every other
unit fills is a bill someone forgot to enter, which a list hides.

Columns are derived from the labels present this month plus those seen in
the last three, so an unfilled month still shows the shape of the one
before it. The shared row divides by units that are **active and not
parked**; a parked unit keeps its own row, because it still has a lease.

`unit_id IS NULL` means shared. Amounts are never edited in place except
through the month upsert; a correction is a new row.

## 17. Price changes are recorded before they are pushed

`POST /api/pricing` writes the decision **first**, then attempts
Hostaway, then updates the row with what actually landed
(`push_status`: `none` | `applied` | `partial` | `failed`).

A push that fails must leave a row saying so, never no row. The log's
only purpose is learning which price moves filled nights, and it is
worthless if it silently contains just the successes.

The evidence — occupancy, open nights, old price — is frozen at decision
time. It cannot be recovered afterwards, because by then the discount has
already changed the thing that prompted it.

`pricing_decisions` has a foreign key to `units`, so a price change
before the first listing sync fails on the INSERT. That is handled as a
setup message, not a 500.

## 18a. The cleanings sheet

Published CSV, stored per account in `accounts.cleanings_csv_url`. It is
a **log** — one row per clean, with `Unit`, `💲 Price`, `🧽 Deep`,
`Cleaner` — not a per-unit rate table.

Two things follow:

* Header keys are normalised by stripping everything that is not a
  letter or digit, because `💲 Price` otherwise normalises to `💲price`
  and a lookup for `price` silently reads empty. That is an import which
  reports zero matches instead of an error.
* The per-unit cost is the **median of the standard (non-deep) cleans**,
  not the most recent. The same unit legitimately shows different prices
  — P2-1304 appears at both $35 and $70 — so "latest wins" would swing
  its recurring cost by double depending on who cleaned last. Deep cleans
  are held out and reported separately.

Rows with no price ("Not needed", "TBD") are skipped, never counted as
zero. Coverage is partial by nature: 10 of 27 units at the last run.

## 18b. Sync was broken from migration 002 until 2026-09-17

`syncUnits` upserted with `ON CONFLICT (id)` and never passed
`account_id`. Migration 002 had made the primary key `(account_id, id)`,
and Postgres rejects an `ON CONFLICT` target with no matching unique
index — so **every sync failed outright** and `units` stayed empty. That
in turn blocked costs, claims and price decisions, all foreign-keyed to
it, and the failure surfaced only as "no units yet".

It typechecked the whole time. Nothing but running it could have found
it. See §13 on the difference between deployed and working.

## 18. Occupancy is a guardrail, not the opposite of profit

The tagline once read "Profit per unit. Not occupancy." That framing was
wrong and the owner said so: occupancy was *his* proposed guardrail,
dismissed by a boss who reads only dollar figures.

Both numbers are gameable alone. Profit clears on a half-empty calendar
at a high rate; occupancy hits 86.7% against a 60.7% market on $63
RevPAR. So occupancy sits **beside** net in the unit table, with a floor
breach marked, and RevPAN is in the hero row — RevPAN being occupancy
expressed in dollars, which is the version that survives contact with a
boss who only sees money.
