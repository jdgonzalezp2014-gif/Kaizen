-- Slack threads ↔ Kaizen (§107): which task or claim a message Kaizen posted
-- is about, so "@Kaizen …" in its thread becomes a comment on it.
CREATE TABLE slack_threads (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  channel    TEXT   NOT NULL,
  ts         TEXT   NOT NULL,
  subject    TEXT   NOT NULL CHECK (subject IN ('task', 'claim')),
  subject_id TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, channel, ts)
);
CREATE INDEX slack_threads_subject_idx ON slack_threads (account_id, subject, subject_id);
