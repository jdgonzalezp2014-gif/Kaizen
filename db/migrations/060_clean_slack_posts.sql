-- The cleans' daily thread in Slack (§134): which message is the day's, and
-- which reply is a clean's photo line (updated as more photos arrive rather
-- than posted again). `ts` NULL = being posted right now — the row is taken
-- first, so two photos arriving together make one message, not two.
CREATE TABLE clean_slack_posts (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  -- 'day:<date>' or 'photos:<cleaning key>:<before|after>'
  key        TEXT   NOT NULL,
  channel    TEXT   NOT NULL,
  ts         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
