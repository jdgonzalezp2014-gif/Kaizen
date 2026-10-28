-- Cleaners and handymen are paid through Wise instead of Stripe (owner, 2026-10-28):
-- Stripe Connect asked too much paperwork of each payee, and Wise pays a US bank
-- for about $1.13 per $1,000, in seconds. Stripe was never used: no payouts, no
-- connected accounts — only a test key, which goes with its column.

ALTER TABLE accounts DROP COLUMN stripe_secret_key_enc;
ALTER TABLE vendors  DROP COLUMN stripe_account_id, DROP COLUMN stripe_mode;
ALTER TABLE cleaners DROP COLUMN stripe_account_id, DROP COLUMN stripe_mode;

-- Kaizen's Wise business profile. Moving money from the balance needs every call
-- signed (Wise's strong customer authentication): Kaizen keeps the private key,
-- encrypted, and the owner uploads the public one to Wise once.
ALTER TABLE accounts ADD COLUMN wise_token_enc       TEXT;
ALTER TABLE accounts ADD COLUMN wise_env             TEXT CHECK (wise_env IN ('sandbox', 'live'));
ALTER TABLE accounts ADD COLUMN wise_profile_id      BIGINT;
ALTER TABLE accounts ADD COLUMN wise_private_key_enc TEXT;
ALTER TABLE accounts ADD COLUMN wise_public_key      TEXT;

-- The payee's bank as a Wise recipient. The payee types it on Kaizen's link;
-- Kaizen hands it to Wise and keeps only the recipient id and the last 4 digits.
-- A sandbox recipient is never paid with a live token, nor the other way.
ALTER TABLE vendors  ADD COLUMN wise_recipient_id BIGINT, ADD COLUMN wise_env TEXT, ADD COLUMN bank_last4 TEXT;
ALTER TABLE cleaners ADD COLUMN wise_recipient_id BIGINT, ADD COLUMN wise_env TEXT, ADD COLUMN bank_last4 TEXT;

ALTER TABLE payouts DROP CONSTRAINT payouts_method_check;
ALTER TABLE payouts DROP COLUMN stripe_mode, DROP COLUMN stripe_transfer_id;
ALTER TABLE payouts ADD CONSTRAINT payouts_method_check CHECK (method IN ('wise', 'manual'));
ALTER TABLE payouts ADD COLUMN wise_env         TEXT;
ALTER TABLE payouts ADD COLUMN wise_transfer_id BIGINT;
-- Wise's own state of the transfer (processing → outgoing_payment_sent, or bounced) and its fee.
ALTER TABLE payouts ADD COLUMN wise_status      TEXT;
ALTER TABLE payouts ADD COLUMN fee              NUMERIC(10, 2);
