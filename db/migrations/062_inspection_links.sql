-- An inspection walked from a link, no account (§135) — the same door as a
-- clean's helper link (§134): /report#i=<token>. One link per inspection,
-- kept encrypted so the team can share it again; hashed to find it. It ends
-- the day after the inspection, or when the inspection is finished.
--
-- The inspector SENDS (sent_at / sent_by); the team reviews and finishes in
-- Kaizen, where the findings become work. Reopening from the link clears sent_at.
ALTER TABLE inspections
  ADD COLUMN link_token_enc  TEXT,
  ADD COLUMN link_token_hash TEXT UNIQUE,
  ADD COLUMN link_expires_on DATE,
  ADD COLUMN sent_at         TIMESTAMPTZ,
  ADD COLUMN sent_by         TEXT;
