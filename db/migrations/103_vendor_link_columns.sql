-- 099 was applied (2026-10-26 00:50 UTC) before its last two lines were added (a5a0a3f, the handyman's own page link),
-- so production never got them: "Copy their link" and /api/crew-link for handymen failed. IF NOT EXISTS: a database
-- that ran the full 099 is left as it is.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS link_token_hash TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS link_token_enc TEXT;
