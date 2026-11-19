-- Upsells charged from the team's side (owner, 2026-11-19): an upsell case (Inbox + or Operations → To-do) makes a
-- Stripe payment link and holds what it sells in Hostaway — extra nights blocked, the new check-in / check-out hour.
-- The charge is pending until Stripe says paid; the guest's portal page lists the pending ones. Airbnb never gets a
-- row: Airbnb collects through its Resolution Center / an alteration.
CREATE TABLE IF NOT EXISTS upsell_charges (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     BIGINT NOT NULL DEFAULT 1,
  claim_id       BIGINT NOT NULL,
  reservation_id TEXT NOT NULL,
  unit_id        TEXT,
  unit_name      TEXT,
  guest          TEXT,
  guest_email    TEXT,
  need           TEXT NOT NULL CHECK (need IN ('nights', 'checkin', 'checkout', 'amount')),
  label          TEXT NOT NULL,
  item           TEXT NOT NULL,
  amount         NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  nights         TEXT[] NOT NULL DEFAULT '{}',        -- nights Kaizen blocked (reopened on cancel)
  hour           SMALLINT,                            -- the new check-in / check-out hour Kaizen set
  holds          TEXT[] NOT NULL DEFAULT '{}',        -- what happened in Hostaway, in words
  session_id     TEXT,                                -- the latest Checkout Session for it
  livemode       BOOLEAN NOT NULL DEFAULT false,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   TEXT
);
CREATE INDEX IF NOT EXISTS upsell_charges_claim ON upsell_charges (account_id, claim_id);
CREATE INDEX IF NOT EXISTS upsell_charges_res ON upsell_charges (account_id, reservation_id) WHERE status = 'pending';

-- A portal payment that settles a case is counted once, through the case (claims.refund) — never again as a portal sale.
ALTER TABLE guest_payments ADD COLUMN IF NOT EXISTS claim_id BIGINT;

-- A case paid through the team's pay link is collected via Stripe (src/lib/claims.ts COLLECTED_VIA).
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_collected_via_check;
ALTER TABLE claims ADD CONSTRAINT claims_collected_via_check
  CHECK (collected_via IN ('Resolution Center', 'Not priced on the reservation', 'Direct', 'Stripe'));
