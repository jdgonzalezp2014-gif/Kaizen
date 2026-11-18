-- Guest portal payments into the books (owner, 2026-11-17): every Stripe Checkout the portal takes — the damage waiver,
-- each extra, extra nights — is Kaizen's income; Stripe's fee is a cost. One row per Checkout Session, written when the
-- page confirms the session and again by Stripe's webhook (idempotent: the session id is the key). Test-mode rows are
-- kept so the team can try the flow, and never counted (`livemode`).
CREATE TABLE IF NOT EXISTS guest_payments (
  account_id     BIGINT NOT NULL DEFAULT 1,
  session_id     TEXT NOT NULL,
  payment_intent TEXT,
  livemode       BOOLEAN NOT NULL DEFAULT false,
  reservation_id TEXT,
  unit_id        TEXT,
  unit_name      TEXT,
  guest          TEXT,
  lines          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ item, label, amount, hold? }]
  amount         NUMERIC(10,2) NOT NULL,
  fee            NUMERIC(10,2),
  refunded       NUMERIC(10,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('paid', 'held', 'refunded')),
  paid_on        DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, session_id)
);
CREATE INDEX IF NOT EXISTS guest_payments_paid_on ON guest_payments (account_id, paid_on);
CREATE INDEX IF NOT EXISTS guest_payments_intent ON guest_payments (account_id, payment_intent);

-- Stripe's webhook signing secret (whsec_…), encrypted like the secret key: refunds and payments the page never saw.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_webhook_secret_enc TEXT;
