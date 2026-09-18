-- Per-platform listing state and rating.
--
-- A TABLE rather than columns on price_observations, because the point
-- is that adding Marriott or a direct portal later should be a row, not
-- a migration — and because a rating is current state, not a series. The
-- series lives in price_observations; this is "what does each platform
-- say about this unit right now".
--
-- Primary key is (account, unit, platform): re-importing a feed updates
-- in place instead of accumulating one row per poll.
CREATE TABLE listing_platforms (
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  unit_id     TEXT   NOT NULL,
  platform    TEXT   NOT NULL,
  -- Whether the unit is published there. Nullable on purpose: unknown
  -- is a third state, and false would claim we checked and it was not.
  listed      BOOLEAN,
  url         TEXT,
  -- Always on a 5-point scale. Booking and Expedia print out of 10, and
  -- an 8.6 left raw sits beside an Airbnb 4.8 and reads as a far better
  -- property. The conversion happens before it is stored, once.
  rating      NUMERIC(3,2) CHECK (rating IS NULL OR (rating > 0 AND rating <= 5)),
  reviews     INTEGER,
  source      TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, unit_id, platform),
  FOREIGN KEY (account_id, unit_id) REFERENCES units (account_id, id)
);

CREATE INDEX listing_platforms_unit_idx ON listing_platforms (account_id, unit_id);
