-- Work as a tree (§78): a title with a description, and sub-tasks.
--
-- Everything starts as a to-do. A to-do can hold sub-tasks of any kind —
-- to-dos, work orders — or none at all (send a message to someone). The
-- title stays a title; the detail goes in the description.
ALTER TABLE todos
  ADD COLUMN description TEXT CHECK (length(description) <= 4000),
  -- One level deep: a sub-task's parent is never itself a sub-task.
  ADD COLUMN parent_id   BIGINT REFERENCES todos(id);
CREATE INDEX todos_parent_idx ON todos (account_id, parent_id) WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
