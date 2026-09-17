# Source notes

## Developer's handwritten sketch (the actual brief)

This is the scope that governs. The client's PDF is broader; where they disagree, this wins.

```
Hostaway ──────────────► historical data
Web App  ──────────────► Track · Projections · Agentic ops
                                    │
                         ┌──────────┴───────────┐
                         │   Market Research    │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┼──────────────┐
              Web scraping        Alert      Monitoring &
              · ratings                      record for training
              · price

Operational insights
    │
    └── Expenses
          ├── Fixed ────── lease, internet, etc.
          └── Variable ─── handyman, maintenance, damages, any possible
    └── Cleanings ──────── Google Sheets (daily)
```

**What this tells us that the PDF does not:**

- Cleanings are tracked **daily in a Google Sheet** and that is fine. It does not need a UI.
- Expenses split **fixed vs variable** — already how `💸 Costs` / `🏠 Fixed Monthly Costs` work.
- "Monitoring & record for training" is the decision log. Already built in `Decisions.js`.
- Market research is a **branch**, not the trunk. Scraping feeds alerts; it does not feed the
  core profit number.

## Client's PDF spec — what to take and what to leave

`kaizen-os-spec.pdf` (v1.0, Sept 2026). A good spec for a funded build with a team.

**Take:**

- *Profit is the verdict.* Occupancy and rate are diagnosis. Every screen ends in a profit number.
  86.7% occupancy against a 60.7% market while holding $63-RevPAR units is exactly the failure
  the panel already surfaces.
- *Alert on change, not state.* "Still 0%, tenth straight day" teaches people to ignore alerts.
  Fire once on begin, once on resolve.
- *Capture judgement, then automate.* The decision log. Already built.
- *Two failure patterns:* low profit + low occupancy = demand problem; low profit + high
  occupancy = underpriced. Cheap to compute, genuinely useful.
- *Forward ADR well below trailing 90-day while heavily booked = a rate failure, not a win.*
  Needs `Booked On` in the ledger, which is already being captured.
- *Visual layer last.* A polished dashboard over an unvalidated pipeline invites trust that has
  not been earned.

**Leave for now:**

- Outbound CRM (backfill → source → sequence). Whole product on its own.
- Review case tracker with dispute deadlines. Needs per-platform review APIs we do not have.
- Channel live/dark matrix probed every 2 hours. Costly, and the panel already flags listings
  that are not exported.
- Per-role WhatsApp routing with delivery receipts. QUO sends SMS today; routing by role is a
  later refinement.
- Cohort benchmarking with an L1–L3 fallback ladder — the peer grouping in `PriceSuggest.js`
  already does the useful half of this.

**Note on the numbers in the PDF:** it says 22 live units × $1,500/mo. The live Hostaway account
currently returns 27 listings. Confirm which is current before putting a target on a screen.
