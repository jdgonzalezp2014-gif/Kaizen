-- §150, owner. (1) An inspector only REQUESTS: the inspection's purchases are
-- an order of their own kind, processed as a purchase like a cleaner's request
-- (closing it with nothing bought asks first).
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_clean_group_check;
ALTER TABLE todos ADD CONSTRAINT todos_clean_group_check CHECK (clean_group IN ('problem', 'request', 'bought', 'inspection'));
UPDATE todos SET clean_group = 'inspection'
 WHERE inspection_id IS NOT NULL AND parent_id IS NULL AND clean_group IS NULL AND title LIKE 'Buy for %';

-- (2) Who paid a purchase: NULL = the company; a name = someone who brought it
-- with their own money and is to be paid back — until someone marks it paid.
ALTER TABLE inventory_purchases ADD COLUMN paid_by      TEXT;
ALTER TABLE inventory_purchases ADD COLUMN paid_back_at TIMESTAMPTZ;
ALTER TABLE inventory_purchases ADD COLUMN paid_back_by TEXT;
