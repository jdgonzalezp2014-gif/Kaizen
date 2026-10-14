-- Owner, 2026-10-14: "@Kaizen help <question>" ranks SOPs by words before a model reads a few. Each SOP's
-- search words — synonyms, the team's shorthand, English and Spanish — written by the AI chain when it is saved.
ALTER TABLE sops ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}';
