-- Manual cleans (§79): the cleans no checkout schedules.
--
-- A guest leaves early, or asks for a clean mid-stay: the clean still has
-- to happen and be paid, and — when the guest left early — the clean the
-- checkout would have scheduled must NOT happen again later. These rows
-- live in the same record cleaners are paid from, keyed MAN-<n>, so the
-- calendar, the costs and the payroll count them with everything else.
-- The record's passes only ever touch reservation keys (digits), so a
-- manual row is never moved or voided by them.
ALTER TABLE cleanings
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkout'
             CHECK (kind IN ('checkout', 'early_departure', 'mid_stay', 'extra')),
  -- The stay a manual clean belongs to (its reservation id), when it has one.
  ADD COLUMN for_reservation TEXT,
  ADD COLUMN created_by TEXT;

CREATE SEQUENCE manual_clean_seq;
