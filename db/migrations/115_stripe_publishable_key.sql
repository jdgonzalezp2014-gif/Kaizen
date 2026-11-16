-- Guest portal (2026-11-16): Stripe's payment and ID check inside the portal (Embedded Checkout, Identity modal) need the
-- account's publishable key in the browser. Not a secret (Stripe prints it on every checkout page) — plain text, per account.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_publishable_key text;
