-- Not every supply is kept in every place (§150, owner: S2101 holds furniture,
-- a house closet no coffee pods…). An item marked "not kept here" leaves that
-- place's list, its needs and its orders; it can be shown again.
CREATE TABLE inventory_place_hidden (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  place      TEXT   NOT NULL,
  item_id    BIGINT NOT NULL REFERENCES inventory_items(id),
  hidden_by  TEXT   NOT NULL,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, place, item_id)
);
