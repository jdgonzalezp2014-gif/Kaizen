-- §162: a claim's repair work is computed from its work orders and purchase orders (/api/claims, /api/claims-money);
-- the old typed figure was copied into `requested` (086). Dropped once the code that read it was deployed (2026-10-15,
-- c906e17) — checked: no reader in src/functions/scripts, no view depends on it.
ALTER TABLE claims DROP COLUMN repair_cost;
