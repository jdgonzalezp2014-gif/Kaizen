-- §162 (owner, 2026-10-15): Claims & upselling. A case says how much was asked for
-- (`requested`) and how much came in (`refund`, "Received"); the repair work is no
-- longer typed — it is the sum of the work orders' and purchase orders' costs on the
-- case (computed on read, /api/claims). The old typed figure was what we claimed, so
-- it moves to `requested`. `repair_cost` stays until the deploy (old code reads it);
-- nothing new writes it.
ALTER TABLE claims ADD COLUMN requested NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (requested >= 0);
UPDATE claims SET requested = repair_cost WHERE repair_cost > 0;
