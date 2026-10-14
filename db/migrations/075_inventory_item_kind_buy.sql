-- §150, owner: the items list says what each thing is and where to buy it.
-- kind: 'supply' (consumed by cleans — what cleaners take, per unit and clean) or
-- 'furniture' (linens, dishes, equipment, hardware: counted, never given out per clean).
-- buy_options: where to buy it — [{ label, url }], as many as there are.
ALTER TABLE inventory_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'supply' CHECK (kind IN ('supply', 'furniture'));
ALTER TABLE inventory_items ADD COLUMN buy_options JSONB NOT NULL DEFAULT '[]'::jsonb;
-- The items added 2026-10-13 from Shannon H.'s checklist are the house's things, not cleaning supplies.
UPDATE inventory_items SET kind = 'furniture' WHERE account_id = 1 AND name IN (
  'Bath towels', 'Hand towels', 'Washcloths', 'Bath mats', 'Sheet sets', 'Pillowcases', 'Pillows', 'Mattress protectors',
  'Blankets / comforters', 'Kitchen towels', 'Plates', 'Bowls', 'Drinking glasses', 'Wine glasses', 'Mugs', 'Pots and pans',
  'Cooking utensils', 'Oven mitts', 'Forks', 'Knives', 'Spoons', 'Fire extinguisher', 'CO detector', 'Smoke detector',
  'First aid kit', 'HVAC filter', 'Tub stopper', 'Sink stopper', 'Cabinet handle / knob');
