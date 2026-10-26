-- Owner, 2026-10-26: say whether we hold a unit under lease or only manage it for its owner.
-- Every active unit is leased except Bobcat (management). Units no longer active stay blank.
-- A "Contract" select right after Property type.
UPDATE repo_columns SET position = position + 1
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND position >= 9;
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, 'contract', 'Contract', 'select', 'Details', ARRAY['Lease', 'Management'], 9
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;

-- Active = the Hostaway calendar the owner sent (2026-10-26).
UPDATE repo_records
   SET vals = vals || jsonb_build_object('contract', CASE WHEN vals->>'name' = 'Bobcat' THEN 'Management' ELSE 'Lease' END)
 WHERE account_id = 1 AND archived_at IS NULL AND vals->>'name' IN (
   'CL-1339', 'CL-1446', 'CL-2260', 'CL-1250', 'CL-2450', 'CL-1125',
   'Preston Vineyard', 'Napa Valley', 'Timbercrest', 'Amber Valley', 'Concord', 'Quest', 'Bobcat',
   'LP-1304', 'LP-1201', 'LP-1406', 'LP-4308', 'LP-4323', 'LP-4304', 'LP-4212', 'LP-4315', 'LP-4217', 'LP-4222')
   AND table_key IN ('houses', 'the_links', 'cortland_legacy');

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL,
       'Contract (Lease / Management) — filled: active units Lease, Bobcat Management (owner, 2026-10-26)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
