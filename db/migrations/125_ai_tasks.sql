-- Which AI answers each job, in order (owner, 2026-11-23) — src/lib/ai-tasks.ts. NULL / a missing task = its default chain.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_tasks jsonb;
