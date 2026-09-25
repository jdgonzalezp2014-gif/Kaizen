-- Roles an admin defines, instead of two fixed ones.
--
-- A role is a named set of permissions (functions/_lib/roles.ts). `admin`
-- holds '*' and is fixed; the others are ordinary rows an admin edits in
-- Settings → Roles. Members point at a role that EXISTS — a foreign key,
-- not a CHECK list — so deleting a role someone still has fails in the
-- database rather than leaving them with a role that means nothing.

CREATE TABLE roles (
  account_id  BIGINT  NOT NULL REFERENCES accounts(id),
  key         TEXT    NOT NULL CHECK (key ~ '^[a-z0-9_-]{1,32}$'),
  name        TEXT    NOT NULL,
  permissions TEXT[]  NOT NULL DEFAULT '{}',
  builtin     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

-- `ops` keeps everything it had and gains the repository's passwords,
-- which the owner wants almost everyone to have (each reveal is logged).
-- `manager` is the "sees more" role: everything except Settings.
INSERT INTO roles (account_id, key, name, permissions, builtin)
SELECT a.id, r.key, r.name, r.permissions, r.builtin
  FROM accounts a,
       (VALUES ('admin',   'Admin',      ARRAY['*'], TRUE),
               ('manager', 'Manager',    ARRAY['units','revenue','money','operations','operations.edit',
                                               'operations.setup','repository','repository.reveal',
                                               'costs','claims'], FALSE),
               ('ops',     'Operations', ARRAY['operations','operations.edit','repository',
                                               'repository.reveal','costs','claims'], FALSE))
       AS r(key, name, permissions, builtin);

ALTER TABLE members DROP CONSTRAINT members_role_check;
ALTER TABLE members ADD CONSTRAINT members_role_fk
  FOREIGN KEY (account_id, role) REFERENCES roles (account_id, key);
