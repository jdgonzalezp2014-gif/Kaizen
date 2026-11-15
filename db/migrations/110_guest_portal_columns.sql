-- Guest portal per listing (guests module, 2026-11-15). The portal reads these from the unit's Repository record:
-- a cover photo when Hostaway's first photo is not the best one, and the damage-protection values — empty fields
-- fall back to the unit type's defaults in src/lib/guest-checkin.ts (PROTECTION_DEFAULTS), so nothing must be filled.
WITH cols (key, title, type, options, position) AS (VALUES
  ('portal_photo', 'Portal photo (link)', 'url', NULL::text[], 200),
  ('unit_type', 'Unit type', 'select', ARRAY['Room', 'Apartment', 'House'], 201),
  ('waiver_price', 'Damage waiver price', 'number', NULL::text[], 202),
  ('waiver_cap', 'Damage waiver covers up to', 'number', NULL::text[], 203),
  ('deposit_hold', 'Security deposit hold', 'number', NULL::text[], 204)
)
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, c.key, c.title, c.type, 'Guest portal', c.options, c.position
  FROM cols c CROSS JOIN unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t
ON CONFLICT (account_id, table_key, key) DO NOTHING;

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL,
       'Section Guest portal: Portal photo, Unit type, Damage waiver price / covers up to, Security deposit hold (empty = defaults by unit type)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
