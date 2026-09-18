-- The cleanings log itself, not just the per-unit rate derived from it.
--
-- The sheet is one row per clean — checkout, unit, cleaner, what they
-- were paid, whether it was a deep clean. That is an operational record
-- worth seeing, and the median rate the importer already computes throws
-- nearly all of it away.
CREATE TABLE cleanings (
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  -- The reservation it followed, when the sheet has one. It is the only
  -- genuinely unique thing on a row: two units can be cleaned on the
  -- same day, and one unit can be cleaned twice.
  key         TEXT   NOT NULL,
  unit_id     TEXT,
  unit_name   TEXT   NOT NULL,
  checkout_on DATE   NOT NULL,
  cleaner     TEXT,
  guest       TEXT,
  -- What the cleaner was PAID. Null when the sheet has no figure yet —
  -- "not priced" and "free" are different facts.
  price       NUMERIC(12,2),
  deep        BOOLEAN NOT NULL DEFAULT FALSE,
  urgency     TEXT,
  notes       TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

CREATE INDEX cleanings_date_idx ON cleanings (account_id, checkout_on DESC);
CREATE INDEX cleanings_unit_idx ON cleanings (account_id, unit_id, checkout_on DESC);
