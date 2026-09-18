-- gemini-2.5-flash was retired: the API now answers 404 with "no longer
-- available to new users". A default that names a dead model fails only
-- for accounts that never set one — which is every new tenant, and none
-- of the existing ones, so it would have gone unnoticed here.
ALTER TABLE accounts ALTER COLUMN gemini_model SET DEFAULT 'gemini-3.6-flash';
UPDATE accounts SET gemini_model = 'gemini-3.6-flash' WHERE gemini_model = 'gemini-2.5-flash';
