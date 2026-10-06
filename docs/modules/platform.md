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
  `/api/slack`, `/api/slack-cron`), `settings.ts`, `roles.ts`, `sops.ts`, `sync-units.ts`.
- Server libs: `auth.ts` (identify), `roles.ts` (permissions → routes/tabs, `mayAccess`),
  `accounts.ts` (credentials, accessOf), `crypto.ts`, `db.ts`, `hostaway.ts` (client: token
  kept, paging, calendar writes verified by read-back), `sync.ts`.
- Pure libs: `sops.ts` (FEATURES, markdown-ish parser), `dates.ts`, `format.ts`.
- Scripts: `migrate.mjs`, `seed-sops.mjs` (idempotent by title), `screenshot.mjs`,
  `set-credentials.mjs`, `sync-units.mjs`.

## Tables

`accounts` (credentials encrypted, allowed_emails, ops/slack/drive config), `members`,
`roles`, `member_audit`, `sops`, `sop_versions`, `sop_sections` (parent_key), `_migrations`.

## Rules that bite

- Two gates: Access decides who reaches the app; `allowed_emails` decides who is ours.
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
- Design: day theme by default via `data-theme` (never prefers-color-scheme); status shapes
  ● ▲ ■ ○; colour means one thing (red failure, amber attention, green confirmed, blue
  action); no modals over the thing being compared; Home folds, three items per card;
  phones: nothing scrolls sideways (§20, §27, §28, §80, §81, §91).

## Open items

- SOP drafts 1–6 await the owner's review and publishing.
- Offered: Google login privacy page; Autohost background checks.

## History

§1–§3, §8, §10–§13, §20, §27–§29, §49, §51–§52, §55, §65, §67, §75, §80–§81, §91–§92, §96–§98.
