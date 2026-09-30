-- The task manager on Hostaway's model (§94).
--
-- Kaizen's task and Hostaway's task now hold the same things, so the
-- mirror (§93) copies instead of translating:
--   · status    Hostaway's five, word for word: pending, confirmed,
--               in progress, completed, cancelled ("waiting" goes — never
--               used; "confirmed", the owner accepting it, comes in)
--   · priority  none, low, medium, high, urgent (Hostaway: null, 1–4)
--   · owner and supervisor are Hostaway users (ids), not free text
--   · one listing per task (a task on several listings is several tasks)
--   · "Start from" and "Finish by", each a day with an optional time
--     (scheduled_on / due_on, plus start_time / due_time)
--   · the resolution note written when it is completed
-- Kaizen's extras stay Kaizen's: the kind (to-do / repair), sub-tasks, the
-- claim, the vendor and the estimate.

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
UPDATE todos SET status = CASE status WHEN 'open' THEN 'pending' WHEN 'waiting' THEN 'pending'
                                      WHEN 'done' THEN 'completed' ELSE status END;
ALTER TABLE todos ALTER COLUMN status SET DEFAULT 'pending',
  ADD CONSTRAINT todos_status_check CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled'));

ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_priority_check;
UPDATE todos SET priority = 'none' WHERE priority = 'normal';
ALTER TABLE todos ALTER COLUMN priority SET DEFAULT 'none',
  ADD CONSTRAINT todos_priority_check CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent'));

ALTER TABLE todos
  ADD COLUMN assignee_user_id   INT,
  ADD COLUMN supervisor_user_id INT,
  -- Names as they were when set: readable even if the user leaves Hostaway.
  ADD COLUMN supervisor         TEXT,
  ADD COLUMN start_time         TIME,
  ADD COLUMN due_time           TIME,
  ADD COLUMN resolution_note    TEXT,
  ADD CONSTRAINT todos_one_listing CHECK (cardinality(unit_ids) <= 1);

-- Hostaway's users, for the owner and supervisor pickers — refreshed from
-- Hostaway at most twice a day, so a form never waits on it.
CREATE TABLE hostaway_users (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  id         INT    NOT NULL,
  name       TEXT   NOT NULL,
  email      TEXT,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
