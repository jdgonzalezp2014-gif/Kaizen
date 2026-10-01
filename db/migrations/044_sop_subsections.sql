-- SOP subsections (§97): a section can hold subsections — one level, so the
-- library never becomes a maze (Guest lifecycle → Check-in, Check-out…).
-- An SOP is filed in a section or in one of its subsections.
ALTER TABLE sop_sections
  ADD COLUMN parent_key TEXT,
  ADD CONSTRAINT sop_sections_parent_fk FOREIGN KEY (account_id, parent_key) REFERENCES sop_sections (account_id, key),
  ADD CONSTRAINT sop_sections_not_own_parent CHECK (parent_key IS NULL OR parent_key <> key);
