-- Owner, 2026-10-15: a unit may have its own supplies closet — every house, the P2 apartments (The Links), not
-- Cortland's. With a closet, cleaners take from it only, and the unit's Storage names what REFILLS it
-- (S1105 for the P2 closets; a house names itself = nothing). A "Has closet" checkbox after Closet code.
UPDATE repo_columns SET position = position + 1
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND position >= 15;
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, position)
SELECT 1, t, 'has_closet', 'Has closet', 'checkbox', 'Details', 15
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;

UPDATE repo_records SET vals = vals || jsonb_build_object('has_closet', table_key IN ('houses', 'the_links'))
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy')
   AND lower(coalesce(vals->>'property_type', '')) IN ('house', 'apartment');

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL,
       'Has closet — filled: every house and The Links (P2) apartments yes, Cortland apartments no (owner, 2026-10-15)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
