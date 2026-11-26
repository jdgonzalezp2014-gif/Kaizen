-- Guest Services → Payments (owner, 2026-11-26): refunds, released deposits and kept deposits done from Kaizen, on record.
-- 'released' = a held deposit let go without charging anything (Stripe: the PaymentIntent cancelled).
ALTER TABLE guest_payments DROP CONSTRAINT IF EXISTS guest_payments_status_check;
ALTER TABLE guest_payments ADD CONSTRAINT guest_payments_status_check CHECK (status IN ('paid', 'held', 'refunded', 'released'));

CREATE TABLE IF NOT EXISTS guest_payment_actions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL DEFAULT 1,
  session_id  TEXT NOT NULL,                 -- guest_payments.session_id
  kind        TEXT NOT NULL CHECK (kind IN ('refund', 'release', 'capture')),
  amount      NUMERIC(10, 2) NOT NULL,       -- refunded · released · captured (charges + deposit kept)
  reason      TEXT,
  stripe_id   TEXT,                          -- the refund (re_…) or the PaymentIntent
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_payment_actions_recent ON guest_payment_actions (account_id, created_at DESC);
