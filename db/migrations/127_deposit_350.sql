-- Owner, 2026-11-23 evening: deposit $500 → $350 on every listing (waiver unchanged: max($60, $12 × nights)).
-- Only records still on $500 change; a value someone typed by hand stays.
UPDATE repo_records SET vals = vals || jsonb_build_object('damage_deposit', 350)
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND vals->>'damage_deposit' = '500';

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.edit', t, NULL,
       'Fees: Refundable damage deposit $500 → $350 where still $500 (owner, 2026-11-23)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
