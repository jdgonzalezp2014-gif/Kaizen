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

**The rating and the quoted price are best-effort, and currently blocked.**
Measured, not assumed:

* a plain request returns a **3 kB JavaScript shell** — no rating, no
  price, no JSON-LD
* through a datacenter IP the room URL **redirects to Airbnb's home
  page**: a 200 with the wrong document, which parses cleanly to nothing

So `looksLikeListing()` checks the response IS the listing — length, soft
404, bot challenge, and whether the room id even appears — before
anything is extracted. A blank rating for "Airbnb blocked us" and a blank
rating for "no reviews yet" must never look the same in a dashboard.

Without a key the current result is: *"Airbnb served a bot challenge
instead of the listing."* A **Jina reader key** (Settings) is what the
old Apps Script project used and what this needs.

`src/lib/scrape.ts` is the extraction ladder, ported and tested: JSON-LD
→ embedded state JSON → meta tags. A model is never asked to read a
number a parser can find. Only specific key names are trusted — generic
ones like `score` match unrelated numbers and produce confident nonsense
— and a price outside a plausible band is treated as a different field,
because a wrong price is wrong by a factor, not a margin.

Readings land in `price_observations` only when something was actually
read; a table of nulls would bury the real series it exists to keep.
