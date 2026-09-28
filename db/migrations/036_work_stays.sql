-- Work and claims tied to a stay (§84) — the way a manual clean is (§79).
--
-- A to-do, a work order or a claim is often about ONE reservation: a
-- guest's complaint, a repair a stay caused, an eviction. The stay is
-- picked as for a manual clean (unit + day → Hostaway's stays that day)
-- and kept with a readable label, so the list says which guest without
-- asking Hostaway again.
ALTER TABLE todos
  ADD COLUMN reservation_id    TEXT CHECK (reservation_id ~ '^[0-9]{1,20}$'),
  ADD COLUMN reservation_label TEXT CHECK (length(reservation_label) <= 160);
ALTER TABLE claims
  ADD COLUMN reservation_id    TEXT CHECK (reservation_id ~ '^[0-9]{1,20}$'),
  ADD COLUMN reservation_label TEXT CHECK (length(reservation_label) <= 160);
