-- §164 (owner, 2026-10-15): a field report waits for the team's urgency as a flag, not a sub-task (a sub-task per
-- report filled the urgent list with work that is not work). Set by a cleaner's / helper's problem or request; cleared
-- when the team answers (Slack's buttons — #kaizen-ops, or privately to ops in the cleaner's channel — or the priority).
ALTER TABLE todos ADD COLUMN urgency_pending BOOLEAN NOT NULL DEFAULT false;
