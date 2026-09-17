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
| Hosting, SSL, CDN | Vercel (static) | free |
| Domain | not yet — Vercel's free URL covers the demo | — |
| Auth | Google Identity Services | free |
| SMS | QUO (OpenPhone) | existing client account |

No server, no container, no managed database, nothing to keep patched.

## How it fits together

Google Apps Script already holds the Hostaway credentials, runs on a timer, scrapes Airbnb for
live prices and ratings, prorates costs and revenue, and sends SMS. Deploying that same script
as a Web App turns it into a JSON API at no extra cost. The web app is a static React build that
reads that API and renders it.

```
Hostaway ──► Apps Script ──► Google Sheets ──► doGet() JSON ──► React (Vercel)
                  │
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
