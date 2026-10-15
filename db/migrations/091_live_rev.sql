-- Live work (owner, 2026-10-15): a to-do or a claim changed by anyone — the app, Slack, Hostaway's pull, a cleaner's
-- or a vendor's link, an inspection — reaches every open screen, and a save over someone else's change is caught.
--
-- One counter for both tables, bumped by the database itself: the code has seven doors that write to-dos, and a
-- door added later cannot forget to say it changed something. A screen asks "what moved after rev N?"; a save says
-- "I edited rev N" and is refused (409) when the row has moved since.
CREATE SEQUENCE IF NOT EXISTS live_rev;

ALTER TABLE todos  ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT nextval('live_rev');
ALTER TABLE claims ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT nextval('live_rev');

CREATE OR REPLACE FUNCTION live_rev_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.rev := nextval('live_rev');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS todos_live_rev ON todos;
CREATE TRIGGER todos_live_rev BEFORE INSERT OR UPDATE ON todos FOR EACH ROW EXECUTE FUNCTION live_rev_bump();
DROP TRIGGER IF EXISTS claims_live_rev ON claims;
CREATE TRIGGER claims_live_rev BEFORE INSERT OR UPDATE ON claims FOR EACH ROW EXECUTE FUNCTION live_rev_bump();

CREATE INDEX IF NOT EXISTS todos_rev_idx  ON todos  (account_id, rev);
CREATE INDEX IF NOT EXISTS claims_rev_idx ON claims (account_id, rev);
