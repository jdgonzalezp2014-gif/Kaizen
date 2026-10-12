-- "What I took" is what LEFT THE STORAGE for a clean (§134, the owner): not
-- what was already in the house. A `taken` move comes out of the storage and
-- names the unit it went to (unit_id) and the clean (cleaning_key) — so the
-- storage's stock goes down, the unit's record does not change, and what each
-- clean takes is what the next orders are forecast from.
ALTER TABLE inventory_moves DROP CONSTRAINT inventory_moves_kind_check;
ALTER TABLE inventory_moves ADD CONSTRAINT inventory_moves_kind_check
  CHECK (kind IN ('count', 'used', 'purchase', 'adjust', 'missing', 'taken'));

-- Saying what was taken is a required step of a clean: lines of `taken`, or
-- an explicit "nothing from the storage" — never just skipped.
ALTER TABLE clean_records ADD COLUMN supplies_at   TIMESTAMPTZ;
ALTER TABLE clean_records ADD COLUMN supplies_by   TEXT;
ALTER TABLE clean_records ADD COLUMN supplies_none BOOLEAN NOT NULL DEFAULT FALSE;
