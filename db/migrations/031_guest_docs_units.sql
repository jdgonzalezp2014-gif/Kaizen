-- Which units ask each guest for an ID and a signed agreement (§73).
--
-- Not a rule in code any more: the right to ask depends on the building
-- (the P2 building requires it; others may not allow it), so it is a list
-- an admin keeps in Operations → Setup. By listing ID, so a renamed unit
-- keeps its setting. Starts as the daily file had it: the P2 units.
ALTER TABLE accounts ADD COLUMN guest_docs_units TEXT[] NOT NULL DEFAULT '{}';
UPDATE accounts SET guest_docs_units = ARRAY(SELECT u.id FROM units u WHERE u.name ~* '^P2' ORDER BY u.name)
 WHERE id = 1;
