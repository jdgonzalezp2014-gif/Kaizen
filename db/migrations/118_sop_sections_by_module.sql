-- The SOP library follows the menu (owner, 2026-11-17: "the same structure as everything else"): one top section per
-- module of src/lib/modules.ts, and today's sections become their children — keys unchanged, so every SOP, every
-- screen's "?" (FEATURES.section) and every link keeps working. Idempotent.
INSERT INTO sop_sections (account_id, key, label, description, sort, created_by) VALUES
  (1, 'mod-leadership',     'Leadership',            'Overview, goals, decisions',                                   10, 'Kaizen OS'),
  (1, 'mod-guest-services', 'Guest Services',        'Inbox and guest messages, claims & upselling',                 20, 'Kaizen OS'),
  (1, 'mod-operations',     'Operations',            'Turnovers, cleaning, repairs, inspections, inventory',         30, 'Kaizen OS'),
  (1, 'mod-experience',     'Guest Experience',      'Listing health, check-in guides, verification, buildings',     40, 'Kaizen OS'),
  (1, 'mod-finance',        'Finance, Data & Tech',  'Units, revenue, pricing, costs',                               50, 'Kaizen OS'),
  (1, 'mod-shared',         'Shared tools',          'Slack, SOPs, reports, team & onboarding',                      60, 'Kaizen OS'),
  (1, 'mod-vendors',        'Vendor portal',         'Cleaners'' and handymen''s pages',                             70, 'Kaizen OS'),
  (1, 'mod-portal',         'Guest portal',          'Online check-in, payments, extras',                            80, 'Kaizen OS'),
  (1, 'mod-core',           'Core',                  'Repository, accounts & access, settings',                      90, 'Kaizen OS')
ON CONFLICT DO NOTHING;

UPDATE sop_sections SET parent_key = 'mod-guest-services' WHERE account_id = 1 AND key IN ('guest', 'claims');
UPDATE sop_sections SET parent_key = 'mod-operations'     WHERE account_id = 1 AND key IN ('turnover', 'maintenance', 'inspections');
UPDATE sop_sections SET parent_key = 'mod-experience'     WHERE account_id = 1 AND key IN ('compliance');
UPDATE sop_sections SET parent_key = 'mod-finance'        WHERE account_id = 1 AND key IN ('finance', 'revenue');
UPDATE sop_sections SET parent_key = 'mod-shared'         WHERE account_id = 1 AND key IN ('team');
UPDATE sop_sections SET parent_key = 'mod-core'           WHERE account_id = 1 AND key IN ('systems');

-- Two empty test sections (one would now sit three levels deep, which the library does not draw): hidden, not erased.
UPDATE sop_sections s SET deleted_at = now()
 WHERE s.account_id = 1 AND s.key IN ('test-section-n', 'check-in-test') AND s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM sops o WHERE o.account_id = s.account_id AND o.section_key = s.key AND o.deleted_at IS NULL);
