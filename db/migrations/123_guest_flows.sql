-- The portal's real door (Phase 2, owner 2026-11-23): one row per stay with the guest's online check-in as they go.
-- `flow` is the guest's own answers (details, arrival time, protection choice, rules, extras); whether the ID check and
-- the payment really happened is written only from Stripe (identity_ok / paid_ok), never from the page. When every
-- required step is done the stay also gets its guest_checkins row (source 'portal'), which the automations wait for.
CREATE TABLE IF NOT EXISTS guest_flows (
  account_id     BIGINT  NOT NULL REFERENCES accounts(id),
  reservation_id TEXT    NOT NULL,
  listing_id     TEXT,
  flow           JSONB   NOT NULL DEFAULT '{}',
  identity_vs    TEXT,                 -- the Stripe Identity session started from this stay
  identity_ok    BOOLEAN NOT NULL DEFAULT false,
  pay_session    TEXT,                 -- the Stripe Checkout session for the check-in bill
  paid_ok        BOOLEAN NOT NULL DEFAULT false,
  paid_total     NUMERIC(10, 2),
  change_todo    TEXT,                 -- the to-do made from "Request a change" (once per text)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, reservation_id)
);
