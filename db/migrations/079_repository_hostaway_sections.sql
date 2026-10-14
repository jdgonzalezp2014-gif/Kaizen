-- Repository ⇄ Hostaway by section (§155). The three Units tables get the listing's fields as
-- columns, grouped: House settings · House description · House rules · Fees · Hostaway settings.
-- A group other than Details is a section the grid folds into one column; the check view
-- (src/lib/repo-checks.ts, CHECKS) compares the same columns with the live listing.
-- Wi-Fi keeps its columns where they are (marked ⇄ in the grid); the guest cleaning fee moves into Fees.
-- Values are filled from Hostaway through the check view, one unit at a time — not here.

WITH cols (key, title, type, grp, hour, position) AS (VALUES
  ('checkin_from', 'Check-in from', 'select', 'House settings', TRUE, 43),
  ('checkin_until', 'Check-in until', 'select', 'House settings', TRUE, 44),
  ('checkout_time', 'Check-out by', 'select', 'House settings', TRUE, 45),
  ('max_guests', 'Max guests', 'number', 'House settings', FALSE, 46),
  ('guests_included', 'Guests included in the price', 'number', 'House settings', FALSE, 47),
  ('listing_title', 'Listing title', 'text', 'House description', FALSE, 48),
  ('description', 'Description', 'longtext', 'House description', FALSE, 49),
  ('summary', 'Summary', 'longtext', 'House description', FALSE, 50),
  ('the_space', 'The space', 'longtext', 'House description', FALSE, 51),
  ('guest_access', 'Guest access', 'longtext', 'House description', FALSE, 52),
  ('interaction', 'Interaction with guests', 'longtext', 'House description', FALSE, 53),
  ('neighborhood', 'The neighborhood', 'longtext', 'House description', FALSE, 54),
  ('getting_around', 'Getting around', 'longtext', 'House description', FALSE, 55),
  ('other_notes', 'Other things to note', 'longtext', 'House description', FALSE, 56),
  ('house_rules', 'House rules (original)', 'longtext', 'House rules', FALSE, 57),
  ('rule_add_pet_fee', 'Add: pet fee', 'longtext', 'House rules', FALSE, 58),
  ('rule_add_lost_fob', 'Add: lost key / fob', 'longtext', 'House rules', FALSE, 59),
  ('rule_add_extra_guest', 'Add: extra guests', 'longtext', 'House rules', FALSE, 60),
  ('rule_add_other', 'Add: other', 'longtext', 'House rules', FALSE, 61),
  ('extra_guest_fee', 'Extra guest fee (per night)', 'number', 'Fees', FALSE, 63),
  ('pet_fee', 'Pet fee (Airbnb)', 'number', 'Fees', FALSE, 64),
  ('damage_deposit', 'Refundable damage deposit', 'number', 'Fees', FALSE, 65),
  ('checkin_fee', 'Check-in fee', 'number', 'Fees', FALSE, 66),
  ('insurance_fee', 'Insurance (per night)', 'number', 'Fees', FALSE, 67),
  ('tax_rent_pct', 'Rent tax (%)', 'number', 'Fees', FALSE, 68),
  ('tax_stay', 'Tax per stay', 'number', 'Fees', FALSE, 69),
  ('tax_nightly', 'Tax per night', 'number', 'Fees', FALSE, 70),
  ('tax_per_person_night', 'Tax per guest per night', 'number', 'Fees', FALSE, 71),
  ('hw_bedrooms', 'Bedrooms', 'number', 'Hostaway settings', FALSE, 72),
  ('hw_beds', 'Beds', 'number', 'Hostaway settings', FALSE, 73),
  ('hw_bathrooms', 'Bathrooms', 'number', 'Hostaway settings', FALSE, 74),
  ('hw_size', 'Size (as in Hostaway)', 'number', 'Hostaway settings', FALSE, 75),
  ('hw_room_type', 'Room type', 'text', 'Hostaway settings', FALSE, 76),
  ('hw_min_nights', 'Min nights', 'number', 'Hostaway settings', FALSE, 77),
  ('hw_max_nights', 'Max nights', 'number', 'Hostaway settings', FALSE, 78),
  ('hw_cancellation', 'Cancellation policy', 'text', 'Hostaway settings', FALSE, 79),
  ('hw_instant_book', 'Instant booking', 'checkbox', 'Hostaway settings', FALSE, 80),
  ('hw_same_day', 'Same-day booking', 'checkbox', 'Hostaway settings', FALSE, 81),
  ('hw_address', 'Address', 'text', 'Hostaway settings', FALSE, 82),
  ('hw_public_address', 'Public address', 'text', 'Hostaway settings', FALSE, 83),
  ('hw_contact_name', 'Contact name', 'text', 'Hostaway settings', FALSE, 84),
  ('hw_contact_phone', 'Contact phone', 'text', 'Hostaway settings', FALSE, 85),
  ('hw_time_zone', 'Time zone', 'text', 'Hostaway settings', FALSE, 86),
  ('hw_airbnb_title', 'Airbnb title', 'text', 'Hostaway settings', FALSE, 87),
  ('hw_vrbo_title', 'Vrbo title', 'text', 'Hostaway settings', FALSE, 88),
  ('hw_vrbo_headline', 'Vrbo headline', 'text', 'Hostaway settings', FALSE, 89),
  ('hw_vrbo_description', 'Vrbo description', 'longtext', 'Hostaway settings', FALSE, 90),
  ('hw_booking_title', 'Booking.com title', 'text', 'Hostaway settings', FALSE, 91),
  ('hw_booking_room', 'Booking.com room name', 'text', 'Hostaway settings', FALSE, 92),
  ('hw_booking_description', 'Booking.com description', 'longtext', 'Hostaway settings', FALSE, 93)
)
INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, options, position)
SELECT 1, t, c.key, c.title, c.type, c.grp, CASE WHEN c.hour THEN ARRAY['12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '5 AM', '6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM'] END, c.position
  FROM cols c CROSS JOIN unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;

UPDATE repo_columns SET grp = 'Fees', position = 62
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND key = 'cleaning_fee';
-- "Password" next to "Wifi Network" read like an account password.
UPDATE repo_columns SET title = 'Wifi password'
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND key = 'password_2';

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.add', t, NULL,
       '50 columns in sections House settings / House description / House rules / Fees / Hostaway settings, compared with Hostaway (§155); Cleaning fee moved into Fees; Password → Wifi password'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;
