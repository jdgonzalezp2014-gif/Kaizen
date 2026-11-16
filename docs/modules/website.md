# Module: website (public site + /reservations)

The official public site of Kaizen Guest Properties. **Separate repo**, not part of Kaizen OS:
`dcheung1/kaizenguestproperties` (owner's partner account), cloned at
`/home/carbon/proyectos/kaizen-website` (clone over SSH: `git@github.com:dcheung1/kaizenguestproperties.git`).
Branch `main`, 57 commits as of 2026-11-08 (last `fa78139` "Update site info for publish").

## What it is today

- Built in **Lovable** (Vite + React 18 + TS + shadcn/Tailwind + framer-motion). Lovable
  auto-commits to `main`, and anything pushed to `main` shows up in Lovable — **a push is
  live work on their site**, treat it like a deploy.
- Routes (`src/App.tsx`): `/`, `/corporate-housing`, `/landlords`, `/management-partners`,
  `/book-now` (2 s animation then redirect to the Hostaway booking engine
  `https://kaizen.holidayfuture.com/`), `/contact`, `*` NotFound.
- Backend: Lovable Cloud = Supabase project `eoqpamcxdunjdfwmpzdz`; one edge function
  `supabase/functions/chat` (site chat widget, Lovable AI gateway, `google/gemini-3-flash-preview`,
  `LOVABLE_API_KEY`). `.env` holds only the public Supabase URL/publishable key.
- `STUDENT_PROMPT_TEMPLATE.md` / `public/student-template.html` are a course template the
  owner's partner made from the site; not ours, leave alone.

## Plan (agreed 2026-11-08) — step by step, with caution

1. **Hidden `/reservations` route** that is ours: a client/guest section to build and test
   there, with no link from the site until launch. Later a button (likely Book Now) points to it.
2. It shares **Neon** with Kaizen OS (project `frosty-math-62141251`) to read the same data —
   reads first, through a narrow API, never the site writing straight into OS tables.
   Mind the Neon free-compute quota (see platform / the 2026-10-24 outage).
3. Everything else on the site stays as it is. Small commits, nothing pushed without the
   owner's go-ahead.

## Open items

- Not started: nothing generated yet (owner said "todavía no").
- Decide how `/reservations` reaches Neon: a Kaizen OS endpoint (`/api/...` on Pages,
  CORS for the site's domain) vs a Supabase edge function with its own Neon role. Leaning
  OS endpoint: one place for rules and secrets.
- Checked 2026-11-15: live domain **kaizenguestproperties.com** (www → apex, Cloudflare in front, Lovable hosting). The live
  build is still `fa78139` (Mar 2026); `main` = origin, we can push. **kaizen-properties.com is another company** (real-estate
  investors) — never use it. `package-lock.json` is out of sync (Lovable uses bun): build locally with
  `npm install --no-package-lock && npm run build` (builds clean). Whether a push to main publishes or needs Lovable's "Publish": still unknown.
- Guest portal on the site (owner, 2026-11-15): link `/reservations/<hostaway id>-<short code>`; portal code stays in Kaizen OS.
