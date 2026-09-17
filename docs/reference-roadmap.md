# Deliberately unbuilt

Features considered and not built, with the criteria that would justify building
them — recorded so the decision is not re-litigated, and so whoever builds one
starts from the design rather than a blank file.

This used to be `Roadmap.js`: a module of comments plus a **🗺️ Planned** menu
whose every entry opened a dialog explaining that nothing would happen. The
reasoning was worth keeping. Shipping it as script that loads into a spreadsheet
was not.

---

## Discount audit — not built, and the next thing worth building

Cheap and useful now. The `Discounts` column on 📊 Dashboard already carries
Hostaway's weekly and monthly factors, so a small report could flag:

- listings quoting a **30-night stay with no monthly discount set** — a direct
  mismatch between how the unit is being sold and what is being sold;
- listings whose **minimum stay is longer than their next available gap**, which
  cannot be booked at any price.

No scraping, no model call, no new credentials — all of it is Hostaway data
already on the sheet. That is what makes it the next thing to build rather than
the most interesting one.

---

## Market study — since built, see `Market.js`

Implemented on request, **despite** the objection below, which is kept because it
is still true and still the reason to read the output carefully.

> Airbnb search only returns listings **still available** for the dates.
> Everything already booked is invisible, so the median of those results is the
> median of unsold inventory. Pricing against it drags you toward a floor set by
> other hosts' failures.

Two tools do this better than scraping can, and are worth checking before
trusting a row:

- **Airbnb host multicalendar** → select the dates → *Compare similar listings*
  gives booked and unbooked ranges **separately**, which cannot be reconstructed
  from search results.
- **PriceLabs** → Market Research / Neighborhood data is a dedicated product for
  exactly this.

The bias is called out on the 🧭 Market Study sheet itself rather than buried
here.

### The three measures originally wanted

1. **Absorption** — comparable supply with dates versus without. High absorption
   while your listing sits empty is a you-problem; low absorption means nobody
   nearby is booking and price will not fix it. *This is the honest one.*
   **Built, then removed** — it cost an extra reader fetch and model call per
   type (roughly a quarter of the module's spend) to produce a percentage that
   no rule and no alert read. If it returns, it should return as an input to a
   decision, not as a column.
2. **Competitive set** — what the still-available listings ask. Biased low, but
   it is the right comparison when chasing leftover demand on a red listing.
   **This is what the module reports today.**
3. **Clearing prices** — weekly snapshots of the available set. A comp that
   disappears has probably booked at its last asking price, and weeks of that
   builds the distribution search cannot show directly. **Not built** — it needs
   the study to run on a schedule and keep history, which is a deliberate step
   past today's on-demand model.

---

## Pricing rules — since built, see `PriceSuggest.js`

Implemented exactly to the criteria below. PriceLabs is still the system actually
watching demand, seasonality and comps continuously; this is a second,
transparent opinion, not a replacement, and it never writes anywhere on its own.

The original objection stands: a rule engine here is second-guessing a system
with far more inputs, and any price it wrote would be overwritten on PriceLabs'
next run. The defensible version is advisory — **say which lever to pull, never
pull it.**

**Trigger** — only consider a listing when both are true:

| | |
|---|---|
| `urgency >= YELLOW_THRESHOLD` | a near, real gap |
| `occupancy < OCC_FLOOR` | a thin book, not one hole |

**Direction** — decided by market position, not by vacancy alone:

| Position | Read |
|---|---|
| above market, +15% or more | price is the lever — suggest a cut |
| at market, ±15% | **not a pricing problem.** Photos, reviews, minimum stay, or genuine low season. Cutting burns margin without fixing anything |
| below market, −15% or worse | already cheapest and still empty. Cutting further is the single most expensive mistake available here |

**Magnitude** — proportional, capped, floored:

```
cut = min(PRICE_MAX_CUT_PCT, (urgency − yellow) / 40)
      +5 points if occupancy is under the floor
      +5 points if more than 10% above market
      never below the PriceLabs minimum price
      changes under 2% are not worth making
```

**Discounts** — a separate lever, and often the better one for gaps. Not built:

- **Orphan gaps shorter than the minimum stay cannot be sold at any price.**
  Lower the minimum stay for that window instead of touching the rate.
- **Length-of-stay discounts** fill 30-night blocks without moving the nightly
  rate, so they do not reprice the whole calendar.
- **Last-minute discounts** inside the half-life window are what the urgency
  score already measures — the natural place for an automatic rule, if one is
  ever wanted.

**Safety** — non-negotiable, and unchanged now that it is built:

- suggestions land in a sheet with a human APPROVE column;
- nothing is pushed without an explicit confirmation dialog;
- no time-based trigger on a push, ever;
- every suggestion carries its reasoning in plain words.
