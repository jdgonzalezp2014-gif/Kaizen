-- "🚫 Not needed" and "❓ TBD" are not cleaners, they are the absence of
-- one — and they were being counted as people in the by-cleaner
-- breakdown and as cleans in the headline.
--
-- The distinction matters for the count: a stay where no clean was
-- needed is not a clean. Counting it inflates the number and makes the
-- average cost per clean look lower than it is.
ALTER TABLE cleanings ADD COLUMN assignment TEXT NOT NULL DEFAULT 'assigned'
  CHECK (assignment IN ('assigned', 'tbd', 'not_needed'));

-- The notes column carries RESERVATION notes — "guest extending",
-- "reservation cancelled", "late checkout unpaid" — not remarks about
-- the cleaning. Renamed so nothing reads it as a comment on the work.
ALTER TABLE cleanings RENAME COLUMN notes TO reservation_note;
