-- Guest Services → Inbox, phase 1 of docs/roadmap.md (owner, 2026-11-16): automations per listing and per event,
-- the record of an online check-in, the reply's own way out (chat / email), and the guests' live events.

-- An automation is a template with a trigger: which listings it is for (NULL = all), a condition, and — for the ones
-- that go when something happens (booked, online check-in done) — how long before check-in it may go at the earliest
-- (a door code sent the minute a guest checks in online, three weeks ahead, is a code in the wrong inbox for 3 weeks).
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS listing_ids TEXT[];
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS only_if TEXT NOT NULL DEFAULT 'always';   -- always | checkin_pending | checkin_done
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS hold_hours INT;
-- trigger gains 'checkin_done' (no constraint on the column: the list lives in src/lib/inbox.ts TRIGGERS).

-- How a Hostaway message travels when the person chose: 'email' or 'channel'. NULL = the way the thread already talks.
ALTER TABLE guest_messages ADD COLUMN IF NOT EXISTS via TEXT;

-- "The online check-in is done" — written by the guest portal's real door (phase 2); until then a person marks it
-- from the stay's panel. It is what fires "After online check-in" and what "only if check-in (not) done" reads.
CREATE TABLE IF NOT EXISTS guest_checkins (
  account_id     BIGINT NOT NULL,
  reservation_id TEXT NOT NULL,
  listing_id     TEXT,
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         TEXT NOT NULL DEFAULT 'portal',     -- portal | team
  marked_by      TEXT,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, reservation_id)
);

-- What Hostaway's webhook told Kaizen (message.received, reservation.created / updated). A hint, never the record:
-- the conversation is always re-read from Hostaway. One row per guest message, triaged by a light model (does it
-- need an answer? is it urgent?) so "thanks!" never rings anybody.
CREATE TABLE IF NOT EXISTS guest_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  kind            TEXT NOT NULL,                     -- message | reservation
  event           TEXT NOT NULL,                     -- Hostaway's own name: message.received, reservation.created…
  ext_id          TEXT,                              -- Hostaway's id of the message: the same one never lands twice
  reservation_id  TEXT,
  conversation_id TEXT,
  listing_id      TEXT,
  guest           TEXT,
  preview         TEXT,
  msg_at          TIMESTAMPTZ,
  needs_reply     BOOLEAN,                           -- NULL = not triaged (no model answered): treated as needing one
  urgent          BOOLEAN NOT NULL DEFAULT false,
  why             TEXT,
  answered_at     TIMESTAMPTZ,
  reminded_at     TIMESTAMPTZ,
  checked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS guest_events_ext ON guest_events (account_id, kind, ext_id) WHERE ext_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS guest_events_open ON guest_events (account_id, created_at) WHERE kind = 'message' AND answered_at IS NULL;
CREATE INDEX IF NOT EXISTS guest_events_conv ON guest_events (account_id, conversation_id, id DESC);

-- { watch: bool, waitMinutes: int } — the unanswered-guest watch (Settings → Integrations → Guest messages & AI).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS guest_watch JSONB NOT NULL DEFAULT '{}'::jsonb;
