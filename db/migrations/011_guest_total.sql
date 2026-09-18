-- What the guest is actually quoted for the stay, kept alongside the
-- nightly figure derived from it.
--
-- The two are not interchangeable and storing only one loses something:
-- the nightly rate is what compares across units and dates, while the
-- total is what a guest sees and what includes the fees and tax that
-- make our own asking price and their quote differ. Recomputing either
-- from the other needs the night count, which is exactly what goes
-- missing first.
ALTER TABLE price_observations ADD COLUMN airbnb_total NUMERIC(12,2);
ALTER TABLE price_observations ADD COLUMN window_end   DATE;
