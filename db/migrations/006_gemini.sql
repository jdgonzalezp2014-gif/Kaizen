-- Gemini credentials, per account, encrypted at rest — the same
-- treatment the Hostaway key gets and for the same reason: a leaked
-- database dump alone must not hand over anyone's billing.
ALTER TABLE accounts ADD COLUMN gemini_api_key_enc TEXT;
ALTER TABLE accounts ADD COLUMN gemini_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash';
