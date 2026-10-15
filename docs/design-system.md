# Kaizen OS — design system

Redesign of 2026-10-14 (branch `redesign`). Everything lives in `src/index.css`: tokens at the top,
the shared components right after them, then the per-screen sections. **A rule for a screen reads
tokens; it never declares a px font size, a radius, a shadow or a hex colour of its own.**

## Who it is for

| Who | Where | What follows from it |
|---|---|---|
| Cleaners, ops, inspectors | Phone, 390 px, one hand, outdoors | iOS text sizes, 44 px controls, tabs at the bottom, nothing scrolls sideways |
| Admin | Desktop, 1440 px | Dense but legible: 13 px body, 36 px controls, the tabs in the header |

The thesis: **a quiet operations tool where the only loud thing is the state of things**.
Brand stays out of the way. Colour is spent only on status and on the action.

## Colour

Light is the default. Dark hangs off `[data-theme="dark"]`, never off `prefers-color-scheme`
(owner decision, §20). Contrast was computed from the hex values (WCAG), not estimated:

| Token | Role | Light | on card | Dark | on card |
|---|---|---|---|---|---|
| `--bg` | page | `#f4f5f7` | — | `#0e1217` | — |
| `--card` | surface you work in | `#ffffff` | — | `#161b22` | — |
| `--tint` | control bars, callouts (5% ink over card) | derived | — | derived | — |
| `--line` / `--line-strong` | hairlines / field borders | `#e1e5ea` / `#c3cad3` | — | `#28303a` / `#3d4753` | — |
| `--ink` | text | `#141b24` | 17.3:1 | `#e9eef4` | 14.8:1 |
| `--muted` | secondary text | `#56616e` | 6.3:1 (5.7 on tint) | `#9aa6b3` | 7.0:1 (6.2 on tint) |
| `--accent` | **action**: primary button, link, focus | `#1d5fc4` | 6.0:1 | `#6aa3f5` | 6.7:1 |
| `--on-accent` | text on accent | `#fff` | 6.0:1 | `#0b1220` | 7.3:1 |
| `--green` (`--good`) | **confirmed** | `#17703f` | 6.1:1 | `#4fca8b` | 8.4:1 |
| `--amber` (`--warn`) | **attention** | `#965700` | 5.7:1 | `#eda844` | 8.5:1 |
| `--red` (`--crit`) | **failure** | `#b42318` | 6.6:1 | `#f2766d` | 6.3:1 |
| `--on-status` | text on filled green/red | `#fff` | ≥ 6.1:1 | `#0b1220` | ≥ 6.3:1 |

Every text token is ≥ 4.5:1 on `--bg`, `--card` and `--tint` in both themes. `--good/--warn/--crit`
and `--series-1` are **aliases**, not separate colours: a green tag and a green chart bar can no
longer disagree. Before, `--good` was `#0ca30c`: 3.2:1 under white text on "Mark as done".

Rules:
- **One colour, one meaning.** Red = failure, amber = attention, green = confirmed, blue = action.
- **Colour never carries the meaning alone**: ● ok, ▲ attention, ■ failure, ○ none, plus a word.
- **Ink fill = selected** (a filter chip that is on). **White raised on tint = current segment**
  (sub-tabs). **Blue fill = do this** (one primary button per area).

## Type

The system face (SF on Apple devices, Segoe/Roboto elsewhere). One scale, named after Apple's
text styles. Phones take iOS sizes. Inputs are ≥ 16 px on a phone so iOS doesn't zoom.

| Token | Desktop | Phone (≤ 720) | Use |
|---|---|---|---|
| `--fs-caption` | 11 | 12 | column heads, eyebrows (UPPERCASE + .04em) |
| `--fs-footnote` | 12 | 13 | meta, timestamps, hints |
| `--fs-body` | 13 | 15 | tables, forms, most text |
| `--fs-callout` | 14 | 16 | row titles |
| `--fs-headline` | 15 | 17 | card titles |
| `--fs-title3` | 17 | 18 | section titles, brand |
| `--fs-title2` | 20 | 22 | screen titles |
| `--fs-title1` | 26 | 28 | the one big number |
| `--fs-large` | 34 | 34 | reserved |

Numbers use `font-variant-numeric: tabular-nums`. Hierarchy comes from weight and size, not from
colour. Before: 23 different sizes (10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5 …) → now 9 tokens.

## Space, corners, elevation

- **Space:** a 4-point grid, `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48.
- **Corners** (13 values before → 4 + pill): `--r-xs` 4 marks and tags · `--r-sm` 8 controls ·
  `--r-md` 12 cards, rows · `--r-lg` 16 sheets, dialogs · `--r-pill` chips and counts.
  Data marks (bars, ticks) keep 1–3 px.
- **Elevation**, three steps and nothing else: `--shadow` (card), `--shadow-2` (floating:
  popover, SOP button, toast), `--shadow-3` (dialog, sheet). `--scrim` behind a modal.
- **Controls:** `--control-h` 36 px desktop / 44 px phone (HIG: 28 / 44).

## The signature: the status rail

The product's one recurring shape is **a coloured rail on the left edge plus a shape (● ▲ ■ ○)**:
on banners, on the urgent to-dos, on the open unit row, on the cards with a state. It's the same
gesture everywhere: *the edge tells you how it is, the text tells you what it is*. The logo is the
same idea: three rails rising (kaizen = continuous improvement). Nothing else in the UI is
decorative.

## Shared components

| Component | Class / file | Notes |
|---|---|---|
| Shell | `header`, `.brand`, `nav .tab` — `App.tsx` | Sticky with blur (solid under *reduced transparency*). Current tab = white raised segment, `aria-current="page"` |
| Side rail (tablet, desktop) | `SideNav` in `App.tsx` | A 64 px rail of icons that slides open (248 px) on hover / focus; Operations' views under it; day / night at the foot. No top bar ≥ 721 px — the screen is the work; Operations shows a one-line crumb instead of its strip |
| Phone tab bar | `.tabbar` + `TabBar` in `App.tsx`, icons in `components/TabIcon.tsx` | ≤ 720 px. Up to 5 tabs; more → 4 + **More** (sheet with the rest). Never scrolls sideways. `--tabbar-h` lifts the SOP button, toasts and the minimised SOP sheet |
| Buttons | `button` (primary), `.secondary`/`.ghost`, `.danger`, `.small`, `.link` | Only these roles get `--control-h`; chips, day cells and row headers keep their own size |
| Fields | `input`, `select`, `textarea`, `label > input` | Border `--line-strong`, focus = accent border + 3 px ring |
| Segmented | `.subtabs .tab` on a tint strip | Current = white raised |
| Filter chips | `.chip`, `.fchip` | On = ink fill |
| Banner | `.banner.ok/.warn/.error` | 4 px rail in the state's colour + 7% tint; the text brings its own glyph |
| Tables | `table`, `th`, `td`, `table.units` | Head in caption UPPERCASE, row hover, tabular numbers |
| Card | `.card` | `--r-md`, `--shadow`, padding 16/24 (16 on a phone) |
| Dialog / sheet | `Modal` (`.modal-backdrop`, `.modal`) | Desktop: centred. Phone: sheet from below with safe-area. ✕ of 36 px |
| Hint | `Hint` (`.hint-q`) | You see 18 px, you tap 44 px (invisible `::after`) |
| Loading | `Loading` (`.loading`) | Determinate bar with the step's name |
| Empty | `.note` + verb | An empty state says what's missing and what to do |

## Icons (no emoji)

Owner feedback (2026-10-14): emoji were noise, each bringing its own colours. Now `src/components/Icon.tsx`:
one set of inline SVGs (24 grid, 1.75 stroke, round joins), **1em, `currentColor`**. An icon takes colour
only when its text does (a red error, an amber flag). The only coloured exceptions are the status shapes
(■ red, ▲ amber, ○ muted) that replaced 🔴 🟠 ⚪.
- `<Icon n="wrench" />` in JSX; `ic(text)` for text that may carry emoji (crew-i18n, label maps, practice
  data) and turns them into icons at render time without touching the strings; `noEmoji()` where an SVG
  can't go (`title`, `placeholder`, `<option>`).
- `EMOJI_ICON` is the map (≈65 emoji → 50 icons). A new emoji in UI copy shows up as an icon if it's in the
  map; if not, add it.
- Kept as text: monochrome glyphs (✓ ✕ ↗ ★ ✎ ▲ ● ☐ ⚑), which are already one colour.
- Not touched: Slack and SMS messages (`src/lib/slack*.ts`, `sms.ts`) — they're outgoing messages, not
  this app's UI. The emoji in `title` attributes and `<option>` were removed (the word remains).
- Field pages (Crew, CleanSteps, FieldReport, Report, Work, InspectionRun, Inspect, Practice,
  AccessBox, PhotoPicker): every text child goes through `ic()`, because their copy reaches them via props
  and arrays.

## Work items: one anatomy, one life cycle (§159)

To-do, work order, purchase order and claim share **one row**: a title line (▸ title · ✎ · ✕ ✓) and **one
quiet line of context** in a fixed order — stage · urgency · date · unit · owner · inside · comments · files ·
where it came from · part of · claim. The category is a **2 px bar** (muted hue: to-do slate, work order
ochre, order teal, claim violet). Colour is spent only on words: "In progress"/"Ordered" in blue, "Done"/
"Purchased" in green, late or urgent in amber.

Life cycle, the same in Kaizen, Slack and the SOPs (`stageOf` / `claimStage` in `src/lib/todos.ts`):
Open → In progress → Done · Cancelled (a comment, or something done inside it, starts it); a purchase order Ordered → Purchased; a claim Open → In progress →
Done (Refunded → "Done · refunded", Dismissed → Cancelled). Hostaway keeps its statuses; only the word changes.

**What opens how** — the rule for every screen:

| It is… | It opens as | Examples |
|---|---|---|
| Detail that explains | **Hover / tap (Peek)** — a short label, the text behind it | "Request from a cleaner", "From Slack", "Details", a reason |
| A flag | **Icon only, word on hover** (`IconFlag`) | inspection, same-day, deep |
| A thing you might want more of | **A link that filters** the list, with a "✕" chip to undo | a listing, an owner |
| A related item you act on | **A pop-up** with its whole card — the list stays where it was | the work order inside a to-do, the claim a repair belongs to |
| A child of the same kind | **In place**, unfolded under its parent | a sub-task, a smaller work order |
| Somewhere else entirely | **A link** (↗) | the Airbnb case, Hostaway |

An open item reads like an iOS settings sheet: what it is about first, then grouped lists (label left, value
right) editable in place, the rarely used fields under "More", one "Unsaved changes" bar.

## Accessibility (quality floor)

- Visible focus on everything (`:focus-visible`, accent ring).
- `prefers-reduced-motion`: no transitions or animations.
- `prefers-reduced-transparency`: header and tab bar opaque.
- Targets ≥ 44 px on a phone (tab bar 52, fields 44, hint 44, SOP button 44).
- Nothing scrolls sideways at 390 (checked with `scripts/screenshot.mjs`).

## Decisions and their reasons

- **Kept**: the light theme by default and the day/night switch. The HIG asks not to have an
  appearance switch inside the app, but it's an owner decision (§20). Recorded, not changed.
- **Blue primary instead of black:** blue already meant "action" (§28). The black button was
  competing with the selected tab and the selected chip.
- **Bottom tab bar on a phone:** the top strip scrolled sideways and hid half the tabs. The ops
  team works with one thumb.
- **Not a brand typeface:** this is an internal tool, read in a hurry. The system face is the
  fastest and the most familiar.
