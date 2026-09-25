-- The Data Repository is edited from Kaizen OS, not only read (§66).
--
-- Its data stays where it is — the repository's Sheet is the database,
-- its Drive folders hold the files, its engine validates every write —
-- and Kaizen becomes the screen and the access control in front of it.

-- Two new permissions, given to the seeded roles that match what those
-- people did in the repository's own app: editors keep records current,
-- only the "sees more" role changes structure. Appended only where
-- missing, so a role an admin has already edited is not overwritten.
UPDATE roles SET permissions = permissions || ARRAY['repository.edit']
 WHERE key IN ('manager', 'ops') AND NOT ('repository.edit' = ANY(permissions));
UPDATE roles SET permissions = permissions || ARRAY['repository.structure']
 WHERE key = 'manager' AND NOT ('repository.structure' = ANY(permissions));

-- Who changed what, from here. The repository stamps `updated_by` with
-- whoever its API runs as — its owner — so without this every edit made
-- through Kaizen would look like one person's. Values of secret columns
-- are never written here, only that one changed.
CREATE TABLE repo_audit (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  actor      TEXT   NOT NULL,
  action     TEXT   NOT NULL,
  table_key  TEXT,
  row_id     TEXT,
  detail     TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repo_audit_at_idx ON repo_audit (account_id, at DESC);
