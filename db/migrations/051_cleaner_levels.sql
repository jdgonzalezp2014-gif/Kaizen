-- Levels replace stars (§125). The owner: all the cleaners are good, so
-- price decides — but Karina & Marvin and Irene are a step above, Veronica
-- is the standard, and Michelle is for emergencies and mid-stays, assigned
-- by hand only. Three levels, not five stars.
--
-- Seeded from the stars set by hand: ★4–5 high, ★1 manual, the rest standard.
-- The stars column stays until the levels rule has replaced the stars rule.
ALTER TABLE cleaners ADD COLUMN level TEXT NOT NULL DEFAULT 'standard'
  CHECK (level IN ('high', 'standard', 'manual'));
UPDATE cleaners SET level = CASE WHEN stars >= 4 THEN 'high' WHEN stars <= 1 THEN 'manual' ELSE 'standard' END;

-- The rule switch learns the new rule. Nothing switches here: Setup does,
-- after a preview.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_assign_rule_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_assign_rule_check CHECK (assign_rule IN ('tiers', 'stars', 'levels'));
