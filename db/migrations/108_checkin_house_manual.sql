-- Owner, 2026-11-09: the guest portal gets a House manual apart from the arrival steps — Wi-Fi, times, parking from the
-- record, plus the house's own items (e.g. Trash). Steps may now carry photos (Drive ids in steps[].photos).
ALTER TABLE checkin_guides ADD COLUMN house JSONB NOT NULL DEFAULT '[]';   -- [{ title, text }], ≤ 10

-- P2-1304 (seeded in 107): Trash was a step; it belongs in the house manual.
UPDATE checkin_guides
   SET house = COALESCE((SELECT jsonb_agg(jsonb_build_object('title', s->>'title', 'text', s->>'text')) FROM jsonb_array_elements(steps) s WHERE s->>'title' = 'Trash'), '[]'),
       steps = COALESCE((SELECT jsonb_agg(s ORDER BY n) FROM jsonb_array_elements(steps) WITH ORDINALITY AS e(s, n) WHERE s->>'title' <> 'Trash'), '[]')
 WHERE account_id = 1 AND unit_id = '586502';
