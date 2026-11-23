-- Owner, 2026-11-23: bad guest experiences are kept on record, and a stay with one is not asked for a review.
-- One open record per stay (the triage of a guest message, or a person in the CRM); clearing it keeps the row.
CREATE TABLE IF NOT EXISTS guest_issues (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL,
  reservation_id  text NOT NULL,
  conversation_id text,
  listing_id      text,
  why             text NOT NULL,
  source          text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'team')),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cleared_at      timestamptz,
  cleared_by      text
);
CREATE UNIQUE INDEX IF NOT EXISTS guest_issues_open_once ON guest_issues (account_id, reservation_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS guest_issues_recent ON guest_issues (account_id, created_at DESC);
