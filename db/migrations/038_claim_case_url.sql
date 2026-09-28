-- The claim's case on the platform (§88): the Airbnb Resolution Center,
-- Booking.com or Vrbo page where the claim is actually argued. It was
-- being pasted into updates, where it is one line among many.
ALTER TABLE claims ADD COLUMN case_url TEXT CHECK (case_url ~ '^https://' AND length(case_url) <= 1000);

-- Claims that already carry such a link in their timeline get it, once.
UPDATE claims c SET case_url = sub.url
  FROM (SELECT DISTINCT ON (w.subject_id) w.subject_id, substring(w.body from 'https://[^[:space:]]+') AS url
          FROM work_updates w
         WHERE w.account_id = 1 AND w.subject = 'claim'
           AND w.body ~ 'https://[^[:space:]]*(airbnb|booking|vrbo|expedia)\.'
         ORDER BY w.subject_id, w.created_at) sub
 WHERE c.account_id = 1 AND c.id::text = sub.subject_id AND c.case_url IS NULL;
