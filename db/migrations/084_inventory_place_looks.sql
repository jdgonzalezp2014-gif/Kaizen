-- Owner, 2026-10-14: a count can carry photos of how the storage looks (damp, mess, a broken shelf…) and a note.
-- One row per count that had any; the place shows its latest. The photos live in Drive ("Kaizen — field reports").
CREATE TABLE IF NOT EXISTS inventory_place_looks (
  id         BIGSERIAL PRIMARY KEY,
  account_id INT  NOT NULL DEFAULT 1 REFERENCES accounts(id),
  place      TEXT NOT NULL,
  note       TEXT,
  photos     JSONB NOT NULL DEFAULT '[]'::jsonb,
  by_name    TEXT NOT NULL,
  counted    INT  NOT NULL DEFAULT 0,          -- items counted with it (0 = photos/note only)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_place_looks_place ON inventory_place_looks (account_id, place, id DESC);
