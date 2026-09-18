-- Hostaway marks a listing that is not published with `specialStatus`
-- ("archived", and the UI also shows "Draft"). Stored so the portfolio
-- target can exclude it without a calendar sweep, the same way `parked`
-- is.
ALTER TABLE units ADD COLUMN special_status TEXT;
