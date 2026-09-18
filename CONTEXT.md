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

## 19. The revenue-manager metric set

`src/lib/revenue.ts`, all pure and tested. Occupancy alone routinely
points the wrong way; these are what make it a verdict.

| Metric | What it answers | Why it earns its place |
|---|---|---|
| **RevPAN** | money per available night | occupancy and rate in one dollar figure |
| **ADR achieved** | what sold nights actually got | the benchmark the asking price is judged against |
| **Open ask** | average price on still-open nights | was "Asking", which said nothing on its own |
| **Pickup (7d)** | nights booked in the last week | occupancy is a level; pickup is the derivative |
| **Lead time** | median days from booking to arrival | says whether an empty night is a problem *yet* |
| **Orphan nights** | gaps shorter than their minimum stay | unbookable at any price — the minimum is the lever |
| **Pace** | points vs portfolio median occupancy | the only benchmark available until comp data exists |

Two of these change decisions the most:

* **Lead time.** P2-4304 books 1.5 days out, so 33% occupancy thirty days
  ahead is normal for it. Discounting it gives away rate for nothing. The
  `books-late` signal says this explicitly rather than leaving it to be
  inferred.
* **Orphan nights.** A two-night gap under a three-night minimum cannot
  be booked at any price. Without this it sits in the "discount harder"
  pile forever while the discount does nothing, because price was never
  the blocker.

`signals()` turns these into sentences with the number attached — never
a mood, always a falsifiable claim. Every signal ships an icon and a
word; colour never carries the meaning alone.

**Market rate is deliberately an empty slot on the card**, labelled "not
connected". The comp set is the biggest missing input to any of these
decisions, and a visible hole says so; omitting the row would let the
card read as though the picture were complete.

## 19a. A signal that fires on half the portfolio is wallpaper

The first overpricing test was `ask > adr × 1.25`. It flagged **11 of 23
units**, which is not a finding, it is decoration.

The mistake was treating an absolute multiple as meaningful. Asking sits
above achieved ADR *everywhere*: the nights still on sale are the less
wanted ones, and length-of-stay discounts pull the achieved figure down
further. This portfolio's normal gap is **18%**.

It now calibrates against `portfolioAskRatio()` — the portfolio's own
median ask-to-ADR ratio — and flags a unit only when its gap runs well
above that. Four units flag, at 56% and up. It also self-calibrates per
host and per season instead of freezing one market's habits into a
constant.

The general rule, worth applying to every future signal: **check the
distribution on real data before shipping a threshold.** A test that
passes its unit test and fires on half the portfolio is still wrong.

## 19b. The verdict leads, the metrics support

A card printing seven equal-weight metrics makes the reader do the
diagnosis on every unit, every time — so it does not get done. `verdict()`
returns one headline and one sentence with the numbers in it; the metrics
sit underneath in a quiet line as the evidence.

Check order is most-actionable first, because a unit is often several of
these at once:

1. **Gaps too short to book** — the only one a price cannot fix
2. **Priced above what it earns** — the cause, named before the symptom
3. **Too early to tell** — lead time excusing a low number
4. **Not moving** — zero pickup with nights open
5. **Gone quiet** / **Effectively full** / **Filling**

## 20. Design notes

Money is formatted through `src/lib/format.ts`, pinned to `en-US`.
`toLocaleString()` with no locale follows the BROWSER: on a Spanish-locale
machine $66,819 rendered as "$66.819", which reads as sixty-six dollars.

The global `input, select, textarea { display: block; width: 100% }`
rule was making every inline control span the page and push its own
buttons onto the next line. Full width is now opt-in via `label > input`.

Screen grammar: **cards where a decision happens, compact tables where
one does not.** The groups that need action render as cards with the
occupancy bar, metrics and signals; "On track" and "Not taking bookings"
are dense rows.

The occupancy bar is drawn against the **portfolio median**, not against
100%, with a tick marking it — the comparison is the point. One axis,
one reference line, signed point difference in the label so the reader
does no arithmetic.

Status colours are the validated reference steps (`--good #0ca30c`,
`--warn #fab219`, `--crit #d03b3b`, `--series-1 #2a78d6`). Checked with
the dataviz validator against this app's dark surface `#191f27`:
contrast ≥3:1 and CVD separation ΔE 11.3 both pass. The lightness-band
flag on the warning yellow is the documented status-colour case, covered
by the icon+label pairing.

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


## 21. Gemini suggestions

`functions/_lib/gemini.ts`, key stored encrypted per account like the
Hostaway one, never returned to the browser. Structured JSON output
against a fixed schema — free text is where an unsourced claim hides.

The real risk is not bad prose, it is **an invented market**. Asked what
a unit should cost, a model will happily produce a confident comparable
rate for a town it has never seen, and that number would then be written
to a live calendar. So the prompt carries only figures measured from this
account, states plainly that there is no market data, and requires a
`missing` field — which makes the model say what it could not see instead
of papering over it. Output is bounded again on the way back: a rate above
3× the current ask is discarded rather than shown.

It never writes to Hostaway. Every suggestion is recorded in
`pricing_decisions` with `origin='agent'` and `push_status='none'`, so
when a human later moves that price, the advice sits beside what they
actually did and `alignment` becomes answerable rather than anecdotal.


## 22. Units is a list, not a wall of cards

Twenty-three expanded cards is a scroll, not a workspace. The screen is a
**traffic light per unit** — colour plus a three-word finding, scanned in
seconds — and **one row opens in place** with the metrics, calendar, open
stretches, Gemini's read and the price controls together.

Nothing modal. A dialog covers the very list the unit is being compared
against, which is the comparison the whole screen exists to support.

Colour never carries meaning alone: the dot is the scan, the word beside
it is the meaning.

## 23. Revenue breakdowns

`src/lib/breakdown.ts` — `byChannel()` and `byCategory()`, both running
the SAME window arithmetic as the headline figures
(`reservationContribution`, `prorateCosts`) rather than re-deriving
totals. A breakdown whose parts do not add up to the number above it is
worse than no breakdown.

Channel labels are grouped, and two mappings are not obvious:

* **`bookingengine` is Direct, not Booking.com.** It is Hostaway's own
  direct booking engine, and a substring test for "booking" claims it for
  the OTA — quietly moving commission-free revenue into the channel you
  pay 15% to. Direct is therefore tested first. A unit test pins this.
* **`customIcal` is "Blocked (iCal)".** Owner holds and cross-platform
  blocks: nights occupied, nothing earned. Listing them as a sales
  channel invites someone to read a $0 ADR as a pricing failure rather
  than a blocked calendar.

Live shape, 2026 YTD: Airbnb 63%, Direct 13%, Vrbo/Expedia 10%,
Partner 7%, Booking.com 6%.

Bars are scaled to the **largest slice**, not to 100%, so small rows stay
legible instead of collapsing to a sliver. Sorted largest first, because
the question is always which slice is biggest — a pie makes that harder
to answer, not easier.


## 24. Filters, and one vocabulary for the traffic light

`src/components/Filters.tsx` is shared by Units and Revenue. Three axes,
because they are three different questions: **status** (what needs me),
**location** (where), **search** (this one).

A red chip must mean "this needs me" on either screen or the filter stops
being trustworthy — so Revenue applies the same light to *money* that
Units applies to the calendar: `bad` at 25% or more under target, `warn`
under target, `ok` at or above. Filters are always visible; a hidden
filter still applied is the fastest way to make someone distrust a number.

Locations come from Hostaway's `city`/`state`. This account: Frisco TX
(25), Austin TX (1), Celina TX (1).

## 25. Local events, and the only outside input

`fetchLocalEvents()` is a **separate, grounded** Gemini call using
`google_search`. Separate because grounding and `responseSchema` do not
combine reliably, and the structured recommendation is the part that must
not degrade — so the search runs first and its prose becomes one more
input to the constrained call.

This is the **only** place the model may reach outside the supplied
figures, so it returns its sources and the UI shows them verbatim behind
a disclosure, with "verify before pricing against it". An event that does
not exist is exactly the kind of confident detail that would otherwise
justify a price rise.

It fails soft: no events must never mean no advice. But the error is
*reported*, because silently missing events look identical to "none
found", and those are different facts.

**`gemini-2.5-flash` is retired** — the API answers 404, "no longer
available to new users". Default is now `gemini-3.6-flash` (migration
007). A 429 means the key's free-tier quota is spent; both are turned
into sentences that say what to do rather than a raw error blob.

## 26. The advice runs on open

Expanding a unit fires the suggestion immediately, so by the time the
calendar has been read the answer is there. It runs **once per unit**,
deliberately not on date-range changes — that would fire a paid call on
every click in the calendar. "Re-run for these dates" is explicit.

## 27. No tagline, no modals

The header tagline restated a framing the owner had already lost an
argument about with his boss, and a slogan nobody reads is vertical space
on a screen whose job is a list. Removed.

The glossary renders **in place**, not as a dialog: a modal covers the
very table whose column you are trying to understand, making reading the
definition and applying it two separate trips. Same reason the price
workspace is inline.


## 28. Day / night, day by default

The theme is an **explicit `data-theme` attribute**, never
`prefers-color-scheme`. Day is the default by choice, and a media query
would silently override that for anyone on a dark OS — which is most
laptops. The attribute is set by an inline script in `index.html` before
first paint, so there is no flash and no state where the two could
disagree. `color-scheme` rides along so native date pickers, selects and
scrollbars follow; this app is mostly form controls, and a light date
picker on a dark panel is the giveaway that a theme was half done.

Stored in `localStorage` under `kaizen-theme`, wrapped in try/catch: a
blocked store must cost the preference, never the page.

### What the theme flip actually broke

**Warning amber.** `#fab219` is correct on the dark surface (9.49:1) and
**1.83:1 on white** — invisible for a 9px dot. Light mode uses `#b06a00`
at 4.28:1. It is the only status step that differs per theme.

**And darkening does not fix colourblindness.** Amber and green converge
under deuteranopia; every candidate tested scored ΔE 2–5 against the
green, which is the well-known reason traffic lights are a poor
accessibility pattern. So the lights carry a **shape**: `● ok`,
`▲ warn`, `■ bad`, `○ off`. Colour reinforces, never carries.

**Two tokens were marginally short in day mode** and would have failed
quietly rather than visibly: `--muted` measured 4.26:1 on the page
background, and the link blue `#2a78d6` measured 4.42:1 on white — both
under 4.5 for small text. Now `#636e7c` (4.83) and `#2470cc` (4.92).

Every text and status pair in both themes is verified ≥ its bar. Re-check
with the contrast script pattern in the history if these tokens move.


## 29. Two gates, not one

`functions/api/_middleware.ts` guards every `/api` route. Endpoints still
call `identify()` themselves — deliberate duplication, so a route stays
safe if this file is ever moved.

What the middleware adds is the check nothing was doing: whether the
person Access vouched for is on **this account's** allow-list
(`accounts.allowed_emails`). The column had existed since migration 002
and was displayed in Settings, but was never enforced.

It did not matter while login was one-time-PIN, because the Access policy
named the individual addresses and the two agreed by construction. It
matters the moment Access points at a public identity provider: a Google
policy is written as a rule (`any @gmail.com`), which is one careless
edit from "anyone with a Google account". **Access decides whether you
reach the app; the allow-list decides whether you are one of ours.** Same
failure would otherwise take out both.

Rules that keep it usable:

* **Empty list = allow any authenticated caller.** Turning this on must
  not lock out the only person who could add themselves to it.
* **A database failure returns 503, never a pass.** An authz check whose
  failure mode is "allow" is not a check — the same lesson as the
  fail-open `identify()` in §13.
* Addresses are normalised on save and compared lower-cased, or a stored
  `Me@Gmail.com ` silently never matches and the list looks broken.
* The Settings form **refuses to save a list you are not on**, rather
  than explaining it afterwards.
* Scoped to `functions/api/`, not the functions root: a root middleware
  also intercepts static assets, and a 403 there serves a blank page
  instead of a sign-in.


## 30. Calendar: the band, and saying what the dates do

Three fixes from watching it in use:

**Selection is a continuous band**, rounded at its two ends, not a border
per cell. The default range covers the whole window, so a per-cell
outline made all thirty nights look individually picked and the range
impossible to read. The band is 3px and sits above the day pills, which
are drawn as an inset `::before` so the two can overlap.

**Open stretches moved ABOVE the calendar.** Sitting between the calendar
and the rate fields they read as part of the pricing form, when they are
a way of *choosing* the dates — the step before.

**An `Effect` line states what the selection does.** The calendar shows
which nights are picked; it cannot show what picking them changes, and
the two levers behave differently: a nightly rate touches exactly the
selected open nights, while a weekly or monthly discount is a
listing-wide setting the dates do not bound at all. That distinction was
previously only in the confirm step, which is too late to be steering the
choice.

Cells are 38px and the months are centred — a calendar pinned left under
full-width fields reads as debris rather than a control.

**An open row lifts out of the list.** It is a workspace, not the list
carrying on: a 2px ring, its own corners, a shadow, and a 4px bar in its
status colour down the left edge. The ring is an inset shadow rather than
a border so nothing reflows when a row opens and the list does not jump
under the cursor, and `.ulist` dropped `overflow: hidden` (which would
have clipped the lift) in favour of rounding the first and last rows.

Both lists are accordions — `open` holds a single id, so opening one
closes the other. The lift therefore never has to tile.

Dead `.modal*` CSS removed: every panel that once opened as a dialog now
renders in place.


## 31. "Active" was never actually checked

`fetchListings` decided a listing was active with:

```js
l.isActive !== false && l.status !== 'inactive' && l.listingStatus !== 'inactive'
```

**None of those three fields exist** on Hostaway's listing object. The
expression was always true, so every listing was active and the sync
reported "0 inactive" from the day it was written.

It surfaced when a **Draft/Archived** listing topped the "needs a
decision" list with $13,560 supposedly at stake. An archived listing
still returns a calendar full of *available* nights, so every downstream
test read it as a healthy unit sitting empty. Occupancy 0%, nothing
booked, 30 nights open — a perfect false alarm on something nobody can
book.

The field that carries this is **`specialStatus`**: `null` on a live
listing, `"archived"` on one taken down. Confirmed on this account:
exactly one listing has it, and that listing also has every channel
export `null` while the other 26 export to 1–5 channels.

Rules:

* Only **known** non-live values disqualify (`archived`, `draft`,
  `inactive`, `disabled`, `deleted`). An unrecognised status keeps the
  listing active and is carried to the UI as a label, so a new Hostaway
  value shows up as something to investigate rather than silently
  deleting a working unit from the portfolio and its target.
* `classify()` checks it **before the calendar**, since the calendar is
  exactly what makes an archived listing look healthy.
* Stored in `units.special_status` at sync time, so the portfolio target
  excludes it without a calendar sweep — the same shape as `parked`.

Live counts now: 27 listings, **22 active**, 1 archived, 4 parked. The
target moved from 27 × to 22 × the per-unit figure.

The general lesson is the same one as the composite-key sync bug: a
condition naming fields that do not exist typechecks perfectly and is
always true. Only comparing it against the real payload finds it.


## 32. Channels, public rating, and what Airbnb actually serves

Two different kinds of fact, reported as two:

**Publication is certain and free.** Hostaway's listing object carries
`airbnbExportStatus` + `airbnbListingUrl` (and the same pair for Vrbo,
Booking.com, Expedia, Google, Marriott). `exported` AND a URL is what
"bookable there" means — both, because Expedia and Google hand back a
generic city-search URL for listings they do not carry, so a URL alone
proves nothing.

Live: 23 of 27 on Airbnb. The four without are Charger Luxe (archived),
CL2211 and CL2349 (parked) — and **Kingsford Home**, which is not on
Airbnb while *Kingsford Duplicate* is. More evidence for the duplicate.

**As of 2026-09, Airbnb serves nothing readable.** Tested from the
sandbox AND reported from the deployed Cloudflare app: the direct request
returns a 3 kB shell or a soft 404, and the Jina reader returns 0–1 kB
with a key, across every engine it offers (`markdown`, `browser`,
`browser` + wait-for-selector, `html`). This is not a configuration
problem and no key fixes it.

The code tries on every load and will start working the moment that
changes. The message says so plainly rather than suggesting a key the
account already has — telling someone to add what they added reads as
"you did it wrong" for something outside their control. Nothing else on
a unit card depends on it.

**The DIRECT request
is the mechanism — the old Apps Script project read ratings straight from
the origin via `fetchRawHtml_` and never used a proxy. Jina is a
fallback, and optional.

Whether the direct read works depends entirely on the **egress**. From
the development sandbox, three listings tested returned Airbnb's soft
404: a 200 carrying a 3 kB shell, no rating, no price, no JSON-LD — with
full browser headers and no redirect, so the address is refused rather
than the headers being wrong. **Cloudflare's edge is a different egress
and was never tested from here**; the direct call is tried first on every
request rather than assumed dead.

`looksLikeListing()` checks the response IS the listing — length, soft
404, bot challenge, whether the room id appears — before anything is
extracted. A blank rating for "Airbnb refused us" and a blank rating for
"no reviews yet" must never look the same in a dashboard, and the message
now distinguishes which stage failed.

`src/lib/scrape.ts` is the extraction ladder, ported and tested: JSON-LD
→ embedded state JSON → meta tags. A model is never asked to read a
number a parser can find. Only specific key names are trusted — generic
ones like `score` match unrelated numbers and produce confident nonsense
— and a price outside a plausible band is treated as a different field,
because a wrong price is wrong by a factor, not a margin.

Readings land in `price_observations` only when something was actually
read; a table of nulls would bury the real series it exists to keep.


## 33. The expanded panel is two columns

Stacked, an opened unit ran to about two screens — so the calendar, the
control the whole panel exists for, sat below the fold behind numbers
that had already been read.

Now: the verdict spans the full width (the one thing to read first), then
**evidence left** (metrics, occupancy bar, channels and rating) and
**action right** (open stretches, calendar, effect line, rate controls,
Gemini). One column again below 1080px, where a 7×38px month grid cannot
sit beside anything.

`main` widened to 1340px to give those two columns room.

Opening a row **scrolls it to the top of the viewport** — near the bottom
of a list of twenty-three, the panel otherwise opens entirely below the
fold and the click looks like it did nothing. It only scrolls when the
row is not already comfortably in view: nudging the page under someone
who can already see it is worse than not scrolling.


## 34. Apps Script scrapes; Kaizen stores. Egress, not power

Apps Script reads Airbnb listing pages fine. This app cannot — and the
reason is not capability, it is **whose address the request leaves
from**. `UrlFetchApp` egresses from Google's ranges, which Airbnb serves.
Cloudflare Workers, a VPS and the Jina reader are all turned away, and no
key or engine setting changes that.

So the scraper stays where it works. `POST /api/observations` takes what
it read and writes it to `price_observations`; the unit card shows a live
read when one is possible and the **last stored reading, dated**, when it
is not — a rating read yesterday from somewhere that works beats a blank
read from here.

Details that matter:

* **Its own credential**, not a person's: a script has no browser to sign
  in with, and revoking it must never cost anyone their login. Generated
  server-side, shown once, stored encrypted.
* **Constant-time comparison.** A token checked with `===` leaks its
  length and prefix to anyone timing the responses, and this one guards
  writes.
* Listed **explicitly** in the middleware's exempt set, never
  prefix-matched — a prefix rule is one typo from exempting everything
  beneath it.
* Rows match **by unit name**, because a sheet says "CL1339" and has
  never heard of a Hostaway listing id. Unmatched names are returned,
  never guessed.
* An observation with no rating, rate or total is dropped: nulls would
  bury the series the table exists to keep.

**The guest quote is stored as BOTH a total and a nightly rate**, with
the window it belongs to. They are not interchangeable: the nightly
figure compares across units and dates, the total is what a guest
actually sees and carries the fees and tax. Deriving either from the
other needs the night count, which is the first thing to go missing.

The dashboard column `✅ Airbnb Live` holds the **stay total** —
`Agent.js` writes `Math.round(pd.total)` — so `Kaizen.gs` divides by
`Nights` before sending a nightly rate. This project has already made
that exact mistake once, when comp prices were 30-night totals read as
nightly: every comparison was out by a factor of thirty and looked
entirely reasonable. A row with no night count sends no rate at all.

The card shows the gap: *"We ask $175/night · a guest is quoted $247 —
41% more once fees and tax are added."* That difference is why a unit can
look competitive in Hostaway and expensive on Airbnb, and nothing else in
the app would surface it.

**One Cloudflare step is still needed.** Access sits in front of
everything, so an Apps Script POST is redirected to a login page before
it reaches the function. Add an Access application for the path
`/api/observations` with a **Bypass / Everyone** policy — the endpoint
authenticates itself with the token, which is the stronger check for a
machine client anyway.


## 35. Two analyses, and saying which is which

An open unit carries a rule-based read at the top and Gemini's at the
bottom, and they reach the same conclusion most of the time. Unattributed
that made the second read as padding, and left no way to tell which to
believe when they differed.

Both now carry a byline: **"Read from your booking data"** for the rules,
**✦ Gemini** for the model. Two words each, and the ambiguity is gone.

`agreement()` compares the two and labels it — **agrees with the read
above** or **differs from the read above**. It compares the DIRECTION of
the advice, not its wording: a model phrasing "hold" as three sentences
about lead time is still saying hold. The disagreement chip is the one
that gets colour, because it is the only case where the model is telling
you something the rules did not.

Never defaults to "agrees" when there is no advice yet — a corroboration
badge on a card where nothing has answered is worse than no badge. A
test pins that.

Metric labels were shortened (`Asking, open nights` → `Open ask`, `ADR
achieved` → `ADR`) because they were wrapping onto two lines and pushing
their own values out of alignment.


## 36. Four channel states, one warning

`src/lib/channels.ts`. Four different situations were sharing one blank
space and one long paragraph, and they call for different reactions:

| state | mark | means | needs doing |
|---|---|---|---|
| `unpublished` | ○ | never put there | nothing |
| `ok` | ● | current reading (live, or stored ≤3 days) | nothing |
| `stale` | ◐ | had readings, they stopped | probably nothing today |
| `blocked` | ⚠ | published and **never** read | someone must change something |

The distinction that matters is **stale vs blocked**. A platform having a
bad day and our integration not working look identical in a blank cell,
and only one of them clears by itself. "Never read anything" is the
integration; "read it last week, not since" is usually the feed pausing.

Only `blocked` gets the warning colour and the full paragraph. A triangle
shown every day for something transient is a triangle people learn to
skip — and then it is missing when it matters.

A stored reading ≤3 days old counts as **current**, not as a fallback:
when yesterday's figure is still the right answer, a live read failing is
not a problem worth reporting.

## 37. The rating does both

`/api/market` reads the last stored observation from the database AND
runs the live scrape on every call, then shows whichever it has, live
preferred. So the Apps Script push and the live read are not alternatives
— the live path stays wired and starts working the moment Airbnb stops
refusing us, without anything being switched over.


## 38. The ratings feed is a published CSV, not a POST

Apps Script writes a `🔁 Kaizen Feed` tab twice a day (6am and 6pm) and
publishes it as CSV; `/api/forward` imports it on the first screen load
after each run. Chosen over the POST route because **nothing inbound
means no Cloudflare Access bypass and no token to rotate** — and unlike a
POST body, the sheet is something a person can open when a number looks
wrong. Same mechanism as the cleanings import, which is the one
integration here that worked first try.

`pushRatingsToKaizen()` and `/api/observations` are kept. They are
immediate rather than polled, and cost nothing to leave in place.

**Idempotence is the whole design.** `price_observations` is append-only,
which is right for a reading taken once and wrong for a feed that is
re-read every few hours. Each row carries a `feed_key` of
`unit | window_start | read_at` under a unique index, so re-importing an
unchanged sheet writes nothing. Verified against the live database: first
pass 3 rows, second pass 0.

Twice a day, not hourly: a rating moves over weeks and a thirty-day price
over days, and every run spends the one scraping path that still works.

The import is guarded by a 6-hour staleness check and wrapped in a
try/catch — a page load never pays for an import that would change
nothing, and a feed that is down must cost the ratings, never the
dashboard.

The sheet publishes the stay **total**, labelled as one, and the importer
divides by `Nights`. One place owns that division. This project once read
30-night totals as nightly rates and every comparison was out by a factor
of thirty while looking entirely reasonable.


## 39. Platforms are rows, not columns

`listing_platforms`, keyed `(account_id, unit_id, platform)`. A table
rather than `booking_rating`, `vrbo_rating`, … on another table, so
adding Marriott or a direct portal later is a row instead of a migration
on both sides.

It holds **current state, not a series** — a rating moves over weeks, and
the series already lives in `price_observations`.

**Everything is stored on a 5-point scale.** Booking.com and Expedia
print out of 10; stored raw, an 8.6 sits beside an Airbnb 4.8 in the same
column and reads as the better property. `toFive()` converts once, on the
way in, and **trusts the number over the declared scale** when they
disagree: a 9.2 in a column labelled /5 is a ten-point score in the wrong
column, and halving it keeps a real reading where rejecting it loses one.

Three states, not two: `listed` is **nullable**, because unknown is not
the same as "we checked and it is not there".

Blank feed columns **leave the row alone** rather than overwriting with
null — the sheet not carrying Booking yet must not erase a Booking rating
that arrived some other way.

The feed carries columns for every platform whether or not its scraping
works. An empty column can be filled by hand tomorrow; a missing one
needs a change on both sides first. Blank reads as "not collected",
never as zero.

Verified against the live database: Airbnb 4.87 stays 4.87, Booking 8.6
stores as 4.30, Expedia 9.2 as 4.60, a URL-only platform records as
listed with no rating, and empty ones are untouched.


## 40. Hostaway's rating is never used

Not "incomplete" — **wrong about which property it describes.**

Listings get **recycled** in this portfolio: an id is reused for a
different unit, and Hostaway carries the review count across that reuse.
It also reports reviews that are not visible on the platform at all. An
average that folds it in is therefore confidently wrong, and no amount of
it being "extra data" repairs that.

Ratings come from scraping the live page or they do not come. The feed
importer refuses any column matching `/hostaway|internal/i`, and
`Kaizen.gs` does not put one in the sheet.

Consequence for the UI: a platform reads as confirmed (● and a number)
**only when a rating has actually been scraped**. Publication and rating
are printed as two separate facts — "listed · rating not scraped yet" —
because Hostaway is trustworthy about the first and not about the second,
and one dot cannot honestly carry both.

**Google is dropped** from channels and from the feed. Hostaway exports
to Google Vacation Rentals and reports a URL, but nobody here manages or
prices against that listing, so the row could never be acted on.

Platforms carried: Airbnb, Booking, VRBO, Expedia, Web Portal.


## 41. The 30-night quote, and what it is NOT comparable to

`findNextStay_` in the Apps Script project finds the **first consecutive
run of free nights of at least `STAY_NIGHTS` (30)** inside a 150-day
horizon, and the dashboard prices exactly that window:

| column | is |
|---|---|
| `Check-in` / `Check-out` | the next bookable 30-night stretch |
| `Nights` | 30 |
| `Per Night` | Hostaway's own average over those nights |
| `✅ Airbnb Live` | the guest-facing **total** for that same window |

So the feed's price is the next possible 30-day booking, which is the
question that was asked.

**Hostaway's price is shown, never used as the baseline.** It is biased
the same way its rating is: listings are recycled, and the calendar price
is what we *pushed*, not what a channel ended up displaying. Deriving a
"% above our rate" from it dressed the unreliable number up as the
reference and the scraped one as the deviation — backwards. The scraped
Airbnb price is what a guest actually pays; Hostaway's is labelled as its
own calendar figure and left as context.

**The trap: a nightly figure derived from a 30-night total is not
comparable to a weekend rate.** Airbnb applies the monthly discount
inside that total, so the per-night number already has it baked in. The
card therefore never prints the nightly figure without the stay it came
from — "for the next bookable 30-night stay, from …".

The gap line was wrong and is fixed. It said the difference was "fees and
tax"; on a 30-night quote it is fees and tax **minus** the length-of-stay
discount, and calling it fees alone overstates them by exactly the
discount. Both sides of the comparison are averages over the same stay,
so the figure is meaningful — it just is not only fees.


## 42. The wait has a number on it

A bare "Loading…" says the same thing at three seconds and at thirty.
`src/components/Loading.tsx` shows a percentage, a stage, and a bar.

**The percentage is not invented.** It is measured against how long this
exact call took last time — the API already reports `tookMs`, and the
browser records its own wall-clock figure in `localStorage`, averaged
0.6/0.4 with the previous reading so one slow call does not make every
later bar crawl.

Two rules, both pinned by tests:

* **It never reaches 100% on its own.** Completion is the response
  landing, not a timer expiring. A bar that hits 100% and then waits has
  told the reader something false.
* **It never stalls at a wall.** `1 - e^(-1.6t/est)` reaches ~80% at the
  expected duration and keeps creeping: 88% at 12s, 93% at 15s, 97% at
  20s on a 9s estimate. An overrun looks like a slow finish, which is
  what it is, rather than like a hang. Past 1.6× the estimate it says so
  outright — "Taking longer than usual — 14s so far" — because slower
  than usual is information and a frozen bar is just alarming.

Stages advance **with the bar**, not on their own timer, so the label can
never describe a step the bar has already passed.


## 43. Outcomes close themselves, with no UI

`functions/_lib/outcomes.ts`, run by `/api/cron`. Twelve decisions sat
`pending` forever: a pile of intentions with nothing saying whether any
of it happened. "Record for training" only becomes training when the
outcome is attached, and the outcome can only be read later — which is
exactly why nothing had read it.

A decision resolves as `booked` when every night it was aimed at has
sold, `expired empty` when its window passed, `no open gap` when there
was never a gap to fill. A calendar that cannot be read leaves it
pending: an unreadable calendar is not a decision that failed.

It says what happened, never why. Nothing here can show causation, and
whether the advice was worth following is a question answered by many
rows, not one.

## 44. Alerts: on the change, never on the state

`src/lib/alerts.ts` (pure, tested) and `/api/cron`.

**The rule that decides everything:** a condition that has just begun is
news, one that has just ended is news, one that is simply still true is
**silence**. "Still 0%, tenth straight day" is true, useless, and trains
people to mute the channel — so that when the message that mattered
arrives, it arrives to an audience that stopped reading.

`alert_state` holds one row per `(unit, kind)` with what we last
announced. Resolved rows are **kept**, which is what stops a unit
hovering at the line re-announcing itself every run.

State moves whether or not the send succeeded. A failed send must not
re-announce the same condition on every pass; the failure sits in
`alert_log` where it can be seen.

**A listing is red** when its verdict is overpriced, stuck or unbookable
AND at least $2,000 is still winnable. The exposure floor is what keeps
this an alert rather than a digest — twenty-three units under an
occupancy floor is a dashboard. `early` is explicitly never red: a unit
that books three days out is not in trouble for being empty in week
four, and alerting on it is how a channel earns its mute.

## 45. QUO is staged until somebody decides otherwise

`quo_live` defaults false. The whole path runs — recipients normalised to
E.164, body folded to GSM-7, segments counted, a row written saying what
*would* have gone — and the request is simply not made. It is the only
way to find a three-segment message or an unparseable number without a
phone proving it.

`src/lib/sms.ts` is pure and tested, and exists for one reason: **a
single curly quote drops the segment size from 160 characters to 70 and
triples the bill.** So characters are FOLDED, never stripped — deleting
an em dash runs two sentences together and changes what the message says.

Emoji are matched as **surrogate pairs**. A range like
`[\u1F300-\u1FAFF]` parses as `\u1F30` followed by `0-\u1FAF` and eats
ordinary letters; this project shipped that bug once.

Segment counting accounts for the concatenation header — 153 per part,
not 160 — which is right only when the message is one character over,
which is exactly when someone is relying on it.


## 46. Claims are the only CRUD here, and that is deliberate

Every money table is append-only: an expense happened once, and a
correction is a new row. A **claim is a CASE** — raised, investigated,
refunded, closed — and a table you could only append to would make
"update the status" mean "file it twice".

What never changes is `occurred_on`: when the guest raised it, never when
someone got round to it. Filing a July complaint in September moves it
into the wrong month and quietly flatters July.

**Open cases sort first regardless of age.** A three-month-old open claim
is precisely the one that needs attention, and sorting by date alone
buries it under yesterday's resolved ones. The headline figures are
open count, **weighted severity (1/2/4/8)** — a plain count ranks five
slow-wifi complaints above three midnight lockouts — days the oldest open
case has been waiting, and cost to date.

Closing a claim fills the resolution date rather than leaving it to
whoever remembers; re-opening clears it, so a claim never carries a
resolution date while it is open.

## 47. Units is the first tab

It is where the decisions are made, and the tab that opens is the one
people treat as the product.

The Revenue unit list also gained column labels: it was four money
figures in a row with nothing saying which was which.


## 48. Two clocks, and the trap of sharing one

Ratings now refresh **daily**, prices **three times a day**. The Apps
Script project runs `kaizenScheduledRun` at 6am, 1pm and 8pm: scrape,
then publish the feed. In that order — a feed built from a dashboard
nobody refreshed sends yesterday's numbers with today's timestamp, which
is worse than sending nothing because the far side cannot tell.

**Changing the intervals alone would have made ratings worse.**
`planWork_` computed both ages from `🕑 Last Checked`, which is rewritten
on *every* pass. With an 8-hour price clock and a 24-hour rating clock,
the price pass resets the stamp before the rating clock can ever expire:

```
06:00  both due → rating + price → stamp 06:00
14:00  age 8h   → price only     → stamp 14:00
22:00  age 8h   → price only     → stamp 22:00
        the rating clock never reaches 24 again
```

Ratings would have stopped refreshing entirely once every unit had one.
The old 720-hour default hid it, because 30 days outran the resets.

Fixed with a separate `🕑 Rating Checked` column, stamped **only when a
rating fetch was actually attempted** — stamping it on a price-only pass
would restart the clock without having looked, which is the same bug
wearing a different column. A column that does not exist yet reads as
"never checked", which asks for a fetch: the safe direction.

The old default was justified as "ratings barely move". True for a unit
with 200 reviews; on one with 5, a single new review visibly shifts the
average.

On the Kaizen OS side, the staleness threshold dropped from 3 days to 2.
Three days was chosen for prices, and a month-old rating sat inside it
looking current.


## 49. Roles: two levels, enforced in the middleware

**admin** — everything. **ops** — expenses and claims, nothing else.

Called `admin`, not `owner`: the role is administrative access to the
app, and "owner" reads as ownership of the business, which it is not.

**Hiding a tab is not access control.** Every screen is an endpoint
reachable with a URL and a valid session, so `functions/_lib/roles.ts`
is checked in `functions/api/_middleware.ts` on every request. The tab
list the browser draws comes from the same module via `/api/settings`,
so the two cannot drift — a tab that answers 403 reads as the app being
broken rather than as a permission.

**`mayAccess` is an allow-list, deliberately.** With a deny-list, a route
added next month would be reachable by everyone until somebody
remembered to add it. This way a new route is closed until it is opened.

`/api/settings` returns **nothing** to an ops member beyond their
identity and their tabs: no credential flags, no allow-list, no targets.
None of it is actionable by them, and all of it describes the business
rather than their job.

Lock-out guards, the same shape as before:

* **No member row means admin.** Roles arrived after people did, and a
  migration must not quietly take access away. The allow-list still
  decides whether they get in at all.
* Everyone on the old `allowed_emails` was migrated **as an admin** —
  they had full access a moment earlier.
* Saving a list **with no admin is refused**, not explained afterwards:
  it would leave an account nobody can administer and no screen left to
  fix it.
* The form refuses to save a list that **demotes the person saving it**.
* Adding a member also adds them to the allow-list. A role with no way
  in is a role nobody can use, and two separate chores is how someone
  ends up locked out.


## 50. An archived listing still earned the money it earned

Three different questions, and they had been collapsed into one:

| Question | Who counts |
|---|---|
| **What did we earn?** | every listing, archived and parked included |
| **Who shares this month's bill?** | units live now |
| **What is the target?** | active AND not parked — 22 |

`Revenue` built its dataset from `listings.filter(l => l.active)`. Once
`active` learned about `specialStatus`, the archived listing dropped out
of the dataset entirely — **$91,672 across 68 real reservations, from
January 2025 to August 2026, vanished from every total it belonged in**,
including its own row. 2026 YTD alone was understated by $33,025.

`Dataset.sharedAmong` now separates the second question from the first. A
unit archived last month did not consume this month's internet, and
giving it a share moves cost off the units that did — so revenue counts
everyone and shared costs divide among the live.

The row is labelled `archived` and its light is `off`: an archived unit
cannot chase a target, so it is not judged against one. Its money still
counts; it is simply not a decision.

The general shape of the mistake is worth remembering: **a flag that
answers one question gets reused for a second one it was never about.**
`active` was built to mean "can this take a booking today" and was
standing in for "did this ever exist".


## 51. The primary owner had to be reachable

`is_primary` only ever PRESERVED an existing primary:
`primary ? m.email === primary.email : false`. With an empty members
table — which is what a fresh account has, since `allowed_emails` was
empty and migration 015 had nobody to migrate — nobody could ever become
primary. The protection existed and was unreachable.

Bootstrapped: with no primary yet, the **admin performing the save
becomes it**. The person setting the account up is the one administering
it, and the role can be transferred afterwards.

Worth noting the shape, because it is the third time in this project: a
rule written only for the steady state, with no path into it. The
allow-list had the same gap (empty means allow-all, or nobody could add
themselves) and it was solved the same way — by asking what happens on
the very first run.


## 52. Nothing renders before the role is known

The tab bar drew every tab while `/api/settings` was still in flight, so
an ops account saw Units and Revenue for a moment before they vanished.
A tab that appears and then disappears has already told the reader it
exists.

The flash was the visible half. The rest: `tab` defaulted to `'units'`,
so that screen **mounted for everyone** and fired `/api/forward`, which
answers 403 for ops. The middleware refused it correctly — the request
should never have been made.

Now `tab` starts `null` and the nav renders from `allowed`, which is
`null` until the server answers. Nothing is drawn that might then vanish.

And the failure path **falls back to the narrow set**, not the wide one.
If the role cannot be read, showing every tab would reveal exactly what
the role exists to hide; a wrong guess in the other direction costs an
admin one reload. When a permission check fails, it fails closed — the
same rule as the auth helper and the allow-list.

The "Sync listings" banner is also gated on having a Settings tab: it
told ops accounts to open a screen they cannot reach.


## 53. Cleanings: a cost, with a scope you choose

Lives under **Costs** as a third sub-tab, beside the monthly lines and
the one-offs. It is a cost; a tab of its own implied it was a separate
kind of thing.

The sheet is a forward log — **14 of its 24 rows are cleans that have not
happened**. Three scopes, never blended:

| scope | is | for |
|---|---|---|
| `done` (default) | past and today | what cleaning **cost** |
| `scheduled` | after today | what is **committed** — projections |
| `all` | both | the full commitment |

The default is `done` because it is the only one that is a fact. The
headline label changes with the scope — **"Paid out" / "Committed" /
"Paid + committed"** — because the number means something different.
Calling committed work "paid out" would be the whole mistake in one word.

The cut is in the SQL, so the totals and the rows beneath them come from
one query and cannot disagree. Each view says what it is **not** showing,
with a link across, so a filtered table never reads as an empty one.

**A blank price is "not priced", never zero.** Rows without a figure
("Not needed", "TBD") are counted as cleans and left out of the money —
4 of the 10 current rows. Treating them as zero would report the period
as cheaper than it was, and the screen says how many are missing.

Read-only, deliberately. The sheet is where this is maintained, daily, by
the people doing the work; a second place to edit it would be a second
version of the truth. Rows are upserted on the reservation id, so
re-reading corrects a clean rather than duplicating it — a price filled
in later updates the row.

Ops can see this tab: it is their own work, and the money in it is cost
data they already record.


## 54. An empty string is not "no filter" for a date column

`AND (${from} = '' OR checkout_on >= ${from})` failed the whole query
with `invalid input syntax for type date: ""`. Postgres coerces the
parameter to DATE because of the comparison against `checkout_on`, and
it does that **before** the OR can short-circuit. The guard that was
supposed to make the filter optional is what broke it.

A filter meaning "no filter" has to be **absent**, not blank:
`${from}::date IS NULL OR checkout_on >= ${from}::date`, with `null`
passed rather than `''`.

The same pattern is in `/api/pricing` and the cleanings import — worth
checking any query where an optional parameter is compared against a
typed column.

## 55. A failed load must not look like a demotion

§52 made the tab list fail closed to the ops set. Correct as a security
choice, wrong as a message: an admin whose `/api/settings` call failed
lost Units, Revenue and Settings with no explanation, which reads as
*"someone changed my access"* rather than *"the request failed"*.

It still fails closed — **no** tabs are drawn, which is narrower than the
ops set — but it says so, and says it is a load failure rather than a
permission change. Failing closed and failing silently are different
decisions, and only the first one was intended.


## 56. The cleanings sheet refreshes itself

Read on the way into `/api/cleaning-log` when the last import is more
than three hours old. The sheet is edited daily by the people doing the
work, so anything older is behind — and asking someone to remember to
press *Pull* is how a screen ends up quietly showing last week.

Guarded by age, so opening the tab twice costs one fetch, and wrapped, so
a sheet that is down costs the refresh and never the view. The button
stays for the first pull and for "it should have updated by now".

`functions/_lib/cleanings-import.ts` is the single implementation, used
by the manual endpoint and the automatic path. Two implementations of an
import is two sets of rules about what a blank price means, and they
drift.

Verified against the live sheet: 24 rows, 24 logged, 10 units rated, no
unmatched names — and a second pass logs 24 with 24 still in the table,
so re-reading corrects rather than duplicates.

**Ops can see it.** It is their own work, the money in it is cost data
they already record, and it sits inside Costs which they already have.


## 57. "Not needed" is not a cleaner, and the notes are not about cleaning

Two readings of that sheet were wrong.

**The cleaner column carries two different things**: who is doing it, and
that nobody is. `🚫 Not needed` and `❓ TBD` were appearing in the
by-cleaner breakdown as though they were people, and both counted as
cleans. `readAssignment()` now splits them into `assigned` / `tbd` /
`not_needed`, matching **on the words, not the emoji** — the emoji is
decoration somebody may drop, and a match depending on it would silently
stop working the day they did.

The three are not interchangeable: `tbd` is work that will happen with no
name on it yet, `not_needed` is work that will not happen.

**A stay that needed no clean is not a clean.** On the live sheet that is
3 of 10 in the current window — the headline said 10 and should say 7,
and the average cost per clean was understated by 30%. They are held out
of every figure and reported on their own line.

**The Notes column is about the RESERVATION** — "reservation cancelled",
"unpaid extension", "guest extending" — not remarks on the work. Renamed
`reservation_note` so nothing reads it as a comment on the cleaning.

Filter by cleaner is on the server, and the list offered contains **real
cleaners only**: Michelle 7, Karina and Marvin 5, Veronica 3.


## 58. A calendar, for reconciling invoices

Cleanings has a **Calendar** view beside the list. It exists for one job:
a cleaner sends a total for September and the question is which days that
covers and whether the count matches. A list sorted by date can be
counted by hand; a calendar is checked at a glance, and **a missing
Tuesday is a hole rather than an absence you have to notice**.

Three decisions follow from that job:

* It asks for **one closed month**. A window open at either end cannot be
  reconciled against an invoice that covers exactly one.
* It **ignores the done/scheduled scope**. A September invoice includes
  cleans after today if today is in September.
* **"No clean needed" is excluded from the total** and shown on the day
  anyway. It is not on the invoice, so it must not be in the figure being
  checked against one — but it explains a gap instead of leaving one
  unexplained.

Monday-first, because a cleaning week is a working week and Sunday in the
first column splits it across two rows.

Live, with the cleaner filter: Michelle 7 cleans $290, Karina and Marvin
5 cleans $545, Veronica 3 cleans $600 — September total $1,435 over 21
cleans plus 3 that needed none.

**Still open:** the owner wants to restructure the sheet itself (the
notes column mixes reservation remarks with cleaning, and the cleaner
column carries statuses). He has the Apps Script project id for it. Ask
before changing that sheet — his team edits it daily.


## 59. The WhatsApp chats are two different records, not one

`scripts/whatsapp-cleanings.mjs` reads the crew chat exports. 3,741
messages, of which **11,495 of 16,600 lines were `<Multimedia omitido>`** —
69% of the file is stripped photos.

**The invoices and the chatter answer different questions and are not
interchangeable.** The weekly invoices carry unit + price together and are
the only authority on cost, but being weekly they never say which day. The
chatter carries unit + date — "Napa ready", a photo batch captioned
"2349" — and is the only authority on when. So the script builds a rate
card from the invoices and applies it to the dated events, and every row
says which of the two it came from.

**Rates are keyed by unit AND cleaner.** CL1250 is $35 from one crew and
$70 from the other; a rate not tied to a vendor is the midpoint of two real
prices and equals neither. This is why the sheet and the chat disagreed on
6 of 9 overlapping units — they are quoting different vendors.

**All 113 invoice line items are Karina & Marvin.** Michelle never invoices
in these chats, so her 27 dated cleanings come out with an empty price —
her rates live in the Google Sheet. An empty cell, not a borrowed one.

Evidence is ranked, never merged: `ready` (the crew said so) > `photos` (a
bare unit name captioning a finished batch) > `scheduled` (the office named
the day's work — dated, but a plan). Only crew messages count as `ready`,
because the office writes "is 2462 ready?", which is a question.

Two invoice lines read `2472` and `2482` at $110 — no such units, and $110
is CL2462's exact rate. Flagged as probable typos in `unresolved.txt` with
the suggestion; **not** silently rewritten.


## 60. A new column with a default does not fix the rows already there

Migration 019 added `assignment` with `DEFAULT 'assigned'` and stopped. A
default describes rows written **after** it — the 24 rows already in
`cleanings` kept their raw text and were labelled as though a person had
done them, so "TBD" and "Not needed" went on appearing in the by-cleaner
filter as if they were people. The importer was fixed; the data was not.

Migration 020 re-reads them, on the words rather than the emoji, same as
`readAssignment`. **Adding a column and backfilling it are two jobs, and
only doing the first means the fix applies to data nobody has imported
yet.**

## 61. Cleanings: free dates, and several cleaners at once

**Dates.** The presets are shortcuts that write the same `from`/`to` the
custom pickers do, and the table only ever reads those two. A preset that
took a different path from a typed date would eventually disagree with it.
Typing a date clears the preset rather than fighting it.

**Cleaners are multi-select.** "Michelle and Veronica" was impossible to
ask with a single-value filter. `Everyone` is the *empty* selection rather
than a chip of its own, so there is one state and not two that can
disagree about who is showing. Verified: Michelle 7 + Veronica 3 = 10
together, $290 + $600 = $890.

**Unassigned and "no clean needed" are OFF by default.** They are states,
not people, and a default view that folds them in answers "who cleaned
what" with rows where the answer is nobody. They sit apart from the
cleaner chips and are one click away, never silently included — and their
counts are taken over the whole table, so a chip that is switched off can
still say how much it is holding back.

Live: 15 rows by default, 21 with Unassigned, 18 with No-clean-needed, 24
with both — which is the whole table.

The scheduled scope still drops the dates rather than inverting them —
work ahead of today cannot be in a backward window.


## 62. The cleanings tab was slow because of one row at a time

`importCleanings` wrote **one INSERT per clean**, awaited in sequence. At
24 rows nobody noticed; the sheet is now **202**, so that is 202 HTTP round
trips to Postgres and **25 seconds**, paid in full by whoever happens to
open the tab when the three-hour cache expires.

Rewritten as a single `INSERT … SELECT FROM unnest(...)` with one array per
column, and the per-unit rate updates as a single `UPDATE … FROM unnest`.
**25,000 ms → 1,444 ms**, and most of what is left is fetching the CSV.

The endpoint's four independent queries now run together rather than one
after another: **923 ms → 335 ms**. The database never cared in which
order it answered them.

**The visible symptom was not slowness, it was wrongness.** With no
loading state the old rows stayed on screen, so a filter chip reading
"Michelle" sat above a table still showing everyone — which looks exactly
like a broken filter. In flight the panel now dims and says so, and
pointer events are off so a second click cannot race the first.

The reservation-note column is gone from the table; it was about the
booking, never the cleaning.

`cleanings_sheet_url` holds the editing link, separately from the
published-CSV link the importer reads — one is a page a person opens, the
other is a file download, and the button has to go where the work is done.
