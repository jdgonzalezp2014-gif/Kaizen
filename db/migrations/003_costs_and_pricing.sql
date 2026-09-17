-- Kaizen OS — fixed costs per month, unit-scoped costs, and price actions
--
-- Three things this adds, all of which existed only as a shape the old
-- spreadsheet implied:
--
--   1. A fixed cost is a LINE that recurs, not an amount that repeats.
--      Electricity is a line; $214 is what it happened to be in August.
--      Without a label there is no way to say "this month's electricity"
--      and the only way to change an amount was to end-date the row and
--      start another, which loses the history you wanted to keep.
--
--   2. The cleaning fee, which is the one number still coming from the
--      old Google Sheet.
--
--   3. A price action: what the rate was, what it became, why, and
--      whether it actually reached Hostaway. Recording the intent and
--      recording the push are separate facts — a decision that failed to
--      apply is the single most misleading thing this table could
--      silently contain.

-- ── 1. fixed cost lines ──────────────────────────────────────────────
-- A recurring line is identified by (account, label, unit_id). Each
-- month gets its own row, so a month can be customised without touching
-- any other month and last year's figures never move retroactively.
ALTER TABLE expenses ADD COLUMN label TEXT;

-- Backfill: existing monthly rows become lines named after their
-- category, which is the only name they ever had.
UPDATE expenses SET label = category WHERE label IS NULL AND frequency = 'Monthly';

-- One row per line per month. Without this, "carry forward" run twice
-- doubles every fixed cost — and it WILL be run twice, because the
-- button does not look like it did anything the first time.
CREATE UNIQUE INDEX expenses_monthly_line_idx
  ON expenses (account_id, label, COALESCE(unit_id, ''), start_date)
  WHERE frequency = 'Monthly' AND label IS NOT NULL;

-- ── 2. cleaning fee ──────────────────────────────────────────────────
-- Per unit, because it is per unit. Nullable: an unknown cleaning fee
-- must read as unknown, never as zero, or every unit's net is overstated
-- by one cleaning per booking and the dashboard looks great.
ALTER TABLE units ADD COLUMN cleaning_fee        NUMERIC(12,2);
ALTER TABLE units ADD COLUMN cleaning_fee_source TEXT;  -- 'sheet' | 'manual'
ALTER TABLE units ADD COLUMN cleaning_fee_at     TIMESTAMPTZ;

-- Where the cleaning figures come from, per tenant. A published-CSV URL
-- rather than an API client: it needs no OAuth, no service account and
-- no secret, and every host can point at their own sheet.
ALTER TABLE accounts ADD COLUMN cleanings_csv_url TEXT;

-- The forward window this account studies by default. "Next 30 days"
-- is a habit, not a law; a host with 90-day lead times needs 90.
ALTER TABLE accounts ADD COLUMN fwd_study_days INTEGER NOT NULL DEFAULT 30;

-- ── 3. price actions ─────────────────────────────────────────────────
-- pricing_decisions was shaped around DETECTING a change someone made in
-- Hostaway. These columns let it also hold a change made deliberately
-- here, with the evidence that prompted it.
ALTER TABLE pricing_decisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'detected'
  CHECK (origin IN ('detected','manual','agent'));

ALTER TABLE pricing_decisions ADD COLUMN base_rate      NUMERIC(12,2);
ALTER TABLE pricing_decisions ADD COLUMN discount_pct   NUMERIC(5,2);
ALTER TABLE pricing_decisions ADD COLUMN discount_kind  TEXT
  CHECK (discount_kind IN ('window','weekly','monthly'));

-- The nights the action covers. For a length-of-stay discount these are
-- the window it was aimed at, not a restriction Hostaway enforces.
ALTER TABLE pricing_decisions ADD COLUMN window_start DATE;
ALTER TABLE pricing_decisions ADD COLUMN window_end   DATE;

-- The evidence, frozen. Recomputing "was this unit slow?" from today's
-- calendar months later gives the answer AFTER the discount worked,
-- which is precisely backwards for training on it.
ALTER TABLE pricing_decisions ADD COLUMN occupancy_at  NUMERIC(5,4);
ALTER TABLE pricing_decisions ADD COLUMN nights_open   INTEGER;
ALTER TABLE pricing_decisions ADD COLUMN nights_total  INTEGER;

ALTER TABLE pricing_decisions ADD COLUMN actor TEXT;   -- the signed-in email
ALTER TABLE pricing_decisions ADD COLUMN note  TEXT;

-- Did it actually reach Hostaway? Three states, and the difference
-- matters: never attempted, applied, or attempted and failed.
ALTER TABLE pricing_decisions ADD COLUMN push_status TEXT NOT NULL DEFAULT 'none'
  CHECK (push_status IN ('none','applied','failed','partial'));
ALTER TABLE pricing_decisions ADD COLUMN pushed_at   TIMESTAMPTZ;
ALTER TABLE pricing_decisions ADD COLUMN push_detail TEXT;

CREATE INDEX decisions_window_idx ON pricing_decisions (account_id, window_start, window_end);
