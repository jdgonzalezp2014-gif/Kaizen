-- Owner, 2026-10-26: say at a glance which units are still ours — a "Active" select right after Name.
-- Active = the Hostaway calendar the owner sent (the same 23 as Contract, migration 100); every other
-- unit row is Inactive. Storages and "Back up fobs" are not units: left blank.
UPDATE repo_columns SET position = position + 1
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND position >= 2;
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, 'active', 'Active', 'select', 'Details', ARRAY['Active', 'Inactive'], 2
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;

UPDATE repo_records
   SET vals = vals || jsonb_build_object('active', CASE WHEN vals ? 'contract' THEN 'Active' ELSE 'Inactive' END)
 WHERE account_id = 1 AND archived_at IS NULL AND table_key IN ('houses', 'the_links', 'cortland_legacy')
   AND vals->>'name' !~* 'storage|fobs';

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL,
       'Active (Active / Inactive) after Name — filled from the owner''s active list (2026-10-26)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
