-- A short-lived answer kept for everyone (owner, Oct 2026): Home's "Units in red" read every calendar in
-- Hostaway on each visit. *.pages.dev has no usable Cache API, so the answer is kept here for minutes.
CREATE TABLE api_cache (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  key        TEXT   NOT NULL,
  body       JSONB  NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
