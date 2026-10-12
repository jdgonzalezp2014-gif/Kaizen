-- Inventory, the foundations (§134). Supplies the units run on — coffee,
-- toilet paper, soaps, trash bags — kept per unit and in a central storage.
-- Nothing is stored as "the stock": every event is a move, and the stock is
-- the last count plus what came in minus what was used since. That is what
-- lets the manager reconcile — a count shows how far the record had drifted.

CREATE TABLE inventory_items (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  name       TEXT   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  category   TEXT   NOT NULL DEFAULT 'other' CHECK (category IN ('kitchen', 'bathroom', 'cleaning', 'linens', 'other')),
  -- How it is counted: unit, roll, pack, bottle, box…
  measure    TEXT   NOT NULL DEFAULT 'unit',
  -- Used per clean, as a starting estimate; real reports replace it once there are some.
  per_clean  NUMERIC(10,2),
  -- Keep at least this many in a unit; below it, it is to order.
  reorder_at NUMERIC(10,2),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inventory_items_name_idx ON inventory_items (account_id, lower(name));

-- Every event. unit_id NULL = the central storage.
--   count     the quantity actually there (absolute) — a manager's count resets the record
--   used      taken for a clean (positive number)
--   purchase  bought and put there (positive number)
--   adjust    a correction, + or −
--   missing   someone did not find what the record says: an observation (qty = what they found);
--             it does not change the stock, it asks for a count
CREATE TABLE inventory_moves (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  item_id      BIGINT NOT NULL REFERENCES inventory_items(id),
  unit_id      TEXT,
  kind         TEXT   NOT NULL CHECK (kind IN ('count', 'used', 'purchase', 'adjust', 'missing')),
  qty          NUMERIC(10,2) NOT NULL,
  cleaning_key TEXT,
  cost         NUMERIC(10,2),
  note         TEXT,
  photos       JSONB  NOT NULL DEFAULT '[]'::jsonb,
  -- Who: a team member's email, a cleaner's name, or "<cleaner>'s team: <name>" from a shared link.
  by_name      TEXT   NOT NULL,
  source       TEXT   NOT NULL CHECK (source IN ('team', 'cleaner', 'link')),
  todo_id      BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_moves_idx ON inventory_moves (account_id, item_id, unit_id, created_at);

-- A cleaner's report link (§134): one per cleaner, shared with the people they
-- hire — no account. The secret is kept encrypted so the cleaner can share it
-- again, and hashed to find it. NULL = no link.
ALTER TABLE cleaners ADD COLUMN report_token_enc TEXT;
ALTER TABLE cleaners ADD COLUMN report_token_hash TEXT;
CREATE UNIQUE INDEX cleaners_report_token_idx ON cleaners (report_token_hash) WHERE report_token_hash IS NOT NULL;

-- A starter catalog; edited in Operations → Inventory.
INSERT INTO inventory_items (account_id, name, category, measure, per_clean, reorder_at) VALUES
  (1, 'Toilet paper', 'bathroom', 'roll', 2, 6),
  (1, 'Paper towels', 'kitchen', 'roll', 1, 3),
  (1, 'Trash bags', 'cleaning', 'bag', 3, 10),
  (1, 'Dish soap', 'kitchen', 'bottle', 0.1, 1),
  (1, 'Dishwasher pods', 'kitchen', 'pod', 2, 10),
  (1, 'Coffee pods', 'kitchen', 'pod', 6, 12),
  (1, 'Sugar packets', 'kitchen', 'packet', 4, 10),
  (1, 'Shampoo', 'bathroom', 'bottle', 1, 2),
  (1, 'Conditioner', 'bathroom', 'bottle', 1, 2),
  (1, 'Body wash', 'bathroom', 'bottle', 1, 2),
  (1, 'Hand soap', 'bathroom', 'bottle', 0.25, 1),
  (1, 'Laundry detergent', 'cleaning', 'pod', 3, 10),
  (1, 'Sponges', 'cleaning', 'unit', 0.5, 2);

-- Photos from field reports (purchases, missing items, problems) go to Drive here (made on first use).
ALTER TABLE accounts ADD COLUMN field_reports_folder TEXT;
