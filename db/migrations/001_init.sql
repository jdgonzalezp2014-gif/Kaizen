-- Kaizen OS — initial schema
--
-- Everything Hostaway already owns (listings, calendar, reservations) is
-- fetched live and deliberately NOT stored here. What lives in this
-- database is what Hostaway has never heard of: what things cost, what
-- guests complained about, what we observed, and what we decided.
--
-- Money tables are append-only. A retry, a double-tapped button or a lost
-- response costs a visible duplicate rather than a silently rewritten
-- figure, and last month's dashboard stays reproducible.

-- ── units ────────────────────────────────────────────────────────────
-- A thin mirror of Hostaway listings. Not the source of truth: it exists
-- so expenses and claims can carry a foreign key that survives a listing
-- being renamed, and so a unit removed from Hostaway does not orphan its
-- history.
CREATE TABLE units (
  id              TEXT PRIMARY KEY,            -- Hostaway listing id, as text
  name            TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  bedrooms        INTEGER,
  bathrooms       NUMERIC(4,1),
  capacity        INTEGER,
  unit_type       TEXT,                        -- Apartment | House | … see CONTEXT §9
  pool_type       TEXT,                        -- None | Shared | Private
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── expenses ─────────────────────────────────────────────────────────
-- Both the monthly baseline (lease, utilities) and dated one-offs. One
-- table, because the only real difference is `frequency` and splitting
-- them meant two places to look for "what did this cost".
CREATE TABLE expenses (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         TEXT REFERENCES units(id),   -- NULL = shared across all active units
  shared          BOOLEAN NOT NULL DEFAULT FALSE,
  start_date      DATE NOT NULL,
  end_date        DATE,                        -- NULL = open-ended
  category        TEXT NOT NULL DEFAULT 'General',
  frequency       TEXT NOT NULL DEFAULT 'One-time'
                  CHECK (frequency IN ('One-time','Monthly')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  -- Carried from day one and used by nobody yet. Walmart/Amazon invoice
  -- import is explicitly wanted later; a column added before there is
  -- data is free, and added after is a migration.
  source          TEXT,                        -- 'manual' | 'walmart' | 'amazon' | …
  external_ref    TEXT,                        -- invoice/order id, for dedupe on import
  notes           TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An import must never insert the same invoice line twice, however many
-- times it is retried. Partial index so manual rows (no ref) are unconstrained.
CREATE UNIQUE INDEX expenses_external_ref_idx
  ON expenses (source, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE INDEX expenses_window_idx ON expenses (start_date, end_date);
CREATE INDEX expenses_unit_idx   ON expenses (unit_id);

-- ── claims ───────────────────────────────────────────────────────────
CREATE TABLE claims (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         TEXT REFERENCES units(id),
  occurred_on     DATE NOT NULL,               -- when the guest raised it, not when it was fixed
  category        TEXT,
  -- Weighted 1/2/4/8 in the claim index. A plain count ranks five
  -- slow-wifi complaints above three midnight lockouts.
  severity        TEXT NOT NULL DEFAULT 'Medium'
                  CHECK (severity IN ('Low','Medium','High','Critical')),
  status          TEXT NOT NULL DEFAULT 'Open'
                  CHECK (status IN ('Open','In progress','Resolved','Refunded','Dismissed')),
  source          TEXT,                        -- Airbnb | Booking.com | Direct | …
  description     TEXT,
  refund          NUMERIC(12,2) NOT NULL DEFAULT 0,
  repair_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,
  resolved_on     DATE,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX claims_unit_date_idx ON claims (unit_id, occurred_on);

-- ── price_observations ───────────────────────────────────────────────
-- What we saw, when we saw it. Written by the scheduled scrape.
-- Append-only by design: this is the time series a pricing model would
-- learn from, and it can only be captured while it is true.
CREATE TABLE price_observations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         TEXT NOT NULL REFERENCES units(id),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start    DATE,                        -- the stay these prices are for
  stay_nights     INTEGER,
  hostaway_rate   NUMERIC(12,2),               -- our rate, no fees, no tax
  airbnb_rate     NUMERIC(12,2),               -- what a guest is quoted, fees and tax included
  airbnb_rating   NUMERIC(3,2),
  airbnb_reviews  INTEGER
);

CREATE INDEX price_obs_unit_time_idx ON price_observations (unit_id, observed_at DESC);

-- ── pricing_decisions ────────────────────────────────────────────────
-- The loop that earns an agent its autonomy: observe → a human acts →
-- record the outcome → propose the rule. `context` is jsonb because what
-- is worth capturing at decision time will change, and a schema change
-- per new signal would guarantee it stops being captured.
CREATE TABLE pricing_decisions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id         TEXT NOT NULL REFERENCES units(id),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  basis           TEXT,                        -- 'window' | 'avg30' — which price moved
  old_price       NUMERIC(12,2),
  new_price       NUMERIC(12,2),
  direction       TEXT CHECK (direction IN ('up','down')),
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggested       TEXT,                        -- what the system had advised, if anything
  alignment       TEXT,                        -- followed | contrary | independent
  -- The only column that separates a good decision from a confident one.
  outcome         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending','booked','expired empty','no open gap')),
  watched_dates   DATE[],                      -- the nights that were empty when it was made
  days_to_book    INTEGER,
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX decisions_unit_time_idx ON pricing_decisions (unit_id, detected_at DESC);
CREATE INDEX decisions_pending_idx   ON pricing_decisions (outcome) WHERE outcome = 'pending';

-- ── app_config ───────────────────────────────────────────────────────
-- Settings a human changes without a deploy: the per-unit net target,
-- QUO recipients, alert thresholds.
CREATE TABLE app_config (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_config (key, value, updated_by) VALUES
  ('TARGET_NET_PER_UNIT', '1500', 'seed'),
  ('OCC_FLOOR_PCT',       '60',   'seed'),
  ('STAY_NIGHTS',         '30',   'seed');
