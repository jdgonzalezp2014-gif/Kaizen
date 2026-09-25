-- Google Drive as the Repository's file store (§72).
--
-- The owner: Drive is the storage — 8 TB, already trusted, already where
-- every record's folder lives. Kaizen uploads into those same folders as
-- one Google account connected once from Settings (OAuth, offline access).
-- The client and the tokens are credentials like Hostaway's: encrypted
-- with Kaizen's key, never sent to a browser.

ALTER TABLE accounts
  ADD COLUMN google_client_id         TEXT,
  ADD COLUMN google_client_secret_enc TEXT,
  ADD COLUMN google_refresh_token_enc TEXT,
  ADD COLUMN google_access_token_enc  TEXT,
  ADD COLUMN google_token_expires_at  TIMESTAMPTZ,
  -- Who connected it, as Google says (about.get), shown in Settings.
  ADD COLUMN google_drive_email       TEXT,
  -- The OAuth round trip's state, checked on return; ten minutes to live.
  ADD COLUMN google_oauth_state       TEXT,
  ADD COLUMN google_oauth_state_at    TIMESTAMPTZ,
  -- The folder new sections are created in (the old repository's root).
  ADD COLUMN repo_drive_root_id       TEXT;

ALTER TABLE repo_sections ADD COLUMN drive_folder_id TEXT;
ALTER TABLE repo_tables   ADD COLUMN drive_folder_id TEXT;
-- A file Kaizen put in Drive (or the import found there). A pasted link
-- has none, and removing it never touches Drive.
ALTER TABLE repo_files    ADD COLUMN drive_file_id   TEXT;
