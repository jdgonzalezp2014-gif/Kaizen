-- Slack (§99): notifications, the reservations reminder, and /kaizen.
--
-- The bot token and the signing secret are encrypted like every other
-- credential here. `slack_config` holds what is not secret: which channel
-- gets which topic, which events are announced, when the reminders go,
-- the app's address (for links back), and the cleaners' channels.
ALTER TABLE accounts
  ADD COLUMN slack_bot_token_enc      TEXT,
  ADD COLUMN slack_signing_secret_enc TEXT,
  ADD COLUMN slack_config             JSONB NOT NULL DEFAULT '{}'::jsonb;

-- What was sent on a clock, so an hourly scheduler never sends a reminder twice.
CREATE TABLE slack_sent (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  key        TEXT   NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
