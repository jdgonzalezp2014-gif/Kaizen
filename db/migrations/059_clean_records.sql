-- One clean, as the people doing it report it (§134, the owner's next step):
-- photos BEFORE and AFTER, saved to the team's Drive (a folder per clean),
-- and "done" / "reopened" — from the cleaner's page or the helpers' link.
-- Several people can work the same clean: each photo and each mark says who.

-- The clean as the field knows it: whose it is (checked against their page
-- the first time), and its Drive folder (made on its first photo).
CREATE TABLE clean_records (
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  cleaning_key TEXT   NOT NULL,
  cleaner      TEXT   NOT NULL,
  unit_id      TEXT,
  unit_name    TEXT   NOT NULL,
  clean_date   DATE   NOT NULL,
  drive_folder TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, cleaning_key)
);

CREATE TABLE clean_photos (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  cleaning_key TEXT   NOT NULL,
  stage        TEXT   NOT NULL CHECK (stage IN ('before', 'after')),
  name         TEXT   NOT NULL,
  url          TEXT   NOT NULL,
  drive_id     TEXT   NOT NULL,
  by_name      TEXT   NOT NULL,
  source       TEXT   NOT NULL CHECK (source IN ('cleaner', 'link')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clean_photos_key_idx ON clean_photos (account_id, cleaning_key);

-- Every "done" and "reopened", kept: the latest says where the clean stands.
CREATE TABLE clean_marks (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  cleaning_key TEXT   NOT NULL,
  kind         TEXT   NOT NULL CHECK (kind IN ('done', 'reopened')),
  by_name      TEXT   NOT NULL,
  source       TEXT   NOT NULL CHECK (source IN ('cleaner', 'link')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clean_marks_key_idx ON clean_marks (account_id, cleaning_key, id DESC);

-- Root folder in Drive for the cleans' photos ("Kaizen — clean photos"), made on first use.
ALTER TABLE accounts ADD COLUMN clean_photos_folder TEXT;
