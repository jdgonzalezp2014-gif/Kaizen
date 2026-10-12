-- Two corrections to the cleanings record (§123).
--
-- 1. A booking cancelled ON OR AFTER its arrival day may or may not have
--    used the unit (a guest who left mid-stay, or a Booking.com no-show
--    marked cancelled afterwards). Hostaway cannot tell which, so the clean
--    is held as TBD — unpaid — with this note, until a person confirms who
--    cleaned it or that no clean was needed. NULL = nothing to confirm.
ALTER TABLE cleanings ADD COLUMN needs_confirm TEXT;
-- Who settled it. Once set, the daily reconcile leaves the row alone.
ALTER TABLE cleanings ADD COLUMN confirmed_by TEXT;
ALTER TABLE cleanings ADD COLUMN confirmed_at TIMESTAMPTZ;

-- 2. A clean already done, corrected by hand: a "deep" that was not done
--    as one, a price that was wrong. Who, when and why are kept, and the
--    cleaner sees the note on their page.
ALTER TABLE cleanings ADD COLUMN edited_by TEXT;
ALTER TABLE cleanings ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE cleanings ADD COLUMN edit_note TEXT;
