-- What a cleaner sees ahead without anyone confirming it (§127). The owner:
-- "4 días adelante" — the rule's picks show on a cleaner's page once they
-- are this close; what a person assigned shows always; the whole schedule
-- only once published (crew_calendar). The team's board marks with 👁 what
-- the cleaners can already see; nobody has to verify anything.
ALTER TABLE accounts ADD COLUMN crew_auto_days SMALLINT NOT NULL DEFAULT 4
  CHECK (crew_auto_days BETWEEN 0 AND 14);

-- A snapshot now records what was in view when it was taken, so "changes
-- since" never calls a clean "new" just because the days brought it into
-- view. Snapshots are also taken by the daily pass, not only by a person.
ALTER TABLE crew_schedule_confirms ADD COLUMN published BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE crew_schedule_confirms ADD COLUMN auto_days SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE crew_schedule_confirms ADD COLUMN day DATE;
UPDATE crew_schedule_confirms SET day = (confirmed_at AT TIME ZONE 'America/New_York')::date;
ALTER TABLE crew_schedule_confirms ALTER COLUMN day SET NOT NULL;
