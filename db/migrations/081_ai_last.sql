-- Owner, 2026-10-14: the model chain behind Slack's ✨ Suggest (Gemini → flash-lite → Workers AI) —
-- who answered last, or why none did, for Settings.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_last JSONB;
