-- ── QUO credentials, staged ──────────────────────────────────────────
-- Stored and usable long before anything is allowed to send. `quo_live`
-- is the gate: with it false the whole path runs and writes what it
-- WOULD have sent, which is the only way to find out that a message is
-- malformed without a customer receiving it.
ALTER TABLE accounts ADD COLUMN quo_api_key_enc TEXT;
ALTER TABLE accounts ADD COLUMN quo_from        TEXT;
ALTER TABLE accounts ADD COLUMN quo_recipients  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN quo_live        BOOLEAN NOT NULL DEFAULT FALSE;

-- ── what we have already said ────────────────────────────────────────
-- The PDF's rule, and the reason this table exists: alert on the CHANGE,
-- not on the state. "Still 0%, tenth straight day" teaches people to
-- ignore alerts, and then the alert that mattered arrives to an audience
-- that has stopped reading.
--
-- One row per (unit, kind) holding the condition we last announced. A
-- condition that is still true is silence; one that has just begun or
-- just ended is a message.
CREATE TABLE alert_state (
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  unit_id      TEXT   NOT NULL,
  kind         TEXT   NOT NULL,
  -- open | resolved. Resolved rows are KEPT: they are what stops a
  -- flapping unit re-announcing itself every few hours.
  status       TEXT   NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  detail       TEXT,
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,
  PRIMARY KEY (account_id, unit_id, kind),
  FOREIGN KEY (account_id, unit_id) REFERENCES units (account_id, id)
);

-- ── what was sent, or would have been ────────────────────────────────
-- Written on every attempt including staged ones, so the message can be
-- read and argued with before a phone ever buzzes.
CREATE TABLE alert_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  unit_id     TEXT,
  kind        TEXT NOT NULL,
  -- begin | resolve. Nothing else fires.
  edge        TEXT NOT NULL CHECK (edge IN ('begin', 'resolve')),
  body        TEXT NOT NULL,
  segments    INTEGER,
  recipients  TEXT[],
  -- staged | sent | failed
  outcome     TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX alert_log_time_idx ON alert_log (account_id, created_at DESC);
