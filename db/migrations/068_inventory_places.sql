-- Inventory by place (§150). Supplies are kept only in places — a storage
-- (a Storage row of the Repository's Units tables) or a house's own closet
-- (the house's record) — never in each unit. Which place a unit draws from is
-- the Repository's `storage` column, the one source; here only what happened.
--
-- `place` = the Repository record `table/ROW-id` the move happened in, written
-- when it happens: moving a unit to another storage later leaves its past
-- where it was. NULL = a unit with no place at the time (shown ▲). `unit_id`
-- stays: the unit a `taken` went to, or that reported. Filled for the existing
-- rows by a one-off script (it needs the Repository's name matching).
ALTER TABLE inventory_moves ADD COLUMN place TEXT;
CREATE INDEX inventory_moves_place_idx ON inventory_moves (account_id, item_id, place, created_at);

-- The minimum to keep of an item in one place; none = the item's `reorder_at`.
CREATE TABLE inventory_place_mins (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  item_id    BIGINT NOT NULL REFERENCES inventory_items(id),
  place      TEXT   NOT NULL,
  min_qty    NUMERIC(10,2) NOT NULL CHECK (min_qty >= 0),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, item_id, place)
);
