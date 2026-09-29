-- Every change Kaizen makes to a listing's text in Hostaway (§89), with
-- the text as it was — so any of them can be undone exactly, and nobody
-- has to wonder what a listing said before.
CREATE TABLE listing_text_changes (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  listing_id  TEXT   NOT NULL,
  field       TEXT   NOT NULL,
  before      TEXT,
  after       TEXT,
  outcome     TEXT   NOT NULL CHECK (outcome IN ('changed', 'unchanged', 'failed')),
  detail      TEXT,
  changed_by  TEXT   NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX listing_text_changes_idx ON listing_text_changes (account_id, listing_id, changed_at DESC);
