-- A booking cancelled before arrival leaves no clean and nobody on it (§130).
-- These rows kept the cleaner's name and price after being voided, which read
-- as work still assigned. Who had it is kept in decided_by. Rows held for a
-- person (cancelled after arrival) or already settled are not touched.
UPDATE cleanings
   SET assignment = 'not_needed',
       decided_by = 'cancelled before arrival' || COALESCE(' — it was ' || cleaner || '''s', ''),
       cleaner = NULL, price = NULL
 WHERE void_reason = 'booking cancelled in Hostaway'
   AND needs_confirm IS NULL AND confirmed_by IS NULL
   AND (assignment <> 'not_needed' OR cleaner IS NOT NULL);
