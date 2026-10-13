-- An order is not a purchase (§150, owner). The ORDER is the shopping to-do
-- (what to buy, a line per item and where it goes); the PURCHASE is what was
-- really bought — items, the place each part went to, what it cost and the
-- receipt — recorded by ops. Only the purchase changes the stock (a
-- `purchase` move per line and place) and reaches Costs (one Restock expense).

-- The order's lines as data, so a purchase can start from them.
CREATE TABLE inventory_orders (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  todo_id    BIGINT NOT NULL,
  lines      JSONB  NOT NULL,          -- [{ itemId, place, qty }]
  created_by TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, todo_id)
);

CREATE TABLE inventory_purchases (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  todo_id    BIGINT,                   -- the order it executes, if any
  total      NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  note       TEXT,
  photos     JSONB  NOT NULL DEFAULT '[]'::jsonb,   -- the receipt
  by_name    TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inventory_moves ADD COLUMN purchase_id BIGINT;

-- The inspector's purchase can name a supply from the list (🔍) and how many
-- (§150): the inspection's order then comes filled in — that supply, that
-- many, to the unit's place. Free text stays free text.
ALTER TABLE inspection_checks ADD COLUMN supply_id  BIGINT REFERENCES inventory_items(id);
ALTER TABLE inspection_checks ADD COLUMN supply_qty NUMERIC(10,2);

-- What a cleaner reports on one clean (a need, something missing, something
-- they bought) is ONE to-do for that clean, each report a sub-task (§150,
-- owner); "something is wrong" stays its own to-do.
ALTER TABLE todos ADD COLUMN clean_key TEXT;
CREATE INDEX todos_clean_key_idx ON todos (account_id, clean_key) WHERE clean_key IS NOT NULL;

-- A cleaner's "I bought something" is approved by recording it as a purchase
-- (items and places): that purchase is its stock and its cost.
ALTER TABLE inventory_purchases ADD COLUMN field_expense_id BIGINT;
