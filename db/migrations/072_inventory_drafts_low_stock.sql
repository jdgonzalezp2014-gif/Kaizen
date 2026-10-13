-- The order being written, kept as a DRAFT (§150, owner): whoever reviews the
-- inventory saves it and comes back; it becomes a to-do only when created.
-- One per account — the order the team is working on.
CREATE TABLE inventory_order_drafts (
  account_id BIGINT PRIMARY KEY REFERENCES accounts(id),
  lines      JSONB  NOT NULL,          -- [{ itemId, place, qty }]
  for_todo   BIGINT,
  saved_by   TEXT   NOT NULL,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A to-do on its own when a counted place falls below its minimum — switched
-- on or off in Setup → Inventory (off until the places are counted).
ALTER TABLE accounts ADD COLUMN inventory_low_stock_tasks BOOLEAN NOT NULL DEFAULT FALSE;
-- The open "Low stock at <place>" to-do of a place: one at a time, never a duplicate.
ALTER TABLE todos ADD COLUMN low_stock_place TEXT;
