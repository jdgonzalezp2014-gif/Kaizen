-- The cleans' daily thread is posted by the clock every morning (§136, the
-- owner: "debería ser automático"), listing the day's cleans; the list it was
-- posted with is kept so the message can be re-drawn as photos and "done"
-- arrive, without reading the board again.
ALTER TABLE clean_slack_posts ADD COLUMN cleans JSONB;
