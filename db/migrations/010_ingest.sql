-- A shared secret for machine ingestion.
--
-- Apps Script cannot sign in through Cloudflare Access, and it is the
-- one client that must reach this app without a browser. It gets its own
-- credential rather than a person's: revoking it must never cost anybody
-- their login, and its writes must be attributable to it.
ALTER TABLE accounts ADD COLUMN ingest_token_enc TEXT;
