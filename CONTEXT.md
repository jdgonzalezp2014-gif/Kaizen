# Kaizen OS — session context

**Read this first. It is the single source of truth for how this project is built and why.**
It exists so a new session does not have to re-read the code, re-derive the architecture, or
re-litigate decisions already made. Update it when a decision changes; do not let it drift.

---

## 1. What this is

A short-term-rental management web app for Kaizen Guest Properties — ~27 units, currently run
out of Hostaway plus a Google Sheet. It measures **profit per unit**, not occupancy, surfaces
which units are mispriced, tracks costs and claims, and sends alerts by SMS.

It replaces a daily manual Hostaway check.

## 2. Hard constraints — these decide everything else

| Constraint | Consequence |
|---|---|
| **$0 running cost.** The client will not pay for infrastructure and payment for the build itself is not guaranteed. | No paid database, no paid host, no paid queue. Every piece must have a free tier that does not expire. |
| **No server to operate.** | No always-on process. Scheduled work runs on Google's infrastructure, not ours. |
| **The developer keeps control.** | Repo lives in the developer's GitHub account. Credentials are never committed. Handover is a transfer, not a discovery. |
| **A working system already exists** (`../price-monitor`, Google Apps Script) | Do not rewrite what already works against the live Hostaway account. Wrap it. |

The client's own spec (`docs/kaizen-os-spec.pdf`) proposes Supabase + Vercel + Twilio + Neon.
That is a good spec for a funded build. It is not this build. See §4.

## 2a. Scope — what this app is and is not

**It is an analytical surface with two data-entry paths.** Nothing else, for now.

| In scope | Notes |
|---|---|
| Profit per unit, per period | The headline. Every screen ends in a net number |
| **Charts over time** | Net, revenue and occupancy by day/week/month — see §2c |
| **Dynamic date ranges** | Drag or preset; everything redraws instantly, client-side |
| Portfolio scoreboard vs target | Target is **derived**, never hardcoded — see §2b |
| Forward pace, occupancy, peer pricing position | Diagnosis for the profit number |
| **Expense entry by the team** | Fixed and variable. Multiple people, not just the owner |
| **Claim entry by the team** | Guest claims with severity and cost |

| Out of scope for now | Why |
|---|---|
| Outbound CRM | A product on its own |
| Review dispute tracker | Needs per-platform review APIs we do not have |
| Channel live/dark probing | Costly; the panel already flags unexported listings |
| Agentic sending of anything | Agents draft. Humans send. Always |

**Later, explicitly wanted:** expense import from **Walmart and Amazon invoices**. Design the
expense schema so a row can carry a source and an external reference now, so that import is a
new writer against an unchanged table rather than a migration.

## 2b. Units and targets are variables, never constants

The client's PDF prints *"22 live units × $1,500/mo = $33,000"*. Do not hardcode any of those
three numbers.

- **Units go on and off.** Some are currently inactive. The live count is derived at read time
  from `📊 Dashboard` (an inactive unit shows `⚪` in its vacancy column) — never counted by hand,
  never stored.
- **The per-unit target is config** (`TARGET_NET_PER_UNIT`), editable without a deploy.
- **The portfolio target is computed**: `active units × per-unit target`. It moves when a unit is
  taken offline, which is the correct behaviour — a portfolio of 20 should not be measured
  against a target set for 27.
- **Revenue is likewise never a constant.** It is always read for a stated period from the
  reservation ledger.

Any screen showing a target states the unit count it was computed from, so a number that moved
because a unit went dark is legible as exactly that rather than looking like a data error.

## 2c. Graphs and dynamic ranges — where the arithmetic lives

The app must let anyone drag a date range and see profit, revenue and occupancy redraw
immediately, with charts over time. That forces one decision, and it is the most consequential
one in the project.

**The API serves raw, period-free rows. The client does the proration.**

The alternative — asking Apps Script to compute each requested range — cannot work. A Web App
round trip is 1–3 seconds, a chart needs 30–90 buckets at once, and a dragged range would fire a
request per frame. Serving `🧾 Reservations` and `💸 Costs` as they are and slicing them in the
browser makes any range instant and any chart free.

**The cost of that decision, stated plainly:** the proration arithmetic now exists twice — in
`apps-script/Finance.js` for the sheet views, and in `apps/web/src/lib/finance.ts` for the app.
Two implementations of "what did this unit earn" is two answers, which is exactly the thing this
project refuses everywhere else.

It is accepted here for one reason, and defended one way:

- **Accepted** because the browser genuinely cannot ask the server 90 times, and the alternative
  (an intermediate server that pre-computes) costs money we do not have.
- **Defended** by `finance.test.ts`, which pins the TypeScript against worked examples taken
  from the Apps Script behaviour — a straddling stay, a monthly lease spanning a boundary, a
  general cost split across units, a $0-payout iCal block. If the two drift, a test fails rather
  than a number quietly changing.

Anything not on that list should be computed **once, server-side**, and served. Do not port
more logic across than the charts actually need.

**Range presets** live in one place (`ranges.ts`) and are shared by every screen: MTD, Last 30,
Last 90, QTD, YTD, Last month, Custom. Bucket granularity is chosen from the span rather than
picked by the user — up to ~31 days daily, up to ~120 weekly, beyond that monthly — because a
two-year daily chart is 730 unreadable bars and nobody wants to choose.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  GOOGLE (free, already working, already authenticated)      │
│                                                             │
│   Hostaway API ──► Apps Script ──► Google Sheets            │
│                    · time triggers (cron)   (the database)  │
│                    · Airbnb scraping                        │
│                    · profit / proration                     │
│                    · QUO (OpenPhone) SMS alerts             │
│                         │                                   │
│                         └──► doGet() Web App = JSON API     │
└─────────────────────────────┬───────────────────────────────┘
                              │  HTTPS, Google-account gated
┌─────────────────────────────▼───────────────────────────────┐
│  VERCEL (free static hosting + SSL)                         │
│                                                             │
│   React + TypeScript + Vite  ── read-only dashboards        │
│   Google Identity Services   ── sign-in, email allowlist    │
└─────────────────────────────────────────────────────────────┘
```

**Google Sheets is the database.** Not a compromise to apologise for: the data is a few thousand
rows, the client already lives in Sheets, non-technical staff must be able to edit costs and
claims by hand, and it costs nothing forever.

**Apps Script is the backend.** It already holds the Hostaway credentials, already runs on a
timer, already scrapes Airbnb, and already sends SMS. Deploying it additionally as a Web App
turns it into a free JSON API with zero new infrastructure.

**The web app is static.** It builds to HTML/JS/CSS and is served from a CDN. There is no server
to pay for, patch, or restart.

## 4. Why not the client's stack

Say this plainly if asked; do not be defensive about it.

| Their choice | What we do | Why |
|---|---|---|
| Neon (Postgres) | Google Sheets | ~3k rows. Staff must hand-edit costs and claims. Postgres would need an admin UI built on top of it just to match what Sheets does for free. |
| Vercel / Render | **Vercel**, static only | Agreed — free tier, zero config for a Vite build, and the developer already knows it. What we do *not* use is its serverless functions or cron: those exist on Apps Script already, credentialed. |
| Vercel cron | Apps Script triggers | Already built, already running, free, and it already has the Hostaway credentials. |
| Twilio / WhatsApp | QUO (OpenPhone) | Already integrated and paid for by the client. Character handling is already written and tested. |
| Resend | Apps Script `MailApp` | Free quota is ample at this volume. |
| Next.js | Vite + React + TS | Static output. Next.js earns its keep with server rendering, and there is no server. |
| Supabase Auth | Google Identity Services | Free, and the client asked for Google Sign-in specifically. |

**What we give up, honestly:** concurrent writers (Sheets serialises), sub-second queries at
large scale, and row-level security enforced by a database. None of those bind at 27 units.
If the portfolio reaches a few hundred units, the migration path is Sheets → Postgres behind the
same JSON API, and the web app does not change.

## 5. Security — the one thing to get right

Financial data must not be on a public URL. **Do not use "Publish to web" CSV for anything with
money in it** — that URL is readable by anyone who has it, forever, with no audit trail.

Instead: the Apps Script Web App is deployed as

- **Execute as:** the user accessing the web app
- **Who has access:** anyone with a Google account

and `doGet` checks `Session.getEffectiveUser().getEmail()` against an allowlist held in Script
Properties. The Sheet is shared with those same accounts. An unlisted account gets a 403, and
Google does the authentication.

Trade-off: every viewer needs a Google account and read access to the Sheet. At this team size
that is a feature, not a cost.

## 6. What carries over from `../price-monitor`

That project is a working Apps Script panel against the live Hostaway account. **Reuse it; do not
rewrite it.** These parts are proven against real data:

| Keep | Why it is worth keeping |
|---|---|
| `Code.js` — Hostaway auth, calendar fetch, vacancy/urgency/occupancy | Handles an API that ignores its own filter params; caches which URL spelling works (`CAL_VARIANT`) |
| `Finance.js` — cost proration, reservation ledger | Splits a stay or a monthly lease across a window boundary correctly. Guards $0-payout iCal blocks that used to produce negative revenue |
| `Agent.js` + `Checkout.js` + `Ratings.js` — Airbnb live price + ratings | Works. Do not touch. The client explicitly values this |
| `Notify.js` — QUO/SMS + the alert signal model | GSM-7 character folding and segment counting are done and tested |
| `PriceSuggest.js` — peer-based pricing | Prices each unit against comparable units in the same portfolio. No scraping needed |
| `Decisions.js` — the decision log | Detects price changes and records outcomes. This is the PDF's "how agents earn autonomy" table, already built |
| `Market.js` — Airbnb comp scraping | Fragile (Airbnb DOM, undocumented ids). Manual-only sanity check. Low priority |

**What was learned the hard way there — do not rediscover:**

- Apps Script evaluates files in project order; a top-level `const` referencing a constant from a
  later file throws at load and the whole project fails silently with no menus. Cross-file
  constants go behind a function.
- `sheet.clear()` does not remove merges or frozen panes.
- You cannot freeze a column that holds part of a merged cell.
- `setValues` treats a leading `=` as a formula — batch hyperlinks, never `setFormula` per cell.
- Airbnb search with dates shows **whole-stay totals**, not nightly rates.
- A simple `onOpen` trigger cannot touch `PropertiesService`.

## 7. Data model — sheets are tables

Existing, populated, and live. Column names are the contract between Apps Script and the web app.

| Sheet | Role | Written by |
|---|---|---|
| `📊 Dashboard` | one row per unit: next gap, prices, ratings, occupancy | sync + AI agent |
| `🧾 Reservations` | raw stay ledger: arrival, departure, booked-on, payout | ledger refresh |
| `💸 Costs` | dated variable costs, scoped to a unit or split across all | **hand-edited** |
| `🏠 Fixed Monthly Costs` | per-unit monthly baseline | **hand-edited** |
| `🗣️ Claims` | guest claims, severity-weighted | **hand-edited** |
| `🧠 Pricing Decisions` | detected price changes + outcomes | sync |
| `💡 Price Suggestions` | peer-based advisory | on demand |
| `🔗 Listing Links` | platform URLs per unit | menu |

## 8. Decisions already made — do not re-open without a reason

1. **Sheets is the database.** Revisit only above ~200 units or if concurrent editing breaks.
2. **Apps Script is the API.** No separate backend.
3. **Writes are narrow and append-only.** The team records expenses and claims through the app;
   everything else is read-only. Appending never rewrites an existing row, so a retry cannot
   double-count and yesterday's numbers stay reproducible. Do not build a general CRUD layer.
4. **Profit is the headline metric**, not occupancy. Every screen ends in a net number.
   (This is the one idea from the client's PDF worth taking wholesale.)
5. **Agents draft, humans send.** Nothing writes a price to Hostaway. Ever. Autonomy is earned
   through the decision log.
6. **Alert on change, not on state.** Fire once when a condition begins, once when it resolves.
7. **Build the ugly working version first.** The client's own spec puts the visual layer last,
   deliberately — it is right about that.

## 9. Build order

| Phase | Ships | Status |
|---|---|---|
| 0 | Apps Script `doGet` JSON API + allowlist | **done** — `apps-script/Api.js` |
| 0b | `doPost` append-only writer for expenses and claims | **done** — same file |
| 1 | Vite + React + TS shell, Google sign-in, reads the API | **next** |
| 2 | Money screen: derived scoreboard → per-unit tile → per-unit P&L | |
| 3 | Expense + claim entry forms | |
| 4 | Deploy to Vercel | |
| 5 | Performance: forward pace, peer position, the two failure patterns | |
| 6 | Decision log view — what earns automation later | |

Phases 1–4 are the demo. Everything after is earned.

**Deliberately not scheduled:** Walmart/Amazon invoice import. The schema is ready for it
(§2a); building it before anyone has entered a single expense by hand would be guessing at a
workflow nobody has performed yet.

## 10. Open questions — need a human, do not guess

- Does the client want the existing Google Sheet used directly, or a fresh copy?
- Which Google accounts go on the allowlist?
- **No domain yet.** Vercel gives a free `*.vercel.app` URL, which is enough for the demo. Buy a
  domain only once the client has seen it working.
- Ownership and licence: repo is under the developer's account pending payment terms. **Not a
  technical question — do not resolve it in code.**

## 11. Conventions for future sessions

- **Comments explain *why*, never *what*.** Match the density in `../price-monitor` — that
  codebase documents its own bugs and reversals, and that is deliberate.
- **Verify before building on it.** Static checks do not catch load-time or spreadsheet-layout
  failures. If a layer has never run, say so rather than stacking another on top.
- **Delete work that nothing reads.** Several features in the reference project were built,
  measured, and removed. That is normal, not failure.
- **State limitations plainly in the UI**, not just in code comments. A number whose basis is
  thin should say so on screen.
