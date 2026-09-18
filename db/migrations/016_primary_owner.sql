-- A primary owner, and a record of who changed what.
--
-- Every system that survives contact with more than one administrator
-- has one account that the others cannot remove: the GitHub org owner,
-- the AWS root account, the Cloudflare super administrator. The reason
-- is not politics — it is that an account with several administrators
-- and no floor can be left with nobody able to administer it, by
-- accident or in a bad afternoon.
--
-- It is marked, visible, and says so on screen. A protection nobody can
-- see is not a protection, it is a back door, and the person it is kept
-- from is exactly the person who would need to know.
ALTER TABLE members ADD COLUMN is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one, enforced by the database rather than by whoever writes
-- the next endpoint.
CREATE UNIQUE INDEX members_one_primary_idx
  ON members (account_id) WHERE is_primary;

-- Membership changes leave a trail. Useful to everyone: it shows who
-- granted access as readily as who removed it, which is what makes it
-- an audit log rather than a weapon.
CREATE TABLE member_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  actor      TEXT   NOT NULL,
  action     TEXT   NOT NULL,   -- added | role_changed | removed
  email      TEXT   NOT NULL,
  detail     TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX member_audit_time_idx ON member_audit (account_id, at DESC);
