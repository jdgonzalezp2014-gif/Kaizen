-- Owner, 2026-10-15: a purchase can be the owner's expense — marked when it is recorded, so someone tells / charges the owner.
ALTER TABLE inventory_purchases ADD COLUMN IF NOT EXISTS owner_charge boolean NOT NULL DEFAULT false;
