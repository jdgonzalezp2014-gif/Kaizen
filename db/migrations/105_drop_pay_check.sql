-- Owner, 2026-10-28 (§171, round 3): the "Validate pay" sub-task was redundant with Approvals — a handyman's charges are
-- approved in Operations → Approvals or inside the repair, and closing a repair with charges waiting asks to approve them
-- all. The pay checks 104's backfill made are removed (soft, with a line on each timeline; their charges stay pending,
-- in Approvals), and the column goes. RUN AFTER deploying the code that no longer reads todos.pay_check.
INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
SELECT account_id, 'task', id::text, 'change',
       'Removed: a handyman''s charges are approved in Operations → Approvals or inside the repair (closing it asks) — no sub-task.', 'Kaizen'
  FROM todos WHERE pay_check AND deleted_at IS NULL;
UPDATE todos SET deleted_at = now(), deleted_by = 'Kaizen', updated_at = now() WHERE pay_check AND deleted_at IS NULL;
DROP INDEX IF EXISTS todos_one_open_pay_check;
ALTER TABLE todos DROP COLUMN IF EXISTS pay_check;
