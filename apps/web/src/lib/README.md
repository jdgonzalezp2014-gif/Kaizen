# `lib/` — the analytical core

Pure TypeScript, no React, no network. Every number on every screen comes from here, which is
what makes dragging a date range instant: nothing asks a server.

| File | Owns |
|---|---|
| `dates.ts` | `yyyy-MM-dd` string arithmetic. Never a `Date` object — see the note at the top of the file |
| `finance.ts` | Proration. What a stay and a cost row contribute to a window |
| `ranges.ts` | Presets, and how a span becomes chart buckets |
| `series.ts` | Buckets → chart points, and the scoreboard |

## The rules worth not rediscovering

- **A stay crossing the window boundary is split**, not counted twice and not dropped.
- **A $0 payout is an occupancy fact, not a revenue one.** iCal blocks and owner stays report no
  payout while the listing's default cleaning fee still resolves; subtracting one from the other
  produced negative revenue in the original. The nights still count.
- **A shared cost is divided by the full unit count**, even when you are looking at one unit. A
  unit's share of the accountant does not grow because you drilled into it.
- **Monthly targets must be scaled to the period.** Eleven days against a month's target is a
  guaranteed red that means nothing.
- **Partial buckets are flagged, not hidden.** The last week of a range ending today is still
  filling; plotted beside complete ones it makes every chart fall off a cliff at the right edge.
- **Rates are recomputed from totals, never averaged from per-unit rates.**

## Testing

```
node apps/web/src/lib/finance.test.ts
```

Node runs TypeScript directly (24.x), so there is no build step to run a test. The tests exist
to pin this against `apps-script/Finance.js` — see `CONTEXT.md` §2c for why the arithmetic
deliberately exists twice and what keeps the two honest.
