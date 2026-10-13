-- A checklist item that, when it fails, is bought (§150, owner): its supply is
-- preset — "Toilet paper stocked" → Toilet paper — so the inspector is only
-- asked how many, and the inspection's order comes filled in.
ALTER TABLE inspection_items ADD COLUMN supply_id BIGINT REFERENCES inventory_items(id);
