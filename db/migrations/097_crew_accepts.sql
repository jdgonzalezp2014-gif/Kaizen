-- Owner, 2026-10-17: a cleaner confirms a clean ahead on their page ("I'll do it") — the team sees a ✓ on the board.
-- One row per clean and cleaner; the day is kept so a clean that moves to another day asks again.
CREATE TABLE IF NOT EXISTS crew_accepts (
  account_id   integer NOT NULL REFERENCES accounts(id),
  cleaning_key text    NOT NULL,
  cleaner      text    NOT NULL,
  clean_on     date    NOT NULL,
  unit_name    text,
  created_by   text    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, cleaning_key, cleaner)
);
-- Owner, 2026-10-17: the crew link stays the same — kept encrypted (like an inspection's link) so the team can copy it again;
-- a new one only when someone asks for it.
ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS link_token_enc text;
