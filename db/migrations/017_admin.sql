-- "Owner" reads as ownership of the business, which is not what the role
-- is about — it is administrative access to the app. "Admin" says that
-- and nothing more.
--
-- Constraint dropped before the data is rewritten: an UPDATE to a value
-- the old CHECK forbids fails on the first row.
ALTER TABLE members DROP CONSTRAINT members_role_check;
UPDATE members SET role = 'admin' WHERE role = 'owner';
ALTER TABLE members ADD CONSTRAINT members_role_check CHECK (role IN ('admin', 'ops'));
ALTER TABLE members ALTER COLUMN role SET DEFAULT 'ops';
