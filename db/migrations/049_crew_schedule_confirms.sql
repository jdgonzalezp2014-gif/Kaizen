-- The schedule as the team last confirmed it (§122). Cleaners see when
-- that was, and every movement since — a stay extended or cut short, a
-- booking cancelled, a clean given to someone else, a new one — measured
-- against this snapshot, never against a guess.
CREATE TABLE crew_schedule_confirms (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  -- The last day the confirmation covers; a clean after it is "not confirmed yet".
  through      DATE   NOT NULL,
  -- [{key, cleaner, date, unit, time}] — every assigned clean from today to `through`.
  snapshot     JSONB  NOT NULL,
  confirmed_by TEXT   NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crew_schedule_confirms_idx ON crew_schedule_confirms (account_id, id DESC);
