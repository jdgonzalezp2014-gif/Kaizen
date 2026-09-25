-- Guest documents — ID and rental agreement per reservation (§73).
--
-- The daily file kept them in Drive, one folder per reservation:
--   root / 2026 / 2026-09 / 2026-09-24 / "Sep 24 & Guest" / ID
--                                                         / Rental Agreement
-- Kaizen uses the SAME folders, found by the same names, so a file put
-- there from either side is seen by both, and nothing is moved.

ALTER TABLE accounts ADD COLUMN guest_docs_root_id TEXT;

-- Where each named folder is, once found or made. A folder's ID does not
-- change, so this is an address book, not a cache of what is inside: the
-- files are listed from Drive every time they are shown.
CREATE TABLE drive_folders (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  path       TEXT   NOT NULL,
  folder_id  TEXT   NOT NULL,
  found_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, path)
);

-- An ID is the most sensitive thing Kaizen holds, so it is its own
-- permission. The roles that ran the board in the daily file uploaded
-- them there; they keep doing it here. Admin holds '*'.
UPDATE roles SET permissions = array_append(permissions, 'guests.documents'), updated_at = now()
 WHERE 'operations.edit' = ANY(permissions) AND NOT ('guests.documents' = ANY(permissions));
