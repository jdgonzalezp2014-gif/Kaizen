-- Each attempt to put a stay's check-in / check-out hour on the Hostaway
-- reservation (early check-in / late check-out). One row per attempt, kept:
-- the latest says whether the board's time is the guest's; the rows are the
-- Notes log's "⇄ Hostaway" lines.
CREATE TABLE stay_time_pushes (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT   NOT NULL REFERENCES accounts(id),
  reservation_id TEXT     NOT NULL,
  kind           TEXT     NOT NULL CHECK (kind IN ('checkin', 'checkout')),
  hour           SMALLINT CHECK (hour BETWEEN 0 AND 23),   -- what was sent; NULL when nothing could be
  standard       BOOLEAN  NOT NULL DEFAULT false,          -- back to the listing's hour
  outcome        TEXT     NOT NULL CHECK (outcome IN ('pushed', 'failed')),
  detail         TEXT,
  note           TEXT     NOT NULL,                        -- the log line, as shown
  unit_name      TEXT,
  guest          TEXT,
  check_in       DATE,
  created_by     TEXT     NOT NULL,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stay_time_pushes_res_idx ON stay_time_pushes (account_id, reservation_id, kind, id DESC);
