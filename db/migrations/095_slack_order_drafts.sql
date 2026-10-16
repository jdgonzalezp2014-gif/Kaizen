-- Owner, 2026-10-15: "@Kaizen order <text>" drafts a purchase order in Slack, saved only on Confirm. A pasted list
-- (a new unit's setup: 58 lines) does not fit in a button's value (2000 characters), so the draft lives here and
-- its message's Confirm button carries the id. Deleted once confirmed or cancelled.
CREATE TABLE IF NOT EXISTS slack_order_drafts (
  account_id  bigint      NOT NULL,
  id          bigserial   NOT NULL,
  draft       jsonb       NOT NULL,
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
