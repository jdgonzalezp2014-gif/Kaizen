-- Owner, 2026-11-26: the damage waiver is one fee per stay by its length — $55 under 7 nights, $75 from 7 nights, $99 for a
-- monthly stay (28+ nights) — instead of $12 a night with a $60 minimum. `waiver_price` becomes the base ($55); the 7+ and
-- monthly prices are defaults in code (guest-checkin.ts), and a record may set `waiver_week` / `waiver_month`.
-- Only records still on the old standard ($60) change; a value someone typed by hand stays. `insurance_fee` (the old
-- per-night rate, also Hostaway's former nightly fee) is no longer read by the portal and is left as it is.
UPDATE repo_records SET vals = vals || jsonb_build_object('waiver_price', 55)
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND vals->>'waiver_price' = '60';

UPDATE repo_columns SET title = 'Damage waiver (under 7 nights)'
 WHERE account_id = 1 AND key = 'waiver_price' AND table_key IN ('houses', 'the_links', 'cortland_legacy');
UPDATE repo_columns SET title = 'Damage waiver per night (no longer used)'
 WHERE account_id = 1 AND key = 'insurance_fee' AND table_key IN ('houses', 'the_links', 'cortland_legacy');

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.edit', t, NULL,
       'Fees: Damage waiver $60 minimum / $12 a night → $55 under 7 nights, $75 from 7, $99 monthly (owner, 2026-11-26)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
