-- What a cleaner needs to get into a unit (§136): its address and Wi-Fi, from
-- Hostaway (the guests' own data, complete for every listing), refreshed by
-- every units sync. The door code Hostaway carries is the guests' — kept only
-- as a last resort when the team has not written a cleaner code in the
-- Repository, and labelled as such wherever it is shown.
ALTER TABLE units ADD COLUMN address       TEXT;
ALTER TABLE units ADD COLUMN wifi_name     TEXT;
ALTER TABLE units ADD COLUMN wifi_password TEXT;
ALTER TABLE units ADD COLUMN door_code     TEXT;
