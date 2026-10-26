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
  still redirect. A new public page needs its path added there (§134). `/api/report-link?stripe=<signed>` is a payee's
  Stripe setup link (§168) — same door, no new bypass.
  Empty list = any authenticated caller; DB failure = 503, never a pass (§29).
- **Payouts (§168):** permission `payouts` (`/api/payouts`) — paying invoices is not part of Operations' edits. Settings → Payments
  holds the Stripe secret key (`accounts.stripe_secret_key_enc`; test keys only, checked against Stripe's /balance before saving).
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
- **Design system: `docs/design-system.md`** (redesign, §158) — tokens at the top of `src/index.css`; a screen's
  rule reads tokens (`--fs-*`, `--r-*`, `--s-*`, `--shadow*`, colours), never its own px/hex. Phone (≤720):
  bottom tab bar (`TabBar` in App.tsx, `TabIcon.tsx`), always 4 + More (More also holds "Report a bug / request", 2026-10-15); `--tabbar-h` lifts fixed things.
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

§1–§3, §8, §10–§13, §20, §27–§29, §49, §51–§52, §55, §65, §67, §75, §80–§81, §91–§92, §96–§98, §137, §151, §158.
- **Home to-dos on a phone (owner, 2026-10-15):** the Tasks / Repairs / Claims pills take the card's header row alone (swipe); + / All ↗ / "?" sit at the right of the first bucket's line ("Now"), absolutely placed inside the tab body (`.todos-aside`); desktop unchanged (`Todos.tsx` `tabsInHead`, `usePhone`). Tried and dropped: tinted "islands" in the header row (the pills read as a toggle).
- **Home's "Units in red" cached (owner, 2026-10-13, migration 077 `api_cache`):** `/api/forward?cache=1` (Home only) keeps
  the answer 10 min for everyone (`forward:<asOf>:<days>`); *.pages.dev has no usable Cache API. The card says when it
  was read. Units asks without `cache` — live.
- **Explanations behind a "?" (owner, 2026-10-14: too much text on screen):** `src/components/Hint.tsx` — a ? beside a title;
  the text shows on hover, keyboard focus or a tap (role=tooltip, Escape closes). Only explanations move there; states, limits,
  warnings and empty states stay on screen. Done (2026-10-14): Settings → Slack, Operations (16), Settings (17), Inventory (9), Crew's
  admin parts (2), Revenue, Cleanings (2), Costs. Kept on screen on purpose: Todos' notes and Units' data caveats (states),
  the cleaner-facing crew page, empty states.
  Hover (Hint/Peek): closes 250 ms after the pointer leaves, and an invisible bridge covers the gap to the pop-up —
  before, crossing the 6 px gap closed it (owner, 2026-10-15).
- **Navigation (§159, owner 2026-10-14):** tablet/desktop = a side rail (`SideNav`, App.tsx) that slides open on hover,
  Operations' views inside it (`goOps` → Operations `nav` {v, n}); no top bar ≥ 721 px. Phone = header + bottom bar.
  Home: no summary pills (they repeated the cards); centred 1120 px with equal-height cards on a big screen; no uploads or
  Hostaway links on a phone. `scripts/screenshot.mjs` clicks `.side-link` (big) or the bottom bar / More (phone).
- **Reports (owner, 2026-10-15):** "Report / request" at the rail's foot (above day/night) and in the phone's More — the
  bug / request form and what was sent (`src/components/Reports.tsx`, `/api/reports`, open to every member). Details: slack module.
- **Round 4 (§159):** the rail opens on hover or keyboard focus (`:has(:focus-visible)`) — not after a click (it stayed
  stuck open). The day is in the menu (`Today` in App.tsx: a calendar leaf in the rail, a chip in the phone header); Home has
  no heading. Home ≥ 1280 px: three columns (check-outs · check-ins · coming up / to-do ×2 · units in red, `data-card`).
  **Open: the owner says the time is Central (CST); the board, ops and timelines still compute "today" in New York (43
  places, the daily file's zone) — a separate, asked-for change.**
- **Home = To-dos + a strip of modules (owner, 2026-10-14, §159):** desktop — To-dos fills the left column (~2/3); the right
  column is a horizontal strip of chips with counts (Check-ins/outs, Coming up, Units in red — only what the role may see,
  `mods` in `Home.tsx`) and the chosen module's panel under it. Phone — the same strip is the top tab bar and also carries
  To-dos (default); one module on screen, To-dos stays mounted (hidden) so its count and state survive. A new widget = one more
  entry in `mods`. Cards no longer fold (`useFolded` removed). Check-ins and check-outs are one module. Labels stay in English.
- **Home, zero noise (owner, 2026-10-14):** no "Show X more" and no urgency summary line. The To-dos card header is title · count · "?" · + Add (`TodoList head`); urgency lives in the Now bucket and the ▲ on a pill. Feeds (`.home-todos .work-tab-body`, `.home-slide`) scroll inside a fixed height (`--feed-h`) with the scrollbar hidden. Phone: pills swipe on one row, 44 px targets.
- **Home strip + panel, one box (owner, 2026-10-15):** on the desktop screenshot the chip strip floated on the page
  background above a separate white panel, sitting lower than the To-dos card's top. ≥721 px, `.home-side-col` now
  carries the card look itself (white, border, radius, shadow, padding) so it is level with `.home-main-col`'s To-dos
  card; `.home-rail` sits inside it with a hairline under it, and the nested `.home-card` (the Panel) goes transparent/borderless
  so there's one box, not two. Phone is untouched (`.home-side-col { display: contents }` there, so none of this applies).
- **The menu's date, CST, foot of the rail (owner, 2026-10-15):** the boxed "OCT 15" at the top of the desktop rail
  (`App.tsx` `Today`) read as ugly and was in New York, not the team's zone. Moved to `.side-foot` (after `ThemeToggle`,
  right-aligned, plain footnote-size text reusing `.side-word`'s hover fade) and switched to `America/Chicago`
  (CST/CDT) — the same zone as `teamTz`'s default. This settles the menu part of the §159 "Open" item above; the
  board/ops/timelines' 43 places still compute "today" in New York — still a separate, asked-for change.
