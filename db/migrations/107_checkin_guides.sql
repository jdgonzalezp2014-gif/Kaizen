-- Owner, 2026-11-09: a Check-in builder in the Repository. Per unit, the arrival steps the guest portal shows
-- before the record's own fields (address, Wi-Fi, parking…): a title, a line or two, and optionally a map pin
-- (opened in Google Maps or Apple Maps). Steps can be copied from another unit. 106 is kept for Wise (§172).
CREATE TABLE checkin_guides (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  unit_id    TEXT   NOT NULL,
  steps      JSONB  NOT NULL DEFAULT '[]',   -- [{ title, text, pin: { lat, lng } | null }], ≤ 8
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, unit_id)
);

-- The first guide, from the owner's slides "CheckIn_Guide_Unit_1304_EN" (The Links, P2-1304 = Hostaway 586502), as the
-- example to copy from. The lockbox code is the token {lockbox}: the guest sees the record's Lockbox, never a copy.
INSERT INTO checkin_guides (account_id, unit_id, steps, updated_by)
SELECT 1, '586502', '[{"title":"Drive to the parking garage","text":"The Links on PGA Parkway, 15201 Pleasant Ridge Way, Frisco. Head for the parking garage — a brick structure.","pin":{"lat":33.20623,"lng":-96.82592},"link":null},{"title":"Get your key fob from lockbox 1304","text":"Inside the garage you will see several lockboxes — use the one labeled 1304. Code: {lockbox}","pin":null,"link":null},{"title":"Exit the garage","text":"Take the stairs up to the exit level and go through the door marked EXIT. It opens onto the courtyard facing the buildings.","pin":null,"link":null},{"title":"Find your building","text":"Walk across the courtyard. Each entrance has a sign with the units it serves — look for the one that includes 1304 (1301–1329).","pin":null,"link":"https://drive.google.com/file/d/1rWXQQg6u9LHfvzTeBjSBE1r6eeSXPKOq/view"},{"title":"Go in and up the stairs","text":"Tap your fob on the reader next to the STAIR 1 · LEVEL 1 sign and go up to your floor. Each landing shows the level.","pin":null,"link":"https://drive.google.com/file/d/1bMlfjGXgsFuNHvvNo-cXz9xIVJ0EUXQF/view"},{"title":"Or take the elevator","text":"Easier with luggage or groceries — it takes you to the same hallway.","pin":null,"link":"https://drive.google.com/file/d/1x6vXbSwdqAWUY09VLwetfrABUFTahCnw/view"},{"title":"Your door","text":"Follow the hallway to 1304 — the olive-green door. Check the number next to the frame, enter your access code on the keypad and turn the handle down. Welcome!","pin":null,"link":null},{"title":"Trash","text":"Sun–Thu: one bag inside the valet can and one on top; leave the can outside your door between 5 and 7 PM.\nFri–Sat: take it to the trash room on the first floor — Building 1 near P2-1101, Building 4 near P2-4102.","pin":null,"link":null}]'::jsonb, 'seed: CheckIn_Guide_Unit_1304 slides'
 WHERE EXISTS (SELECT 1 FROM units WHERE account_id = 1 AND id::text = '586502')
ON CONFLICT (account_id, unit_id) DO NOTHING;
