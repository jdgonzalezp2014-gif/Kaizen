-- Guest Services → Payments (owner, 2026-11-26): payment reminders sent to guests go on the same record as refunds and
-- deposits. A reminder belongs to a stay, not to a Stripe payment: session_id may be empty, reservation_id says which stay.
ALTER TABLE guest_payment_actions ADD COLUMN IF NOT EXISTS reservation_id TEXT;
ALTER TABLE guest_payment_actions ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE guest_payment_actions ALTER COLUMN amount SET DEFAULT 0;
ALTER TABLE guest_payment_actions DROP CONSTRAINT IF EXISTS guest_payment_actions_kind_check;
ALTER TABLE guest_payment_actions ADD CONSTRAINT guest_payment_actions_kind_check CHECK (kind IN ('refund', 'release', 'capture', 'reminder'));
CREATE INDEX IF NOT EXISTS guest_payment_actions_stay ON guest_payment_actions (account_id, reservation_id);
