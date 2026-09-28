-- Work, connected (§77): to-dos, work orders and claims on one backbone.
--
-- A to-do grows into a unit of work without becoming a second system:
--   · kind      a plain to-do, or a WORK ORDER (repair / service by a vendor)
--   · status    one vocabulary for all work: open → in_progress → waiting → done | cancelled
--   · owner     every piece of work has someone it is waiting on
--   · claim     work can belong to a claim — the claim is the case, its
--               to-dos and work orders are how it gets resolved
-- Inspections stay where they are (operations): they have their own cycle.
ALTER TABLE todos
  ADD COLUMN kind          TEXT NOT NULL DEFAULT 'task'
                           CHECK (kind IN ('task', 'work_order')),
  ADD COLUMN status        TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'cancelled')),
  ADD COLUMN priority      TEXT NOT NULL DEFAULT 'normal'
                           CHECK (priority IN ('normal', 'high', 'urgent')),
  ADD COLUMN assignee      TEXT,
  -- The claim this work resolves. Text, matched against claims.id::text,
  -- so the link survives whatever type that key has.
  ADD COLUMN claim_id      TEXT,
  -- Work orders: who does it, when, and what it costs.
  ADD COLUMN vendor        TEXT,
  ADD COLUMN scheduled_on  DATE,
  ADD COLUMN cost_estimate NUMERIC(12,2) CHECK (cost_estimate >= 0),
  ADD COLUMN cost_actual   NUMERIC(12,2) CHECK (cost_actual >= 0);

-- A ticked to-do is a done one.
UPDATE todos SET status = 'done' WHERE done_at IS NOT NULL;
CREATE INDEX todos_claim_idx ON todos (account_id, claim_id) WHERE claim_id IS NOT NULL AND deleted_at IS NULL;

-- Updates — the timeline of a task or a claim. Appended, never edited:
-- "what happened, when, and who said so" is what a case is worth later.
-- A status change writes its own line, so the timeline is complete
-- even when nobody typed anything.
CREATE TABLE work_updates (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  subject     TEXT   NOT NULL CHECK (subject IN ('task', 'claim')),
  subject_id  TEXT   NOT NULL,
  kind        TEXT   NOT NULL CHECK (kind IN ('note', 'status', 'change')),
  body        TEXT   NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_updates_subject_idx ON work_updates (account_id, subject, subject_id, created_at);
