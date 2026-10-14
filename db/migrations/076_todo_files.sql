-- Files on a to-do (owner, Oct 2026): photos, PDFs, documents — added in Kaizen, or carried over from
-- the Slack message @Kaizen made the to-do from (and later ones in its thread). Kept in Drive.
CREATE TABLE todo_files (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  todo_id    BIGINT NOT NULL,
  name       TEXT   NOT NULL,
  url        TEXT   NOT NULL,
  mime       TEXT,
  source     TEXT   NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'slack')),
  by_name    TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX todo_files_idx ON todo_files (account_id, todo_id);
