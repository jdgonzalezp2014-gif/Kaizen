# Kaizen OS

Short-term-rental management for a ~27-unit portfolio. Measures **profit per unit** rather than
occupancy, flags units that are mispriced against comparable units in the same portfolio, tracks
costs and guest claims, and sends SMS alerts when something needs a decision.

## Running cost: $0

| Layer | Service | Cost |
|---|---|---|
| Ingestion, scheduling, alerts | Google Apps Script | free |
| Database | Google Sheets | free |
| API | Apps Script Web App (`doGet`) | free |
| Hosting, SSL, CDN | Vercel or Cloudflare Pages (static) | free¹ |
| Domain | not yet — Vercel's free URL covers the demo | — |
| Auth | Google Identity Services | free |
| SMS | QUO (OpenPhone) | existing client account |

¹ Vercel's free Hobby plan is licensed for non-commercial use; Cloudflare Pages' free tier
permits commercial use. See `CONTEXT.md` §2bb before committing to a host.

No server, no container, no managed database, nothing to keep patched.

## How it fits together

Reservations, listings and calendars come **live from the Hostaway API** — they are Hostaway's
data and caching them only adds staleness. Costs, claims, scraped Airbnb prices and the pricing
decision log live in Google Sheets, because Hostaway has never heard of any of them and the team
enters two of them by hand.

Apps Script is what sits between. It already holds the Hostaway credentials, already runs on a
timer and already sends SMS; deploying it as a Web App makes it the API too. The Hostaway key
never reaches the browser — a static site calling Hostaway directly would ship full read/write
access to the account in its JS bundle.

The front end is a static React build. It fetches once per session and computes every date range
in the browser, so dragging a range redraws instantly instead of waiting on a server.

```
                  ┌── live ──► listings, calendar, reservations
Hostaway ──► Apps Script ──┤
                  │        └── Sheets ──► costs, claims, scraped prices, decisions
                  │
                  ├──► doGet() JSON ──► React (static host)
                  └──► QUO / SMS alerts
```

## Security

Financial data is never on a public URL. The API is deployed to execute **as the signed-in user**
and is reachable only by Google accounts on an allowlist; Google performs the authentication.
"Publish to web" CSV is deliberately not used.

## What it does

**Analytics.** Profit per unit for any period, against a target that is *computed* — active units
× per-unit net — rather than hardcoded, so taking a unit offline moves the target instead of
making the portfolio look like it missed.

**Entry.** The team records expenses and claims from the app. Writes are append-only: a retry
cannot corrupt a row that already exists, and every row carries who entered it and when.

Everything else — outbound CRM, review disputes, channel probing — is deliberately out of scope.
See `CONTEXT.md` §2a.

## Repository layout

```
CONTEXT.md        Architecture, decisions, and state — read this first
README.md         This file
apps/web/         React + TypeScript + Vite front end
apps-script/      The Google Apps Script backend (clasp project)
docs/             Client spec, notes, reference material
```

## Status

Early. `CONTEXT.md` §9 has the build order and what is done.

## Provenance

Built on a working Apps Script panel (`price-monitor`) already running against the live Hostaway
account. The proration engine, Airbnb price/rating scraping, SMS character handling and the
pricing decision log all carry over from it.
