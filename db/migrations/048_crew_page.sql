-- The crew page (§122): each cleaner sees their own cleans, what was
-- billed, what was flagged or left out, their invoice, extras they ask
-- for, and — once the team turns it on — what is coming.

-- How a cleaner signs in: Cloudflare Access (one-time code by email) vouches
-- for the address, and this column says whose page it is. A member row
-- for the same address wins: a member is never reduced to a cleaner.
ALTER TABLE cleaners ADD COLUMN email TEXT;
CREATE UNIQUE INDEX cleaners_email_idx ON cleaners (account_id, lower(email)) WHERE email IS NOT NULL;

-- The fallback for a cleaner the code-by-email does not work for: a link
-- carrying a secret. Only its SHA-256 is kept; the link is shown once,
-- when made. NULL is no link. It only opens anything once Access lets
-- /crew and /api/crew through (see docs/modules/operations.md).
ALTER TABLE cleaners ADD COLUMN link_token_hash TEXT;

-- The invoice Kaizen builds for them: per week (Saturday–Friday, paid Saturday) or per month.
ALTER TABLE cleaners ADD COLUMN invoice_period TEXT NOT NULL DEFAULT 'monthly'
  CHECK (invoice_period IN ('weekly', 'monthly'));

-- What is coming is shown only once the team has checked the schedule
-- makes sense — a crew booked off a rule nobody has verified is worse
-- than no schedule at all.
ALTER TABLE accounts ADD COLUMN crew_calendar BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN crew_calendar_days SMALLINT NOT NULL DEFAULT 14
  CHECK (crew_calendar_days BETWEEN 1 AND 30);

-- A clean flagged by hand: a note the cleaner sees (a guest complaint,
-- something missed). It does not change what the clean pays.
ALTER TABLE cleanings ADD COLUMN flag_note TEXT;
ALTER TABLE cleanings ADD COLUMN flagged_by TEXT;
ALTER TABLE cleanings ADD COLUMN flagged_at TIMESTAMPTZ;

-- Extras a cleaner adds to a clean's price. Nothing is paid until the
-- team approves it; a decision always says who and, when denied, why.
CREATE TABLE cleaning_extras (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT  NOT NULL REFERENCES accounts(id),
  cleaning_key  TEXT    NOT NULL,
  cleaner       TEXT    NOT NULL,
  amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  description   TEXT    NOT NULL CHECK (btrim(description) <> ''),
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  decision_note TEXT,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  created_by    TEXT    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, cleaning_key) REFERENCES cleanings (account_id, key),
  CHECK (status <> 'denied' OR btrim(coalesce(decision_note, '')) <> '')
);
CREATE INDEX cleaning_extras_cleaner_idx ON cleaning_extras (account_id, cleaner, status);
CREATE INDEX cleaning_extras_key_idx ON cleaning_extras (account_id, cleaning_key);

-- Evidence for an extra — a receipt, an invoice, a photo. The file lives
-- in Google Drive (the account's connected Drive, like guest documents);
-- Kaizen keeps the link. Several per extra.
ALTER TABLE accounts ADD COLUMN crew_extras_folder TEXT;
CREATE TABLE cleaning_extra_files (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  extra_id    BIGINT NOT NULL REFERENCES cleaning_extras(id),
  name        TEXT   NOT NULL,
  mime_type   TEXT,
  size        BIGINT,
  drive_id    TEXT   NOT NULL,
  url         TEXT   NOT NULL,
  uploaded_by TEXT   NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cleaning_extra_files_extra_idx ON cleaning_extra_files (account_id, extra_id);

-- A cleaner turning down a clean on their schedule. The clean becomes
-- unassigned (TBD) for the team to give to someone else — an override for
-- a checkout, the record itself for a manual clean — and this row says who
-- declined and why, so the board can show it and the rule does not hand it
-- straight back to them.
CREATE TABLE crew_declines (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  -- A reservation id (a checkout) or a MAN-<n> key (a manual clean).
  cleaning_key TEXT   NOT NULL,
  cleaner      TEXT   NOT NULL,
  clean_on     DATE   NOT NULL,
  unit_name    TEXT,
  reason       TEXT,
  created_by   TEXT   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crew_declines_key_idx ON crew_declines (account_id, cleaning_key);
