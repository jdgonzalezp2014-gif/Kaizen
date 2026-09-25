-- Operations move INTO Kaizen OS.
--
-- Until now the daily file decided who cleans each turnover and what it
-- pays, and Kaizen only read the result (022). From here Kaizen decides,
-- records and pushes — and the sheet becomes an archive plus a read-only
-- mirror that Kaizen writes.
--
-- Nothing flips on its own. `ops_mode` starts at 'shadow': Kaizen
-- computes every decision and shows it beside the sheet's, but the
-- sheet is still the one writing to Hostaway. Two writers on the same
-- Host Note is the one state this migration must never create.

ALTER TABLE accounts ADD COLUMN ops_mode TEXT NOT NULL DEFAULT 'shadow'
  CHECK (ops_mode IN ('shadow', 'live'));
-- Thresholds, as the sheet's Settings → Rules. Stored as one object and
-- merged over the defaults in code, so adding a rule later is not a
-- migration and a missing key never reads as zero.
ALTER TABLE accounts ADD COLUMN ops_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
-- People who inspect but do not clean. Manager and Owner are implicit.
ALTER TABLE accounts ADD COLUMN extra_inspectors TEXT[] NOT NULL DEFAULT '{}';

-- The roster. Tiers are tied to money, people are tied to tiers: moving
-- someone between tiers moves the work, and the rule never changes.
CREATE TABLE cleaners (
  account_id  BIGINT  NOT NULL REFERENCES accounts(id),
  name        TEXT    NOT NULL,
  tier        TEXT    NOT NULL CHECK (tier IN ('high', 'mid', 'low')),
  -- The FIRST cleaner in a tier is the one the rule picks.
  position    INT     NOT NULL DEFAULT 0,
  -- Pay per bedroom count, {"1": 35, "2": 55, …}. A missing size is "no
  -- rate", never zero — an unpriced clean must look unpriced.
  rates       JSONB   NOT NULL DEFAULT '{}'::jsonb,
  -- Same shape, for a deep clean. A missing size falls back to `rates`.
  deep_rates  JSONB   NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, name)
);

-- What a person decided about one stay, over what the rule would say.
-- One row per reservation, the same thing Main's hand-edited cells
-- were. NULL in a column means "the rule decides" — which is why deep is
-- a nullable boolean rather than a checkbox: blank, YES and NO are
-- three different statements.
CREATE TABLE turnover_overrides (
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT   NOT NULL,
  -- 'assigned' + cleaner, or one of the two states that are not people.
  assignment     TEXT   CHECK (assignment IN ('assigned', 'tbd', 'not_needed')),
  cleaner        TEXT,
  deep           BOOLEAN,
  checkout_time  TEXT,
  checkin_time   TEXT,
  updated_by     TEXT   NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, reservation_id),
  CHECK (assignment IS DISTINCT FROM 'assigned' OR cleaner IS NOT NULL)
);

-- Notes, append-only: one row per CHANGE, like the sheet's Notes Log.
-- The current note is the latest row; a blank row is a note cleared.
CREATE TABLE stay_notes (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT   NOT NULL,
  kind           TEXT   NOT NULL CHECK (kind IN ('checkin', 'checkout')),
  unit_id        TEXT,
  unit_name      TEXT,
  guest          TEXT,
  check_in       DATE,
  notes          TEXT   NOT NULL DEFAULT '',
  source         TEXT   NOT NULL DEFAULT 'kaizen',
  created_by     TEXT   NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stay_notes_res_idx ON stay_notes (account_id, reservation_id, kind, id DESC);

-- Inspections. A row with no result is SCHEDULED, not done — it must
-- never reset the "days since" clock. Filling the result closes it,
-- which is why this is a case (like a claim) and not append-only.
CREATE TABLE inspections (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  unit_id        TEXT,
  unit_name      TEXT   NOT NULL,
  inspected_on   DATE   NOT NULL,
  inspector      TEXT,
  -- OK / Minor issues / Maintenance needed / Urgent are offered, but not
  -- enforced: the sheet's dropdown allowed free text, and an imported
  -- "OK - replaced towels" must not be coerced into a result nobody wrote.
  result         TEXT   CHECK (result IS NULL OR btrim(result) <> ''),
  notes          TEXT,
  -- The checkout it was scheduled against, when there is one.
  reservation_id TEXT,
  source         TEXT   NOT NULL DEFAULT 'kaizen',
  created_by     TEXT   NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspections_unit_idx ON inspections (account_id, unit_name, inspected_on DESC);
-- Re-importing the sheet's log, or auto-scheduling twice, must not
-- duplicate: one inspection per unit per day.
CREATE UNIQUE INDEX inspections_once_idx ON inspections (account_id, lower(unit_name), inspected_on);

-- Every attempt to write the Host Note, including the ones that were
-- only staged. A push that fails must leave a row saying so (§17).
CREATE TABLE host_note_pushes (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT   NOT NULL,
  block          TEXT   NOT NULL,
  outcome        TEXT   NOT NULL CHECK (outcome IN ('pushed', 'unchanged', 'staged', 'failed')),
  detail         TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX host_note_pushes_res_idx ON host_note_pushes (account_id, reservation_id, at DESC);

-- Who wrote each cleanings row. Until cutover the sheet's import writes
-- them; after it, Kaizen does — and the import stops, so the two never
-- write the same key.
ALTER TABLE cleanings ADD COLUMN source TEXT NOT NULL DEFAULT 'sheet';
