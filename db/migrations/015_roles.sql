-- Roles.
--
-- `allowed_emails` was a flat list: in or out. What is needed is people
-- who can record what a repair cost and what a guest complained about,
-- without seeing what the portfolio earns.
--
-- A table rather than another array column, because a role is a fact
-- ABOUT a person and the next thing wanted will be a third role.
CREATE TABLE members (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  email      TEXT   NOT NULL,
  -- owner: everything, including settings and credentials.
  -- ops:   expenses and claims only.
  role       TEXT   NOT NULL DEFAULT 'ops' CHECK (role IN ('owner', 'ops')),
  added_by   TEXT,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, email)
);

-- Everyone already on the allow-list becomes an owner. They had full
-- access a moment ago; a migration is not the place to take it away.
INSERT INTO members (account_id, email, role, added_by)
SELECT id, lower(trim(e)), 'owner', 'migration'
  FROM accounts, unnest(allowed_emails) AS e
 WHERE trim(e) <> ''
ON CONFLICT DO NOTHING;
