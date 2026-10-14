# Module: platform

What every module stands on: auth and roles, Settings, Home, SOPs, design system, the
Hostaway client, sync, crypto, migrations.

## Files

- App shell: `src/App.tsx` (tabs from the server, `?sop=` deep link, SOP panel state),
  `src/api.ts`, `index.html` (theme before first paint), CSS.
- Screens: `Home.tsx`, `Settings.tsx` (credentials, members & roles grid, allow-list, Drive,
  Slack panel, ingest token, daily file links), `Sops.tsx`; components `Sops.tsx` (panel,
  floating button, step by step), `ThemeToggle.tsx`, `Modal.tsx`, `Loading.tsx`.
- API: `_middleware.ts` (allow-list + role gate; SELF_AUTHENTICATING = `/api/observations`,
  `/api/slack`, `/api/slack-cron`, `/api/crew-link`, `/api/report-link`), `settings.ts`, `roles.ts`, `sops.ts`, `sync-units.ts`.
- Server libs: `auth.ts` (identify), `roles.ts` (permissions → routes/tabs, `mayAccess`),
  `accounts.ts` (credentials, accessOf), `crypto.ts`, `db.ts`, `hostaway.ts` (client: token
  kept, paging, calendar writes verified by read-back), `sync.ts`.
- Pure libs: `sops.ts` (FEATURES, markdown-ish parser), `dates.ts`, `format.ts`.
- Scripts: `migrate.mjs`, `seed-sops.mjs` (idempotent by title), `screenshot.mjs`,
  `set-credentials.mjs`, `sync-units.mjs`. `screenshot.mjs` takes `PAGE='/report#w=…'` with tab `-` for a field link.

## Tables

`accounts` (credentials encrypted, allowed_emails, ops/slack/drive config), `members`,
`roles`, `member_audit`, `sops`, `sop_versions`, `sop_sections` (parent_key), `_migrations`.

## Rules that bite

- Two gates: Access decides who reaches the app; `allowed_emails` decides who is ours.
  Exception (§122): an address on the cleaners roster gets role `cleaner` (only its own crew page),
  checked in accessOf BEFORE "no member row = admin", and skips the allow-list.
  Same for handymen (§137): an active vendor's email → role `vendor` (permission VENDOR: `/api/vendor`,
  `/api/settings` GET; tab `vendor` = their work orders, no header), checked after cleaners.
  SELF_AUTHENTICATING also lists `/api/crew-link` and `/api/report-link` (secret-link doors: the token is
  the only credential, they never trust identity headers). Cloudflare Access has a **Bypass app "Kaizen —
  public links"** (Bypass Everyone, live 2026-10-12) for `/report`, `/api/report-link`, `/crew`,
  `/api/crew-link`, `/assets/*` — verified: those answer without sign-in, `/` and every other `/api/*`
  still redirect. A new public page needs its path added there (§134).
  Empty list = any authenticated caller; DB failure = 503, never a pass (§29).
- Roles are named sets of permissions (Settings grid, each tick saves at once); allow-list
  of routes — a new route is closed until listed; no member row = admin; unreadable role =
  nothing; a list with no admin or that demotes the saver is refused (§49, §65, §75).
- Nothing renders before the role is known; a failed load says so (§52, §55).
- Hostaway client: listings `specialStatus`; discounts are multipliers (0 = unset);
  calendar write undocumented → try PUT/POST/array, success only by reading back (§14, §31).
- SOPs: sections + one level of subsections; per-screen floating "📘 SOPs for this screen";
  docked panel that persists across tabs and minimizes; step-by-step mode; every content
  change = a new `sop_versions` row with a note; review cadence (§92, §96–§98).
  SOPs edited outside the API must also insert `sop_versions`.
  **Fixed format for an AI assistant (§151):** no schema change — `body`'s last headers, in
  order, when they apply: "## Rules" (if → then) and "## What the system does" (automatic
  behaviour). Everything else already has its own field (purpose/trigger/owner/steps/doneWhen).
  A screen with no real SOP yet, or a fictitious one (no matching screen/feature), hurts an
  assistant more than a gap does — don't write one.
  The panel also shows "🧪 Practice · Practicar" links on the screens in `PRACTICE_FOR` (§139, operations module).
  Feature `crew.page` (§128) is the cleaner's own page: cleaners have no SOP access, so its published SOPs
  reach them through /api/crew (`help`), not the library.
- Design: day theme by default via `data-theme` (never prefers-color-scheme); status shapes
  ● ▲ ■ ○; colour means one thing (red failure, amber attention, green confirmed, blue
  action); no modals over the thing being compared; Home folds, three items per card;
  phones: nothing scrolls sideways (§20, §27, §28, §80, §81, §91).

## Open items

- SOP library cleaned up for an AI assistant (§151, 2026-10-13): deleted the TEST SOP, two
  test sections, and 6 drafts superseded by the current crew flow (pre-§150 model). Rewrote
  #10, #14, #15 to match current behaviour; rewrote #22/#23 (the crew step-by-step) to the
  real report menu (⚠️ wrong · 🧴 request · 🛒 bought). Wrote 8 new drafts for screens that had
  none: Calendar (#24), Notes log (#25), Rates & rules (#26), Costs (#27), Units/Revenue
  pricing (#28), vendor work orders (#29), Settings members (#30), Setup overview (#31).
  **Owner published all 24 the same day** (incl. the pre-existing #1–#6, #11–#13 backlog).
  Coverage now: 24/24 live SOPs published, every FEATURES screen covered except `vendor`
  (no such feature key — see §151) and `crew.page`/`crew.page.es` (covered by #12/13/22/23).
  **#1 Check-in readiness still carries its own "## To confirm before publishing" note** (the
  exact cut-off time for a missing signature) — published anyway at the owner's instruction;
  worth a look next time that module is open.
- Still to decide: whether @Kaizen in Slack should answer "how do I…" questions from
  **published** SOPs only (moot now that all are published, but the rule still matters the
  next time a draft is written) — the Slack module's call, flagged here because it's the
  reason this cleanup happened.
- Offered: Google login privacy page; Autohost background checks.

## History

§1–§3, §8, §10–§13, §20, §27–§29, §49, §51–§52, §55, §65, §67, §75, §80–§81, §91–§92, §96–§98, §137, §151.
- **Home's "Units in red" cached (owner, 2026-10-13, migration 077 `api_cache`):** `/api/forward?cache=1` (Home only) keeps
  the answer 10 min for everyone (`forward:<asOf>:<days>`); *.pages.dev has no usable Cache API. The card says when it
  was read. Units asks without `cache` — live.
- **Explanations behind a "?" (owner, 2026-10-14: too much text on screen):** `src/components/Hint.tsx` — a ? beside a title;
  the text shows on hover, keyboard focus or a tap (role=tooltip, Escape closes). Only explanations move there; states, limits,
  warnings and empty states stay on screen. Done: Settings → Slack (and its cleaners' options, one per line). Next: Operations,
  Settings, Crew, Inventory, Todos, Units — screen by screen.
