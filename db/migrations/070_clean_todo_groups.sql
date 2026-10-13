-- A clean's reports are THREE kinds of to-do, not one (§150, owner): what is
-- wrong (each its own), the supplies requested (one per clean, a sub-task
-- each), what was bought (one per clean, a sub-task each). Each can carry its
-- own purchase order. `clean_key` says the clean, `clean_group` the kind.
ALTER TABLE todos ADD COLUMN clean_group TEXT CHECK (clean_group IN ('problem', 'request', 'bought'));
-- The to-dos made with 069's single grouping were requests and purchases mixed (tests on 2026-10-13).
UPDATE todos SET clean_group = 'request' WHERE clean_key IS NOT NULL AND parent_id IS NULL AND clean_group IS NULL;
