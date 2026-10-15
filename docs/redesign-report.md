# Redesign report — branch `redesign` (2026-10-14)

Feedback: "it looks messy", then "the emoji: minimalist small icons, one colour unless needed".
Brief: redesign the whole app, UI only (no logic, data, API or migrations), with the apple-design skill
(Apple HIG + a craft lens). Not pushed — **push = deploy**. The system itself: [`design-system.md`](design-system.md).

## Verification

After every commit: `npm test` (325/325), `npx tsc --noEmit`, `npm run build` — all green; nothing had to
be reverted. Screens checked against the local server (`wrangler pages dev` + the database) at 1440 and
390, light and dark; at 390 nothing scrolls sideways on any tab.

## What "messy" was, measured

| Before | After |
|---|---|
| 23 font sizes (10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5…) | 9 tokens named after Apple's text styles; iOS sizes on phones |
| 13 corner radii | 4 + pill |
| ~20 one-off shadows | 3 elevations |
| Three CSS layers re-declaring the base (`header`, `h1`, `.tab`, `main`…) | One token layer + one base layer |
| Black primary button vs blue links vs black selected tab | Blue = action, ink = selected, raised white = current segment |
| Colour contradicting itself (OUT amber, IN green, "same-day" red, "inspection" red, floors red/green) | Colour by meaning only: red failure, amber attention, green confirmed |
| Colour emoji everywhere (936 uses, 98 kinds) | One-colour icons (`Icon.tsx`), sized and coloured by their text |
| Phone: 9 tabs in a strip that scrolled sideways | Bottom tab bar: 4 + More |

## By module

**Platform (phases 0 + 0b)** — tokens for colour (light/dark, every text colour ≥ 4.5:1, computed), type,
space, radii, elevation, control height (36 desktop / 44 phone). Sticky shell with a mark (the status rail
as the logo); desktop tabs with `aria-current`; phone bottom bar with SVG icons and a "More" sheet.
Buttons, fields (visible focus ring), banners as a status rail, tables, cards, modal / phone sheet, Hint
with a 44 px hit area. Fixed things (SOP button, toast, minimised SOP sheet) sit above the bar. Fixed:
`--good` at 3.2:1 under white text; tiny links at 45% opacity (~2:1) → muted at 6.3:1.
Emoji → icons through a type-checked codemod (30 files): `<Icon/>` in JSX, `ic()` for copy that carries
emoji (crew-i18n, label maps, practice data) without touching the strings, `noEmoji()` in attributes.

**Operations (1)** — movement kinds neutral (OUT filled, IN outlined, CLEAN dashed); flags: attention
amber, information neutral, no red. Phone: the eight views fade at the edge. Steppers secondary.

**Work (2)** — a to-do's ✕/✓: one rule instead of three, 28 px / 40 px. Work tabs use the system's "selected".

**Finance (3)** — "Too early to tell" muted (was action blue). Sideways grids sit on a surface (the cost
matrix's editable cells looked disabled). The phone's summary strip is a real two-column grid.

**Guests (4)** — ID / agreement uploads reachable by keyboard (the input was `hidden`) and sized for a thumb.

**Repository (5)** — option colours as a dot on a neutral pill. Phone: search + reload on one row. The
shell header scoped to `header.app-header` (mid-redesign it had caught the Repository's bar and Home's header).

**Slack (6)** — Settings panel: a label with an icon stays one line (`ic()` returns one span); checkboxes
no longer shrink; a card's title outranks its steps. The Slack messages themselves keep their emoji.

## Decisions taken (autonomously, as asked)

1. **A separate git worktree** (`../kaizen-os-redesign`) instead of `checkout -b`: other sessions share the
   `kaizen-os` tree and a branch switch would have moved it under them.
2. **apple-design skill**: not loadable as a Skill in this session; it was already in the repo
   (`.claude/skills/apple-design/`, identical to GitHub), so it was read and applied by hand. It is still
   **untracked** in `kaizen-os` — not committed (not UI).
3. **Kept light-by-default and the day/night switch** (owner's decision, §20), though the HIG advises against an in-app switch.
4. **Kept "faint until pointed at"** for a to-do's actions (§105); always shown on touch.
5. **The urgent to-do rail stays red** (Urgent priority, consistent with High/Critical claims).
6. **Slack / SMS copy untouched**: outbound messages, not this app's UI.
7. **Screenshots are not in git**: they show real data (guests, amounts, settings). They live in
   `docs/redesign/{before,after}/`, excluded through `.git/info/exclude`.
8. **`§158`** in `history.md` — if another session adds a §158 on master, renumber on merge.

## Open items

- **Check on a real phone** (iOS Safari): safe area under the bottom bar, the sheets, no zoom on fields.
- The unit title on the cleaner's page is large (28 px): confirm with a cleaner that long names wrap well.
- Operations' eight views still scroll sideways on a phone (with a fade); if it bothers anyone, group them under a "More" like the main bar.
- Emoji left on purpose: `confirm()` dialogs; a new emoji in copy becomes an icon only if it is in `EMOJI_ICON`.
- Not audited screen by screen: the SOP editor, the Monday import, the printed invoice (they inherit the tokens).
- The local review server is still running on :8799 with this branch (`wrangler pages dev`).

## Screenshots (local only)

`docs/redesign/before/<name>-<width>.png` (master) and `docs/redesign/after/<name>-<width>.png` (this
branch), widths `1440` and `390`, full page. Names:
`home`, `units`, `revenue`, `costs`, `claims`, `repository`, `sops`, `settings`,
`operations-movements`, `operations-to-do`, `operations-cleaners`, `operations-inspections`,
`operations-inventory`, `operations-notes-log`, `operations-rates-rules`,
`crew-practice` (the cleaner's page), `helper-practice`, `practice-inspection`, `practice-work-link`,
`practice-vendor`. Dark (after only): `home-dark-1440`, `crew-practice-dark-390`.
Regenerate: `node scripts/screenshot.mjs <Tab> <out> <width> [SubTab]` against the local server.
