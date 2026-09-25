-- The operations sheet (the "daily file") and the Data Repository, read
-- from inside Kaizen OS rather than opened separately.
--
-- Nothing here copies either source into Postgres. Both are maintained
-- daily by the people doing the work, and a copy is a second version of
-- the truth that drifts the first time someone forgets to refresh it.
-- What is stored is only where to read them from, and — for the
-- repository — a credential and our own record of who revealed what.

-- Published-CSV links for three more tabs of the daily file. The fourth,
-- the Cleanings Log, has been read since migration 018 through
-- `cleanings_csv_url`.
ALTER TABLE accounts ADD COLUMN daily_notes_csv_url       TEXT;
ALTER TABLE accounts ADD COLUMN daily_inspections_csv_url TEXT;
-- The hidden `_Settings` tab: thresholds, the roster and both rate cards.
-- Optional — without it the board uses the sheet's own defaults and says
-- so, rather than silently judging against numbers nobody set.
ALTER TABLE accounts ADD COLUMN daily_settings_csv_url    TEXT;

-- The Cleanings Log carries two columns the import used to drop: the
-- checkout time a human set on Main, and the bedroom count that priced
-- the clean. Both are needed to show a turnover without opening the
-- sheet.
--
-- No backfill is needed, and that is deliberate rather than forgotten
-- (§60): the import upserts EVERY row of the log on each pass, so the
-- first refresh after this migration fills both columns for the rows
-- already here.
ALTER TABLE cleanings ADD COLUMN checkout_time TEXT;
ALTER TABLE cleanings ADD COLUMN beds          SMALLINT;

-- The Data Repository's JSON API: the deployment that runs as its owner,
-- and the key it checks. Encrypted like every other credential here.
ALTER TABLE accounts ADD COLUMN repo_api_url     TEXT;
ALTER TABLE accounts ADD COLUMN repo_api_key_enc TEXT;
-- The web app people open, for "edit this there". A separate link from
-- the API because they are separate deployments with separate access.
ALTER TABLE accounts ADD COLUMN repo_app_url     TEXT;

-- Who revealed which secret, from here.
--
-- The repository logs its own reveals, but the API deployment runs as
-- its OWNER — so every reveal made through Kaizen would be recorded
-- there under one name. The person is only known on this side, so this
-- side keeps the record. Append-only: an audit trail you can edit is a
-- diary.
CREATE TABLE repo_reveals (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  actor       TEXT   NOT NULL,
  table_key   TEXT   NOT NULL,
  row_id      TEXT   NOT NULL,
  column_key  TEXT   NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repo_reveals_at_idx ON repo_reveals (account_id, at DESC);
