# Kaizen OS — session context

Read this first; it replaces re-reading the code. The full reasoning behind every
decision is in `docs/history.md` — **open only the section a `§N` points to**, never the
whole file. When a decision changes, update this file (and add a line to the index).

## What it is

Short-term-rental operations platform for Kaizen Guest Properties (~27 Hostaway listings,
Frisco/Austin/Celina TX; 22 active). Profit per unit, pricing advice, costs, claims, the
daily turnover board, tasks, SOPs, a native data repository, guest documents in Drive,
and a Slack bot. The client owns it. Production: https://kaizen-01v.pages.dev
(repo `jdgonzalezp2014-gif/Kaizen`, branch `master`; push = deploy).

## Stack and runtime rules

- **Vite + React** on **Cloudflare Pages**; API = Pages Functions (`functions/api/x.ts` is
  `/api/x`). **Neon Postgres** (project `frosty-math-62141251`, branch `production`) via
  `@neondatabase/serverless` (HTTP — Workers have no TCP). **Cloudflare Access** (Google
  sign-in) in front of everything; identity = `Cf-Access-Authenticated-User-Email`.
  No auth code. GitHub Actions only for the Slack clock.
- No `process.env` in functions: bindings are passed in (`DATABASE_URL`, `ENCRYPTION_KEY`).
- `src/lib/` is **pure** (no fetch, no framework), tested with `node --test`.
  `functions/_lib/` is server-only. Secrets live only in functions, encrypted at rest
  (AES-GCM, `functions/_lib/crypto.ts`, key `ENCRYPTION_KEY`); never returned to a
  browser (masked), never written back masked.
- Multi-tenant by shape: `account_id` everywhere, composite keys `(account_id, id)`;
  in fact one account (id 1).
- Times: New York for the board/ops/timelines; **Central** (`teamTz`) for Slack's clock.

## Workflow

```
npm test            # node --test, ~205 tests
npx tsc --noEmit
npm run build
npm run migrate     # db/migrations/NNN_*.sql in order, recorded in _migrations — BEFORE pushing
git push origin master   # deploys
```
- Local server (scratch dir `$S`):
  `U=$(grep -h '^DATABASE_URL=' .env.local|head -1|cut -d= -f2-|tr -d '"'"'"); EK=$(grep -h '^ENCRYPTION_KEY=' .env.local .dev.vars|head -1|cut -d= -f2-|tr -d '"'"'"); nohup npx wrangler pages dev dist --port 8799 --binding "DATABASE_URL=$U" --binding "ENCRYPTION_KEY=$EK" --binding "ALLOW_UNAUTHENTICATED=true" > $S/wrangler.log 2>&1 &`
  (stop it with `ps … | grep "[w]rangler pages dev"` — `pkill -f` matches its own shell).
- Screenshots: `node scripts/screenshot.mjs <Tab> <out> [width] [SubTab] [click]`;
  `PROBE='<js>'`, `VIEWPORT=1` for fixed elements, `390` for phone.
- One-off scripts go in the project dir (`./.x.mjs`, deleted after) to resolve
  node_modules; run with `node --env-file=.env.local --experimental-strip-types`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Migrations applied: 001–046 (last: 046_slack_threads).

## Standing rules (from the owner)

- **Ask before changing the daily file sheet or its Apps Script** — the team edits it daily.
- **Never run destructive Neon tools** without asking.
- Never repeat or write back secrets; the Hostaway key is never shown.
- **All UI text in English** (the owner writes in Spanish).
- Outward actions (posting to the team's Slack, Hostaway writes) need confirmation.
  **Slack tests go to #kaizen-task** (private, test) or are ephemeral to Juan; the team is in
  #kaizen-ops. DM mode stays `test`.
- Hostaway task mirror is ON: creating a task in a test also creates it in Hostaway —
  clean up both, or avoid.
- Conventions: comments say *why*; verify against real data before building on it
  ("deployed" ≠ "works"); colour never carries meaning alone (icon + word); state
  limitations in the UI; delete what nothing reads; agents draft, humans send.

## Architecture by area

**Money & pricing** — Units (first tab), Revenue, Costs, Claims. Hostaway is live, never
cached (§69: ask only for the dates on screen; token kept, migration 026). Costs:
fixed = one row per month per line (grid), variable = dated; shared costs divide among
live units (§16, §50). Revenue counts archived listings; targets = active & not parked
(§31, §50). `src/lib/revenue.ts` metrics + `verdict()`/`signals()` (§19). Gemini advice
never writes to Hostaway; logged in `pricing_decisions` (§17, §21). Ratings come from the
Apps Script scraper (price-monitor project `1jLlH2RIp-mcbtQ9ganST7S2jwCwFJZg2OoOLrg_wS53kWnawN9nlQsnm`)
via a published CSV feed and `/api/observations` (§34–§41); Hostaway's rating is never used.

**Operations** — Kaizen runs operations (§64): `ops_mode = 'live'` since 2026-09-25.
Board = Hostaway + `turnover_overrides` + rules in `src/lib/operations.ts` (tier rule,
rate cards, `oneCleanPerUnitDay`). Cleanings record in `cleanings` (void, never delete;
past frozen; §70). Manual cleans (§79). Host Note pushes (`mergeHostNote`). Inspections.
Setup: roster, rates, rules, guest-docs units, Hostaway tasks, Slack. Calendar view.

**Tasks** (`todos`, Todos.tsx; §76–§87, §94, §103–§105) — Hostaway's model: status
pending/confirmed/in_progress/completed/cancelled; priority none/low/medium/high/urgent
(= Hostaway null/1/2/3/4, unverified); owner/supervisor = Hostaway users; one listing;
start/finish day+time. Kaizen extras: kind (to-do / 🔧 repair), vendor, estimate,
sub-tasks (one level), claim link, stay link. `work_updates` = comments (kind `note`) +
activity log (system lines, in a pop-up). Lanes To-dos / Repairs / Claims; done log with
CSV. Owners are optional (days off/shifts). Mirror ↔ Hostaway tasks both ways (§93).
Repair cost → Costs › Repairs always; "Charge to owner" → Hostaway expense (§95).

**Claims** — a case (CRUD; soft delete, `case_url`, stay link, comments) (§46, §86, §88).

**Guests** — agreement/ID status from Hostaway; ID copy in Drive per building (P2);
Home upload/drag-drop into the daily file's Drive folders (§73, §89, §90, §106).

**Repository** — native in Postgres (`repo_*`, secrets encrypted, reveals logged);
files in Drive via OAuth (§71, §72); Monday import (§74).

**Roles** — permissions → roles (`roles` table, Settings grid, allow-list, fail closed;
§49, §65). Middleware `functions/api/_middleware.ts` enforces; `SELF_AUTHENTICATING` =
`/api/observations`, `/api/slack`, `/api/slack-cron` (Cloudflare Access bypass app
"Ingest bypass" covers them).

**SOPs** — library by section/subsection, per-screen floating button, docked panel,
step-by-step, versions and review cadence (§92, §96–§98). SOP id 8 = "Kaizen in Slack"
(also `/kaizen help`; v13).

**Slack** (`src/lib/slack.ts` pure; `functions/_lib/slack*.ts`; `functions/api/slack.ts`,
`slack-cron.ts`, `slack-settings.ts`; Settings → Slack, `SlackPanel.tsx`) — §99–§115.
- Workspace "Kaizen"; bot U0C5NJS538B; Juan U0C5CQSSVQV. All topics → **#kaizen-ops**
  C0C72JDKZ53; #kaizen-task C0C5NL9H5UK = tests. Manifest in SlackPanel (scopes incl.
  im:write, app_mentions:read, reactions:write; event `app_mention`); reinstalled.
- Web API calls are **form-encoded**; ≤5 overflow options; no duplicate action_id in a
  block; modals need a trigger_id within 3 s (loading modal + `views.update`); mentions
  have no trigger_id (answer with buttons); an ephemeral reply shows in a thread only if
  the thread exists (post a stub first).
- Clock: `.github/workflows/slack-cron.yml` hourly + 04:55/05:55 UTC, secrets
  KAIZEN_URL / KAIZEN_INGEST_TOKEN (= price-monitor's `KAIZEN_TOKEN`; working since
  2026-10-06). Messages: **8 AM** (day + tasks + claims, Manage per section), **3 PM**
  (missing for tomorrow), **11:55 PM** tasks check-out; `slack_sent` dedups.
- In: `/kaizen help|tasks|task|repair|claims|claim|today|cleans`; ⚡ shortcuts; ⋯ Create
  task from message; **@Kaizen** new/repair (made at once, listing guessed, ✎ Add details),
  claim, tasks, claims, all (in-thread, public), today, help (buttons to every pop-up),
  comments; `@Kaizen <text>` in a task/claim thread = comment. Private answers go inside
  the asker's thread. Task and claim cards with comments (💬); comments sync Kaizen ↔
  thread (`slack_threads`). DMs to owners via People mapping (mode test).
- Cleaner channels: prepared, sent by hand only.

## Open items

- Hostaway AI escalations: no API; path = notification email → Kaizen. Waiting for a
  sample email / the rule screenshots. Nothing built.
- Verify: Hostaway priority number order; reservation URL format (`hostawayReservationUrl`).
- Cleanings Log header row blank in the daily file (read by column order) — ask first.
- Offered, not built: Slack Home tab, Autohost checks, crew Spanish tabs / Sheets mirror.
- Cloudflare Functions placement → Smart (no code).
- GitHub's scheduled runs are late/sparse (every 5–6 h on 2026-10-06), so the 8 AM / 3 PM
  messages can arrive hours late. Fix offered and declined for now: a Cloudflare Worker cron
  (`kaizen-clock`, every 5 min → /api/slack-cron; needs `npx wrangler login`).

## Index of decisions (`docs/history.md`)

1–13 foundations: purpose, stack (Vite not Next, Access not Auth.js), architecture, data
sources, multi-tenant shape + encryption, scope, targets are variables, ranges, DB,
price-monitor lessons, settled decisions, conventions · 14 Hostaway fields & traps ·
15 blocked ≠ empty · 16 costs fixed/variable · 17 decisions logged before push ·
18 occupancy is a guardrail · 18a cleanings sheet median · 18b sync bug · 19 metrics,
19a calibrate thresholds, 19b verdict first · 20 design notes · 21 Gemini (no invented
market) · 22 Units list · 23 breakdowns (bookingengine = Direct) · 24 filters ·
25 local events grounded · 26 advice on open · 27 no modals · 28 day/night theme ·
29 allow-list gate · 30 calendar band · 31 `specialStatus` = active · 32 channels &
Airbnb scraping · 33 two-column panel · 34 Apps Script scrapes, Kaizen stores ·
35 two analyses bylines · 36 channel states · 37 rating live + stored · 38 ratings CSV
feed · 39 platforms as rows (5-pt scale) · 40 Hostaway rating never used · 41 30-night
quote · 42 loading % · 43 outcomes close themselves · 44 alerts on change · 45 QUO
staged · 46 claims are cases · 47 Units first · 48 two clocks · 49 roles v1 · 50 archived
still earned · 51 primary owner · 52 nothing before role · 53 cleanings scopes ·
54 empty-string date filter · 55 failed load ≠ demotion · 56 cleanings auto-refresh ·
57 "Not needed" not a cleaner · 58 invoice calendar · 59 WhatsApp parsing (59-0, 59a,
59b) · 60 backfill new columns · 61 cleaner multi-select · 62 bulk insert · 63 daily file
& repository read · 64 Kaizen runs operations · 65 roles = permission sets ·
66 repository via API (superseded) · 67 Home · 68 state 2026-09-25 · 69 live Hostaway,
fast · 70 cleanings record fit to pay · 71 native repository · 72 Drive uploads ·
73 guest documents folders · 74 Monday import · 75 roles save per tick · 76 to-do list ·
77 work backbone + claims · 78 work tree · 79 manual cleans · 80 phones · 81 Home folds ·
82 remove says what + undo · 83 timelines last three · 84 work tied to a stay ·
85 lanes · 86 full CRUD · 87 done log · 88 claim case link · 89 every guest ID/agreement ·
90 ID copy + Hostaway link · 91 Home design · 92 SOPs · 93 Hostaway tasks mirror ·
94 tasks on Hostaway's model · 95 repair money · 96 SOP step by step · 97 subsections ·
98 docked SOP panel · 99 Slack · 100 interactive Slack · 101 cleans + help SOP ·
102 reminder sections · 103 comments fold / activity pop-up · 104 open task layout ·
105 row actions, rename in place · 106 Home documents drag-drop · 107 thread comments,
check-in/out · 108 @Kaizen, comments both ways · 109 three messages, Central ·
110 @Kaizen new at once · 111 💬 comment menus · 112 help buttons, @Kaizen claims ·
113 claim card · 114 #kaizen-ops, @Kaizen all · 115 private answers in thread
