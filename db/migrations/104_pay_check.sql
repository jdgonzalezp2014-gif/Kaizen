-- Owner, 2026-10-28: a handyman's job done is not paid by itself. It gets a "Validate pay" sub-task in the same work
-- (functions/_lib/pay-check.ts): the team looks at the photos and the price, and completing it approves the charges
-- waiting — then the pay is on the invoice and in Costs. One open pay check per parent, so two quick "done"s from the
-- field never make two.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS pay_check BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS todos_one_open_pay_check ON todos (account_id, parent_id)
  WHERE pay_check AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled');
