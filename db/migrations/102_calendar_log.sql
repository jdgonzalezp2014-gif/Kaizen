-- Owner, 2026-10-27: see when a calendar was blocked and when it was opened — including changes made in
-- Hostaway directly, which keeps no history. Kaizen looks every hour and keeps the difference (src/lib/calendar-watch.ts).

-- The last look per listing: one character a day from from_day (a open · b blocked · r booked · p pending).
CREATE TABLE calendar_watch (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  listing_id TEXT   NOT NULL,
  from_day   DATE   NOT NULL,
  codes      TEXT   NOT NULL,
  notes      JSONB  NOT NULL DEFAULT '{}',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The first look: nothing before it can be in the log. Never updated.
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, listing_id)
);

-- One row per night that changed. `since` is the look before: the change happened between the two.
CREATE TABLE calendar_changes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  listing_id TEXT   NOT NULL,
  day        DATE   NOT NULL,
  was        CHAR(1) NOT NULL,
  became     CHAR(1) NOT NULL,
  note       TEXT,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  since      TIMESTAMPTZ
);
CREATE INDEX calendar_changes_seen ON calendar_changes (account_id, seen_at DESC);
CREATE INDEX calendar_changes_unit ON calendar_changes (account_id, listing_id, day);
