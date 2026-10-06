# Kaizen OS

Short-term-rental operations platform for Kaizen Guest Properties (~27 Hostaway listings,
Frisco/Austin/Celina TX; 22 active). The client owns it. Production:
https://kaizen-01v.pages.dev — repo `jdgonzalezp2014-gif/Kaizen`, branch `master`, **push = deploy**.

## Work one module at a time

Read only the module you are working on. Each says which files, tables, rules and open
items belong to it, and which `§N` of `docs/history.md` explain it.

| Module | Covers | Read |
|---|---|---|
| finance | Units, Revenue, Costs, pricing, Gemini, ratings feed, alerts | `docs/modules/finance.md` |
| operations | the board, cleanings, inspections, manual cleans, Host Notes, rates & rules | `docs/modules/operations.md` |
| work | tasks, repairs, claims, Hostaway tasks mirror, repair costs, done log | `docs/modules/work.md` |
| guests | agreement / ID status, Drive copies, Home check-ins | `docs/modules/guests.md` |
| slack | the bot, @Kaizen, daily messages, the clock | `docs/modules/slack.md` |
| repository | native data repository, Drive files, Monday import | `docs/modules/repository.md` |
| platform | auth, roles, Settings, Home, SOPs, design, Hostaway client, shared libs | `docs/modules/platform.md` |

`docs/history.md` is the full decision log (177 KB). **Never read it whole** — open only the
section a `§N` points to (`grep -n "^## 64\." docs/history.md`; from 108 on `## §108`).
When a session changes a module, update that module's doc (and its open items) before
finishing. A new decision worth the long form gets a `## §N` section in history.md.

## Stack and runtime rules

- Vite + React on Cloudflare Pages; API = Pages Functions (`functions/api/x.ts` is `/api/x`).
  Neon Postgres (project `frosty-math-62141251`, branch `production`) via
  `@neondatabase/serverless` (HTTP; Workers have no TCP). Cloudflare Access (Google sign-in)
  in front of everything; identity = `Cf-Access-Authenticated-User-Email`. No auth code.
- Functions get bindings as arguments (`DATABASE_URL`, `ENCRYPTION_KEY`) — no `process.env`.
- `src/lib/` is pure (no fetch, no framework) and tested; `functions/_lib/` is server-only.
- Secrets: only in functions, encrypted (AES-GCM, `functions/_lib/crypto.ts`), shown masked,
  never written back masked.
- Multi-tenant by shape (`account_id`, composite keys); one account (id 1) in fact.
- Times: New York for the board, ops and timelines; Central (`teamTz`) for Slack's clock.

## Workflow

```
npm test                 # node --test (~205)
npx tsc --noEmit
npm run build
npm run migrate          # db/migrations/NNN_*.sql, recorded in _migrations — BEFORE pushing
git push origin master   # deploys
```
- Migrations applied: 001–046. New ones are the next number.
- Local server (`$S` = scratch dir):
  `U=$(grep -h '^DATABASE_URL=' .env.local|head -1|cut -d= -f2-|tr -d '"'"'"); EK=$(grep -h '^ENCRYPTION_KEY=' .env.local .dev.vars|head -1|cut -d= -f2-|tr -d '"'"'"); nohup npx wrangler pages dev dist --port 8799 --binding "DATABASE_URL=$U" --binding "ENCRYPTION_KEY=$EK" --binding "ALLOW_UNAUTHENTICATED=true" > $S/wrangler.log 2>&1 &`
  Stop it with `ps -eo pid,args | grep "[w]rangler pages dev"` + kill (`pkill -f` kills its own shell).
- Screenshots: `node scripts/screenshot.mjs <Tab> <out> [width] [SubTab] [click]`;
  `PROBE='<js>'`, `VIEWPORT=1` for fixed elements, width `390` for a phone.
- One-off scripts live in the project dir (`./.x.mjs`, deleted after):
  `node --env-file=.env.local --experimental-strip-types .x.mjs`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Standing rules (from the owner)

- **Ask before changing the daily file sheet or its Apps Script** (`../cliente-gas`) — the team edits it daily.
- **Never run destructive Neon tools** without asking.
- Never repeat or write back secrets; the Hostaway key is never shown.
- **All UI text in English** (the owner writes in Spanish; answer him in Spanish).
- Outward actions (posting to the team's Slack, writing to Hostaway) need confirmation.
  Slack tests → #kaizen-task or ephemeral to Juan; the team is in #kaizen-ops.
- The Hostaway task mirror is ON: a test task is also created in Hostaway — avoid, or clean both.
- Conventions: comments say *why*; verify on real data ("deployed" ≠ "works"); colour never
  carries meaning alone (icon + word); state limitations in the UI; delete what nothing reads;
  agents draft, humans send.
