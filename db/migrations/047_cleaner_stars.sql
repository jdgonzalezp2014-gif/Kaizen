-- Assignment by stars (§121) replaces the high/mid/low tier rule.
--
-- Each clean REQUIRES a number of stars (from the next guest's nightly
-- price, the outgoing stay's length and a same-day turnover); each
-- cleaner HAS stars, set by hand. The cheapest cleaner who meets the
-- stars, covers the unit and still has room that day is the one picked.

-- Seeded from the tier so the first day under stars starts where the
-- tiers were: high ★5, mid ★3, low ★2. A person adjusts them in Setup.
ALTER TABLE cleaners ADD COLUMN stars SMALLINT NOT NULL DEFAULT 3 CHECK (stars BETWEEN 1 AND 5);
UPDATE cleaners SET stars = CASE tier WHEN 'high' THEN 5 WHEN 'mid' THEN 3 ELSE 2 END;

-- Zones the cleaner covers: a building prefix ("CL", "P2") or "Houses".
-- Empty is EVERY zone — what every cleaner covered before this column.
ALTER TABLE cleaners ADD COLUMN zones TEXT[] NOT NULL DEFAULT '{}';

-- At most this many cleans a day. NULL is no limit, never zero.
ALTER TABLE cleaners ADD COLUMN max_per_day SMALLINT CHECK (max_per_day IS NULL OR max_per_day > 0);

-- Which rule decides. Tiers stay in charge until the stars have been
-- watched side by side on the board; switching is a Setup decision.
ALTER TABLE accounts ADD COLUMN assign_rule TEXT NOT NULL DEFAULT 'tiers'
  CHECK (assign_rule IN ('tiers', 'stars'));
