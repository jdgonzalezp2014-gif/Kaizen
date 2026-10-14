-- Owner, 2026-10-14: a thread linked by "Add to…" is a conversation — its replies are not all saved (volume);
-- one is saved when someone reacts 📎 (or writes @Kaizen). A thread Kaizen posted (a task's or claim's own
-- message) keeps saving its plain replies (§153).
ALTER TABLE slack_threads ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'kaizen' CHECK (via IN ('kaizen', 'addto'));
