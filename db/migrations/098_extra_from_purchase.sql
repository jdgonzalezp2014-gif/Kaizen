-- A cleaner's purchase, approved, pays her back on her invoice (owner, 2026-10-24): an approved
-- extra on the clean it was bought for, tied to the purchase. Its cost is already in Costs as the
-- purchase (Restock), so the extra is paid but never a second cost row.
ALTER TABLE cleaning_extras ADD COLUMN field_expense_id BIGINT REFERENCES field_expenses(id);
CREATE UNIQUE INDEX cleaning_extras_field_expense ON cleaning_extras (account_id, field_expense_id) WHERE field_expense_id IS NOT NULL;

-- The ones approved before this: on the invoice of the clean's cleaner.
INSERT INTO cleaning_extras (account_id, cleaning_key, cleaner, amount, description, status, decision_note, decided_by, decided_at, created_by, field_expense_id)
SELECT f.account_id, f.cleaning_key, c.cleaner, f.amount, left(f.description, 300), 'approved',
       'Paid back: the purchase was approved into the inventory', f.decided_by, f.decided_at, 'Kaizen', f.id
  FROM field_expenses f
  JOIN cleanings c ON c.account_id = f.account_id AND c.key = f.cleaning_key
 WHERE f.source <> 'vendor' AND f.status = 'approved' AND c.cleaner IS NOT NULL;
