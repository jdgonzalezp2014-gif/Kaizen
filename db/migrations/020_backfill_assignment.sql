-- Migration 019 added `assignment` with DEFAULT 'assigned' and stopped
-- there, so every row that already existed kept its raw cleaner text and
-- was labelled as though a person had done it. "TBD" and "Not needed" went
-- on showing up in the by-cleaner filter as if they were people.
--
-- A new column with a default describes rows written AFTER it. The rows
-- already in the table have to be re-read, or the fix only applies to data
-- nobody has imported yet.
--
-- Matched on the WORDS, not the emoji, for the same reason the importer is:
-- the emoji is decoration somebody may drop.
UPDATE cleanings
   SET assignment = 'not_needed', cleaner = NULL
 WHERE account_id = 1
   AND cleaner IS NOT NULL
   AND lower(regexp_replace(cleaner, '[^a-zA-Z ]', '', 'g')) ~ '(not needed|no cleaning|none)';

UPDATE cleanings
   SET assignment = 'tbd', cleaner = NULL
 WHERE account_id = 1
   AND (cleaner IS NULL
        OR btrim(regexp_replace(cleaner, '[^a-zA-Z ]', '', 'g')) = ''
        OR lower(btrim(regexp_replace(cleaner, '[^a-zA-Z ]', '', 'g'))) ~ '^(tbd|unassigned|pending)$')
   AND assignment = 'assigned';
