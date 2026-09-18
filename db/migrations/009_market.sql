-- Reader credentials for the listing-page fetch. Airbnb serves a JS
-- shell to a plain request and redirects datacenter IPs to its home
-- page, so a rendering proxy is required; the keyed tier of one uses
-- residential egress. Encrypted like every other credential here.
ALTER TABLE accounts ADD COLUMN jina_api_key_enc TEXT;

-- price_observations already carries airbnb_rate / airbnb_rating /
-- airbnb_reviews. What it lacked is where the number came from, which
-- is the difference between a reading to trust and one to re-check.
ALTER TABLE price_observations ADD COLUMN source TEXT;
ALTER TABLE price_observations ADD COLUMN note   TEXT;
