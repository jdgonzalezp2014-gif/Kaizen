-- The guest each clean prepares the unit for (§131): the next reservation
-- after its checkout, as the board saw it when it recorded the clean. When a
-- booking lands in between, the cleaner the rule had given the clean before
-- that guest keeps it — they take the new booking's checkout.
ALTER TABLE cleanings ADD COLUMN prepares_for TEXT;
