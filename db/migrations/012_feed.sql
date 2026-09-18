-- A published-CSV feed from Apps Script, the same shape the cleanings
-- sheet already uses: no inbound request, so no Access bypass and no
-- token to rotate, and the sheet stays readable by a human.
ALTER TABLE accounts ADD COLUMN feed_csv_url TEXT;

-- Pulling the same CSV twice must not double the series.
--
-- price_observations is append-only by design, which is right for a
-- reading taken once — but a poll re-reads the same rows every time it
-- runs. The key is what the FEED says about itself: the unit, the stay
-- window, and when Apps Script read it. Re-importing an unchanged sheet
-- is then a no-op rather than a fresh set of identical observations.
ALTER TABLE price_observations ADD COLUMN feed_key TEXT;
CREATE UNIQUE INDEX price_obs_feed_key_idx
  ON price_observations (account_id, feed_key)
  WHERE feed_key IS NOT NULL;
