-- Work ↔ Hostaway tasks (§93).
--
-- A Kaizen to-do or repair is mirrored as a task in Hostaway, where the
-- team (and Hostaway's mobile app) can see, start, assign and close it;
-- what they change there comes back. Tasks created by hand in Hostaway
-- come in as Kaizen work. Hostaway's automatic tasks (one "Cleaning – …"
-- per reservation) stay out: the board already runs the cleans.
--
-- `hostaway_state` is what the two sides last agreed on — the fields
-- that sync, as Hostaway holds them. Hostaway's task has no "updated at",
-- so a difference from this snapshot is how a change made THERE is seen.
ALTER TABLE todos
  ADD COLUMN hostaway_task_id   TEXT,
  ADD COLUMN hostaway_state     JSONB,
  ADD COLUMN hostaway_synced_at TIMESTAMPTZ,
  -- The last push that failed, kept until one succeeds.
  ADD COLUMN hostaway_error     TEXT,
  -- Where the work was first written.
  ADD COLUMN source             TEXT NOT NULL DEFAULT 'kaizen' CHECK (source IN ('kaizen', 'hostaway'));
CREATE UNIQUE INDEX todos_hostaway_task_idx ON todos (account_id, hostaway_task_id) WHERE hostaway_task_id IS NOT NULL;

ALTER TABLE accounts
  -- 'off' until someone turns it on in Operations → Setup.
  ADD COLUMN hostaway_tasks           TEXT NOT NULL DEFAULT 'off' CHECK (hostaway_tasks IN ('off', 'mirror')),
  ADD COLUMN hostaway_tasks_pulled_at TIMESTAMPTZ;
