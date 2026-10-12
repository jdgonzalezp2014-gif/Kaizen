-- The crew page in the cleaner's language (§129): English or Spanish. The team
-- sets each cleaner's default in Setup → Crew pages; the cleaner switches it
-- on their page, and it is remembered on every device they sign in from.
ALTER TABLE cleaners ADD COLUMN lang TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'es'));
