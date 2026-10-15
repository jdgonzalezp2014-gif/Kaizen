-- Owner, 2026-10-15: a receipt read once is not read again. Keyed by what was sent (the files' bytes and a PDF's text),
-- not the file's name — Walmart's PDFs are all "Order details - Walmart.com.pdf". `order_no` (the store's order number)
-- warns when the same order comes back as another file (a screenshot of an order already read from its PDF).
CREATE TABLE IF NOT EXISTS receipt_reads (
  account_id  bigint      NOT NULL,
  hash        text        NOT NULL,
  raw         jsonb       NOT NULL,
  by          text        NOT NULL,
  store       text,
  order_no    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, hash)
);
CREATE INDEX IF NOT EXISTS receipt_reads_order ON receipt_reads (account_id, order_no) WHERE order_no IS NOT NULL;
