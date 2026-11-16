-- Guest services per unit (guests module, 2026-11-15, owner: "what services to offer, which not — the Repository holds it").
-- Offer = Yes / No; blank = Yes (the catalog default). Price blank = the catalog price (src/lib/guest-portal.ts UPSELLS).
-- Early / late stay at $20 per hour everywhere (owner); extra nights take the calendar's nightly price; a pet takes Pet fee.
WITH cols (key, title, type, options, position) AS (VALUES
  ('svc_extra_nights', 'Offer extra nights', 'select', ARRAY['Yes', 'No'], 300),
  ('svc_early_checkin', 'Offer early check-in', 'select', ARRAY['Yes', 'No'], 301),
  ('svc_late_checkout', 'Offer late check-out', 'select', ARRAY['Yes', 'No'], 302),
  ('svc_mid_clean', 'Offer mid-stay clean', 'select', ARRAY['Yes', 'No'], 303),
  ('mid_clean_price', 'Mid-stay clean price', 'number', NULL::text[], 304),
  ('svc_pet', 'Offer pets', 'select', ARRAY['Yes', 'No'], 305),
  ('svc_crib', 'Offer crib / pack ’n play', 'select', ARRAY['Yes', 'No'], 306),
  ('crib_price', 'Crib price', 'number', NULL::text[], 307),
  ('svc_welcome', 'Offer welcome basket', 'select', ARRAY['Yes', 'No'], 308),
  ('welcome_price', 'Welcome basket price', 'number', NULL::text[], 309)
)
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, c.key, c.title, c.type, 'Guest services', c.options, c.position
  FROM cols c CROSS JOIN unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t
ON CONFLICT (account_id, table_key, key) DO NOTHING;

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL, 'Section Guest services: offer Yes/No per extra + mid-stay clean / crib / welcome prices (blank = catalog)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
