-- Handymen are paid like cleaners (owner, 2026-10-25): a page per vendor in
-- Operations → Handymen with their work orders in any dates, an invoice per
-- weekly or monthly period, and the team's edits — flag with a deduction or a
-- corrected pay, not paid, add a job. And both are paid out through Stripe
-- Connect (test keys first), or marked paid by hand.

-- A vendor's invoice period. A name typed on a work order but not in the
-- directory is monthly until someone picks; picking adds it to the directory.
ALTER TABLE vendors ADD COLUMN invoice_period TEXT NOT NULL DEFAULT 'monthly' CHECK (invoice_period IN ('weekly', 'monthly'));

-- The team's edits on a work order, as on a clean:
--   pay_flag_*  a note the handyman reads (does not change the pay by itself);
--   pay_fixed   a pay the team set — approved charges no longer rewrite cost_actual;
--   pay_note    why the pay was corrected (the handyman reads it);
--   pay_void    'not paid by the team — <why>': off the invoice and out of Costs.
ALTER TABLE todos ADD COLUMN pay_flag_note TEXT;
ALTER TABLE todos ADD COLUMN pay_flagged_by TEXT;
ALTER TABLE todos ADD COLUMN pay_flagged_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN pay_fixed NUMERIC(10, 2);
ALTER TABLE todos ADD COLUMN pay_note TEXT;
ALTER TABLE todos ADD COLUMN pay_void TEXT;

-- Stripe Connect: one connected (Express) account per payee, made when the
-- team sends the onboarding link. Test and live accounts never mix: the key's
-- mode is kept with the id, and a key of the other mode ignores it.
ALTER TABLE accounts ADD COLUMN stripe_secret_key_enc TEXT;
ALTER TABLE vendors ADD COLUMN stripe_account_id TEXT;
ALTER TABLE vendors ADD COLUMN stripe_mode TEXT;
ALTER TABLE cleaners ADD COLUMN stripe_account_id TEXT;
ALTER TABLE cleaners ADD COLUMN stripe_mode TEXT;

-- One payout per invoice: by Stripe (a transfer to the payee's connected
-- account, idempotent on the invoice number) or by hand (cash, Zelle, check).
-- The amount is what the invoice said when it was paid; a later change shows
-- as a difference on the invoice, settled by hand.
CREATE TABLE payouts (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         BIGINT NOT NULL REFERENCES accounts(id),
  payee_kind         TEXT   NOT NULL CHECK (payee_kind IN ('cleaner', 'vendor')),
  payee              TEXT   NOT NULL,
  invoice_number     TEXT   NOT NULL,
  period_from        DATE   NOT NULL,
  period_to          DATE   NOT NULL,
  amount             NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  method             TEXT   NOT NULL CHECK (method IN ('stripe', 'manual')),
  stripe_mode        TEXT,
  stripe_transfer_id TEXT,
  note               TEXT,
  created_by         TEXT   NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, invoice_number)
);

-- A handyman's own link (owner, 2026-10-25): /crew#v=<token> opens their page
-- without a sign-in, as a cleaner's does. The hash finds them; the encrypted
-- copy lets the team copy the same link again instead of breaking the old one.
ALTER TABLE vendors ADD COLUMN link_token_hash TEXT;
ALTER TABLE vendors ADD COLUMN link_token_enc TEXT;
