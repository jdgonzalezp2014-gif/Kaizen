-- Handymen work their repairs like cleaners work their cleans (§137): by a link
-- the team sends for ONE work order (no account), or signed in with the email
-- in the vendor directory (their open work orders), or not at all — handled
-- inside, as before.
CREATE TABLE work_links (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  todo_id     BIGINT NOT NULL,
  vendor      TEXT   NOT NULL,
  token_enc   TEXT   NOT NULL,
  token_hash  TEXT   NOT NULL UNIQUE,
  -- A week after the day set; it also closes when the work order is done or cancelled, or goes to another vendor.
  expires_on  DATE   NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, todo_id)
);

-- Photos of a repair, before and after (Drive), by whoever took them.
CREATE TABLE work_photos (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  todo_id    BIGINT NOT NULL,
  stage      TEXT   NOT NULL CHECK (stage IN ('before', 'after')),
  name       TEXT   NOT NULL,
  url        TEXT   NOT NULL,
  by_name    TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_photos_idx ON work_photos (account_id, todo_id);

-- The vendor said yes to the day the team set (or no: a "Reschedule" sub-task, and this stays empty).
ALTER TABLE todos ADD COLUMN vendor_accepted_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN vendor_accepted_by TEXT;
