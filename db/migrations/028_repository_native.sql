-- The Data Repository, native to Kaizen OS (§71).
--
-- It was read through the old Apps Script project's API: 3 s for the
-- structure, 10 s to list one table of 21 records, failing under load —
-- one table took six minutes of retries during the move. The IDEA is kept
-- (sections → tables → typed columns → records, encrypted secrets, a Drive
-- folder per record); the old project is no longer on the path of any
-- screen.
--
-- Structure is DATA, as it was: sections, tables and columns are rows an
-- admin edits from the screen, never a migration.

CREATE TABLE repo_sections (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  key        TEXT   NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  title      TEXT   NOT NULL,
  position   INT    NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE repo_tables (
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  key         TEXT   NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  section_key TEXT   NOT NULL,
  title       TEXT   NOT NULL,
  -- `UNI` → UNI-0001. Empty → plain numbers.
  id_prefix   TEXT   NOT NULL DEFAULT '',
  -- The columns that name a record (the first is the one the grid pins).
  name_fields TEXT[] NOT NULL DEFAULT '{}',
  position    INT    NOT NULL DEFAULT 0,
  -- Archiving hides a table; nothing in it is erased.
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, key),
  FOREIGN KEY (account_id, section_key) REFERENCES repo_sections (account_id, key)
);

CREATE TABLE repo_columns (
  account_id BIGINT  NOT NULL REFERENCES accounts(id),
  table_key  TEXT    NOT NULL,
  key        TEXT    NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  title      TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK (type IN ('text','longtext','number','date','checkbox','select',
                                                'email','url','ref','secret','doc')),
  grp        TEXT    NOT NULL DEFAULT 'Details',
  required   BOOLEAN NOT NULL DEFAULT FALSE,
  uniq       BOOLEAN NOT NULL DEFAULT FALSE,
  options    TEXT[],
  ref_table  TEXT,
  ref_column TEXT,
  position   INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, table_key, key),
  FOREIGN KEY (account_id, table_key) REFERENCES repo_tables (account_id, key) ON DELETE CASCADE
);

-- One row per record. Values live in one JSONB object keyed by column —
-- the shape the structure-as-data idea needs. Secrets are NOT in it.
CREATE TABLE repo_records (
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  table_key   TEXT   NOT NULL,
  id          TEXT   NOT NULL,
  seq         INT    NOT NULL,
  vals        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- The record's Drive folder from the old repository, kept as a link,
  -- and each document column's subfolder in it ({column: url}).
  folder_url  TEXT,
  doc_folders JSONB NOT NULL DEFAULT '{}'::jsonb,
  position    INT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  -- Deleting a record archives it: out of every view, never erased.
  archived_at TIMESTAMPTZ,
  archived_by TEXT,
  PRIMARY KEY (account_id, table_key, id),
  FOREIGN KEY (account_id, table_key) REFERENCES repo_tables (account_id, key) ON DELETE CASCADE
);
CREATE INDEX repo_records_live_idx ON repo_records (account_id, table_key, position) WHERE archived_at IS NULL;

-- Secrets, apart from every other value: encrypted with Kaizen's key
-- (AES-GCM, crypto.ts), never in `vals`, never in a list response, read
-- only through a reveal that is written to repo_reveals first.
CREATE TABLE repo_secrets (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  table_key  TEXT   NOT NULL,
  record_id  TEXT   NOT NULL,
  column_key TEXT   NOT NULL,
  value_enc  TEXT   NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, table_key, record_id, column_key),
  FOREIGN KEY (account_id, table_key, record_id) REFERENCES repo_records (account_id, table_key, id) ON DELETE CASCADE
);

-- A document column holds links: a Drive file, a shared folder, any
-- https address. Kaizen stores where a file is, not the file — Drive stays
-- the file store (§71). Removing a link never touches the file itself.
CREATE TABLE repo_files (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  table_key   TEXT   NOT NULL,
  record_id   TEXT   NOT NULL,
  column_key  TEXT   NOT NULL,
  name        TEXT   NOT NULL,
  url         TEXT   NOT NULL CHECK (url ~ '^https://'),
  mime_type   TEXT,
  size_bytes  BIGINT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by    TEXT,
  removed_at  TIMESTAMPTZ,
  removed_by  TEXT,
  FOREIGN KEY (account_id, table_key, record_id) REFERENCES repo_records (account_id, table_key, id) ON DELETE CASCADE
);
CREATE INDEX repo_files_record_idx ON repo_files (account_id, table_key, record_id) WHERE removed_at IS NULL;
