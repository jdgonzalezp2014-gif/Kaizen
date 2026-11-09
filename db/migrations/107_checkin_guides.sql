-- Owner, 2026-11-09: a Check-in builder in the Repository. Per unit, the arrival steps the guest portal shows
-- before the record's own fields (address, Wi-Fi, parking…): a title, a line or two, and optionally a map pin
-- (opened in Google Maps or Apple Maps). Steps can be copied from another unit. 106 is kept for Wise (§172).
CREATE TABLE checkin_guides (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  unit_id    TEXT   NOT NULL,
  steps      JSONB  NOT NULL DEFAULT '[]',   -- [{ title, text, pin: { lat, lng } | null }], ≤ 8
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, unit_id)
);
