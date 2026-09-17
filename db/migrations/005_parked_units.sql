-- The parked verdict, stored.
--
-- Deciding it needs one calendar request per listing, which is far too
-- much to repeat on every dashboard load. It is computed at sync time
-- and read cheaply afterwards. `parked_checked_at` is here so a stale
-- verdict can be recognised as stale rather than trusted forever.
ALTER TABLE units ADD COLUMN parked            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE units ADD COLUMN parked_checked_at TIMESTAMPTZ;
