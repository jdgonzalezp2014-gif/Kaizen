-- Everything spent goes to Costs (§137, the owner: "todos los repair y cleanings así como compras vayan a
-- gastos"). Money people in the field paid — a cleaner's or helper's purchase with its receipt, later a
-- handyman's charge and materials — waits here for the team's approval (no preset prices); approved, it
-- becomes an expense (source 'field', external_ref = this id). Denied stays as the record of why.
CREATE TABLE field_expenses (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  -- Who: 'cleaner' (their page), 'link' (a helper's link), 'vendor' (a handyman, §137 phase B).
  source        TEXT   NOT NULL CHECK (source IN ('cleaner', 'link', 'vendor')),
  by_name       TEXT   NOT NULL,
  cleaning_key  TEXT,
  todo_id       BIGINT,
  unit_id       TEXT,
  category      TEXT   NOT NULL DEFAULT 'Restock',
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  description   TEXT   NOT NULL,
  photos        JSONB  NOT NULL DEFAULT '[]'::jsonb,
  -- The inventory move it came with, when it was a supplies purchase.
  move_id       BIGINT,
  status        TEXT   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX field_expenses_status_idx ON field_expenses (account_id, status, created_at DESC);
