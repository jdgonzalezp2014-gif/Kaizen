-- The Hostaway access token, kept between requests.
--
-- Every request was asking Hostaway for a new token before fetching
-- anything: 1.5–2 s each time, measured, for a token Hostaway issues for
-- 731 days. The module-level copy only survived inside one warm isolate,
-- which on Cloudflare is often a single request.
--
-- This is a CREDENTIAL, not data: nothing shown on a screen is read from
-- it, so keeping it cannot make a number stale. It is encrypted like the
-- API key it is derived from, cleared whenever the key is replaced, and
-- replaced the first time Hostaway refuses it.
ALTER TABLE accounts ADD COLUMN hostaway_token_enc        TEXT;
ALTER TABLE accounts ADD COLUMN hostaway_token_expires_at TIMESTAMPTZ;
