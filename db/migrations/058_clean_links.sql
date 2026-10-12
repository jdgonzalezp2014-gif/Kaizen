-- A helper's link is for ONE clean, not for a cleaner's whole team (§134,
-- the owner's correction). The cleaner shares it from that clean's Options;
-- it opens /report already on that unit and day, so a helper cannot pick
-- the wrong one, and it stops working two days after the clean — or as soon
-- as the clean is not that cleaner's any more.
CREATE TABLE clean_links (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  cleaner      TEXT   NOT NULL,
  cleaning_key TEXT   NOT NULL,
  unit_id      TEXT,
  unit_name    TEXT   NOT NULL,
  clean_date   DATE   NOT NULL,
  expires_on   DATE   NOT NULL,
  -- Encrypted so the same link can be shared again; hashed to find it.
  token_enc    TEXT   NOT NULL,
  token_hash   TEXT   NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, cleaner, cleaning_key)
);

-- The team-wide link of 057 is replaced before anyone used it (no rows had one).
DROP INDEX IF EXISTS cleaners_report_token_idx;
ALTER TABLE cleaners DROP COLUMN report_token_enc;
ALTER TABLE cleaners DROP COLUMN report_token_hash;
