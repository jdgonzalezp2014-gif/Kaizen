-- Owner, 2026-11-09: one guide per building, used by all its units ("a general repository" — the older units had less info).
-- A shared guide is a checkin_guides row with unit_id 'shared:<slug>' and a title; a unit points at one with `uses`.
-- The guest sees the shared steps + the unit's own extra steps; {unit}, {floor}, {lockbox} come from each unit's record.
ALTER TABLE checkin_guides ADD COLUMN title TEXT;
ALTER TABLE checkin_guides ADD COLUMN uses  TEXT;
