-- The inspection checklist grows up (§138). Areas become data the team adds
-- to (a pool, a garage, a balcony…), and an item says where it applies: every
-- unit, every house, every apartment, or a list of units (the pool only at
-- Bobcat and Amber Valley). House or apartment comes from the Repository —
-- the new "Property type" column of the Units tables.

CREATE TABLE inspection_areas (
  account_id BIGINT  NOT NULL REFERENCES accounts(id),
  key        TEXT    NOT NULL CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  label      TEXT    NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  -- Repeats once per room of the unit (bedrooms, bathrooms). Only the built-in two.
  per_room   BOOLEAN NOT NULL DEFAULT FALSE,
  position   INT     NOT NULL DEFAULT 0,
  -- Off: its items stop appearing in new inspections; old reports keep their words.
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
-- In walking order: in the door, the common rooms, the bedrooms and baths, then outside.
INSERT INTO inspection_areas (account_id, key, label, per_room, position, created_by) VALUES
  (1, 'general',  'General & entry', FALSE, 1, 'kaizen-os'),
  (1, 'living',   'Living room',     FALSE, 2, 'kaizen-os'),
  (1, 'kitchen',  'Kitchen',         FALSE, 3, 'kaizen-os'),
  (1, 'bedroom',  'Bedroom',         TRUE,  4, 'kaizen-os'),
  (1, 'bathroom', 'Bathroom',        TRUE,  5, 'kaizen-os'),
  (1, 'exterior', 'Outside',         FALSE, 6, 'kaizen-os'),
  (1, 'pool',     'Pool & hot tub',  FALSE, 7, 'kaizen-os');

ALTER TABLE inspection_items DROP CONSTRAINT inspection_items_area_check;
ALTER TABLE inspection_items ADD CONSTRAINT inspection_items_area_fkey
  FOREIGN KEY (account_id, area) REFERENCES inspection_areas (account_id, key);

-- Where an item applies. `units`: only the units in unit_ids.
ALTER TABLE inspection_items ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'all'
  CHECK (applies_to IN ('all', 'house', 'apartment', 'units'));
ALTER TABLE inspection_items ADD COLUMN unit_ids TEXT[] NOT NULL DEFAULT '{}';
UPDATE inspection_items SET applies_to = 'units', unit_ids = ARRAY[unit_id] WHERE unit_id IS NOT NULL;
ALTER TABLE inspection_items DROP COLUMN unit_id;

-- The owner's example: the pool is checked only where there is one.
UPDATE inspection_items SET area = 'pool', label = 'Pool / hot tub clean and working', applies_to = 'units',
       unit_ids = ARRAY['583200', '466736'], updated_at = now()
 WHERE account_id = 1 AND label = 'Pool / hot tub (if any): clean and working';

-- The Repository says what each unit is: a "Property type" column next to "Type" (bedrooms).
UPDATE repo_columns SET position = position + 1
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND position >= 8;
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, 'property_type', 'Property type', 'select', 'Details', ARRAY['House', 'Apartment'], 8
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
UPDATE repo_records SET vals = vals || jsonb_build_object('property_type', CASE WHEN table_key = 'houses' THEN 'House' ELSE 'Apartment' END)
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy');
INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL,
       'Property type (House / Apartment) — filled from the table: Houses = House, the others = Apartment (§138)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
