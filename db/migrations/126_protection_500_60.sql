-- Owner, 2026-11-23: deposit up to $500, waiver minimum down to $60 ($12 a night stays): waiver = max($60, $12 × nights).
-- Only records still on the old standard ($300 / $70) change; a value someone typed by hand stays.
UPDATE repo_records SET vals = vals || jsonb_build_object('damage_deposit', 500)
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND vals->>'damage_deposit' = '300';
UPDATE repo_records SET vals = vals || jsonb_build_object('waiver_price', 60)
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND vals->>'waiver_price' = '70';

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.edit', t, NULL,
       'Fees: Refundable damage deposit $300 → $500, Damage waiver minimum $70 → $60 where still on the old standard (owner, 2026-11-23)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
