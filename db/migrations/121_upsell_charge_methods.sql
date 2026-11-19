-- Upsell charges, round 2 (owner, 2026-11-19, §178): how the guest pays (a card link, or on Airbnb the Resolution
-- Center), and nothing moves in Hostaway until the money is confirmed — `nights` / `hour` are what was sold, applied
-- after the payment (`applied_at`, or `apply_error` when Hostaway refused). Refunds follow the case (`refunded`).
ALTER TABLE upsell_charges ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'card';
ALTER TABLE upsell_charges DROP CONSTRAINT IF EXISTS upsell_charges_method_check;
ALTER TABLE upsell_charges ADD CONSTRAINT upsell_charges_method_check CHECK (method IN ('card', 'rc'));
ALTER TABLE upsell_charges ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE upsell_charges ADD COLUMN IF NOT EXISTS apply_error TEXT;
ALTER TABLE upsell_charges ADD COLUMN IF NOT EXISTS refunded NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE upsell_charges ADD COLUMN IF NOT EXISTS todo_id TEXT;   -- the follow-up to-do, when the stay was not extended

-- One pending charge per case: two people clicking at once can no longer make two.
CREATE UNIQUE INDEX IF NOT EXISTS upsell_charges_one_pending ON upsell_charges (account_id, claim_id) WHERE status = 'pending';
