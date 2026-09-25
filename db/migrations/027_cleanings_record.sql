-- The cleanings record, made trustworthy enough to pay from (§70).
--
-- Found on live data (2026-09-25): cancelled bookings still counted as
-- cleans, an iCal block inside a real stay counted as a second clean on
-- the same day, and the imported history still held the unfolded version
-- the daily file had since collapsed — Amber Valley three times at $170
-- on one day, three separate times.

-- A row that is NOT a clean, and why. Never deleted: a record you can
-- only see the corrected version of cannot be checked against an invoice.
-- Every total, calendar and payroll figure reads `void_reason IS NULL`.
ALTER TABLE cleanings ADD COLUMN void_reason TEXT;

-- Who decided the cleaner: 'rule', 'override:<email>', 'daily file
-- (cutover)', 'sheet', 'history'. A pay dispute starts with this question.
ALTER TABLE cleanings ADD COLUMN decided_by TEXT;
UPDATE cleanings SET decided_by = CASE
  WHEN key LIKE 'IMP-%' THEN 'history'
  WHEN source = 'sheet' THEN 'sheet'
  ELSE 'rule' END;

-- History lines for the same unit, day and price are one clean captured
-- twice — the daily file's own folding rule ("indistinguishable from one
-- line captured twice; collapsed to one"). It deliberately UNDER-counts:
-- a missing row shows against the invoice and can be put back; an extra
-- one is silently paid.
WITH ranked AS (
  SELECT account_id, key, row_number() OVER (
           PARTITION BY account_id, lower(regexp_replace(unit_name, '[^a-zA-Z0-9]', '', 'g')), checkout_on, price
           ORDER BY key) AS rn
    FROM cleanings WHERE key LIKE 'IMP-%')
UPDATE cleanings c SET void_reason = 'duplicate history line: same unit, day and price'
  FROM ranked r
 WHERE c.account_id = r.account_id AND c.key = r.key AND r.rn > 1;

-- A history line on a day the unit also has a clean tied to a real
-- reservation is that same clean, seen twice. The reservation's row wins:
-- it knows the booking; the history line only knows the day.
UPDATE cleanings h SET void_reason = 'same clean as reservation ' || r.key
  FROM cleanings r
 WHERE h.account_id = r.account_id AND h.key LIKE 'IMP-%' AND h.void_reason IS NULL
   AND r.key ~ '^[0-9]+$' AND r.void_reason IS NULL AND h.checkout_on = r.checkout_on
   AND lower(regexp_replace(h.unit_name, '[^a-zA-Z0-9]', '', 'g')) =
       lower(regexp_replace(r.unit_name, '[^a-zA-Z0-9]', '', 'g'));

CREATE INDEX cleanings_counted_idx ON cleanings (account_id, checkout_on) WHERE void_reason IS NULL;
