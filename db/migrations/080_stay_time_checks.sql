-- §156: a time change is checked with the cleaner first; a later check-out can close
-- that night in Hostaway; a reminder goes to the cleaner's own Slack channel.
ALTER TABLE stay_time_pushes
  ADD COLUMN checked_with TEXT,
  ADD COLUMN block_night  DATE,      -- the night asked to be closed
  ADD COLUMN block_ok     BOOLEAN,
  ADD COLUMN block_detail TEXT,
  ADD COLUMN reminder     TEXT;      -- 'sent to #channel' / why not
