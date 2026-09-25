# Kaizen OS

Short-term-rental management for a ~27-unit portfolio. Measures **profit per unit** rather than
occupancy, shows which units are mispriced against comparable units in the same portfolio, lets
the team record costs and claims, and alerts by SMS when something needs a decision.

## Stack

| Layer | Choice |
|---|---|
| Repo, scheduled jobs | GitHub + Actions |
| App + API | Next.js on Vercel |
| Database | Neon (Postgres) |
| Auth | Auth.js, Google provider |
| SMS | QUO (formerly OpenPhone) |
| Domain / DNS | Cloudflare |

All free tiers. See `CONTEXT.md` §2a for the one licensing caveat worth knowing.

## How it fits together

```
GitHub Actions ──► scheduled sync, scrape, alerts
                          │
Next.js on Vercel ────────┤
   app/        dashboards │
   app/api/    the only place secrets are read
   src/lib/    pure analytics — no network, no framework
                          │
          ┌───────────────┴───────────────┐
    Hostaway API                    Neon Postgres
    listings, calendar,             costs, claims,
    reservations (live)             observations, decisions
```

**Hostaway owns what Hostaway knows.** Listings, calendars and reservations are fetched live —
caching them only adds staleness and a refresh nobody remembers. Postgres holds what Hostaway
has never heard of: what the lease costs, what guests complained about, what we observed, and
what we decided.

**Secrets never reach the browser.** They are read only inside `app/api/**` and in Actions. A
client-side call to Hostaway would ship full read/write on bookings and guest data in the JS
bundle.

**Ranges are computed in the browser.** The app fetches once per session and recomputes every
date range locally, so dragging a range redraws instantly rather than waiting on a round trip.

## Layout

```
CONTEXT.md          Architecture, decisions, and state — read this first
src/lib/            Pure analytics: proration, ranges, chart series, Hostaway client
db/migrations/      Plain SQL, applied in order
docs/               Client spec, source notes, reference material
```

## Testing

```bash
node src/lib/finance.test.ts
```

Node runs TypeScript directly, so there is no build step to run a test.

## Status

Early — `CONTEXT.md` §11 has the build order. The analytics core and the Hostaway client are
written and tested; the Next.js app is not scaffolded yet.

## Operations and Repository

The operations sheet ("daily file") and the Data Repository are read from
inside the app, read-only, as the **Operations** and **Repository** tabs.
`CONTEXT.md` §63 has the design and the setup steps.

## Provenance

Built on a working Apps Script panel already running against the live Hostaway account. The
proration rules, the Airbnb scraping ladder, the SMS character handling and the pricing decision
log all originate there — see `CONTEXT.md` §9 for what carried over and the behaviours that were
expensive to learn.
