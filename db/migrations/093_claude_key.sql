-- Owner, 2026-10-15: Claude as the AI chain's last resort (after Gemini and Workers AI), only when a key is stored.
-- Encrypted like every other credential (functions/_lib/crypto.ts), never returned to the browser.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS claude_api_key_enc text;
