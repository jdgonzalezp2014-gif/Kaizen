-- Guest check-in code (guests module, 2026-11-15, owner): a smart-lock unit whose Hostaway reservations carry no
-- per-stay door code (Preston: Yale, Hostaway never fills it) gets a fixed guest code here. The portal shows the
-- reservation's code first, then this one; fob / keys units show no code — their way in is the guide's steps.
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, 'guest_code', 'Guest check-in code', 'text', 'Guest portal', NULL, 205
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t
ON CONFLICT (account_id, table_key, key) DO NOTHING;

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL, 'Guest portal: Guest check-in code (smart lock without a Hostaway code per stay)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
