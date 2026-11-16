-- §175: what each cleaner was last told about their schedule (their channel's "changes" notice) —
-- the next check compares the schedule against this, like "Changes since" does against the daily snapshot.
CREATE TABLE IF NOT EXISTS crew_notified (
  account_id BIGINT NOT NULL,
  cleaner    TEXT NOT NULL,
  day        DATE NOT NULL,
  through    DATE NOT NULL,
  vis        JSONB NOT NULL,
  items      JSONB NOT NULL,
  told_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, cleaner)
);
