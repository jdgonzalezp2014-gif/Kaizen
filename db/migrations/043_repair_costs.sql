-- A repair's money (§95).
--
-- Every repair completed with a cost is a one-time expense in Costs
-- (category Repairs) — claim or no claim — so the portfolio's numbers
-- carry it. The expense is the repair's: source 'repair', external_ref =
-- the task id, kept in step with it (cost changed → updated; reopened,
-- cancelled or removed → gone). Edited from the repair, never in Costs.
--
-- "Charge to owner" (off unless ticked) also writes it as an expense on
-- the listing in Hostaway, where owner statements read expenses from.
ALTER TABLE todos
  ADD COLUMN charge_owner        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN hostaway_expense_id TEXT;
