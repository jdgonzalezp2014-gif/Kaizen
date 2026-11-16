-- §174: a fourth rule for who cleans — by zone, main cleaner first, the
-- overflow to whoever is free (owner, 2026-11-15: Veronica houses, Wilson apartments).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_assign_rule_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_assign_rule_check CHECK (assign_rule IN ('tiers', 'stars', 'levels', 'zones'));
