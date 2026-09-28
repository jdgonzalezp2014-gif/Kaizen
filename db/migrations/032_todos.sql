-- A to-do list for the team (§76): on Home and in Operations.
--
-- A to-do is a sentence, optionally tied to one or more listings and
-- optionally due on a day. Done and deleted are stamped, never erased:
-- "who closed this, and when" is the question a shared list gets asked.
CREATE TABLE todos (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  title       TEXT   NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  -- Hostaway listing IDs; none = not about a unit.
  unit_ids    TEXT[] NOT NULL DEFAULT '{}',
  due_on      DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ,
  done_by     TEXT,
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT
);
CREATE INDEX todos_open_idx ON todos (account_id, due_on) WHERE done_at IS NULL AND deleted_at IS NULL;

-- Everyone who works here uses the list; an admin can take it away per role.
UPDATE roles SET permissions = array_append(permissions, 'todos'), updated_at = now()
 WHERE key <> 'admin' AND NOT ('todos' = ANY(permissions));
