-- A supply's size (owner, 2026-10-14): "Mattress protectors" King and Queen are
-- two items — same name, a size to tell them apart. Shown as "Name — Size".
ALTER TABLE inventory_items ADD COLUMN size TEXT;
DROP INDEX inventory_items_name_idx;
CREATE UNIQUE INDEX inventory_items_name_idx ON inventory_items (account_id, lower(name), lower(coalesce(size, '')));

-- What a receipt calls a supply, learned when a person decides a line the AI
-- was not sure of (✨ Read receipt): the next receipt with that text matches it.
CREATE TABLE inventory_receipt_aliases (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  text       TEXT   NOT NULL,            -- normalised (src/lib/receipt.ts aliasKey)
  item_id    BIGINT NOT NULL REFERENCES inventory_items(id),
  by_name    TEXT   NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, text)
);
