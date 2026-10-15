-- Reports (owner, 2026-10-15): bugs and requests about Kaizen itself, from the
-- app's "Report" button and from Slack (@Kaizen bug / /kaizen bug). Separate from
-- the team's to-dos: these are for whoever builds Kaizen, not for Operations.
CREATE TABLE reports (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  kind          TEXT   NOT NULL CHECK (kind IN ('bug', 'request')),
  body          TEXT   NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  urgency       TEXT   NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'blocking')),
  status        TEXT   NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'doing', 'done', 'wontfix')),
  -- Where it was sent from: the screen ("Operations › To-do") or the Slack channel.
  where_from    TEXT,
  device        TEXT,
  source        TEXT   NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'slack')),
  reporter      TEXT   NOT NULL,
  slack_user    TEXT,
  -- One photo, small (resized in the browser): kept here, shown through /api/reports?photo=<id>.
  photo         BYTEA,
  photo_type    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_account_idx ON reports (account_id, created_at DESC);

CREATE TABLE report_comments (
  id         BIGSERIAL PRIMARY KEY,
  report_id  BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  body       TEXT   NOT NULL,
  author     TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX report_comments_report_idx ON report_comments (report_id, created_at);

-- A report's card in Slack is its thread: a reply there is a comment, like a task's.
ALTER TABLE slack_threads DROP CONSTRAINT IF EXISTS slack_threads_subject_check;
ALTER TABLE slack_threads ADD CONSTRAINT slack_threads_subject_check CHECK (subject IN ('task', 'claim', 'report'));
