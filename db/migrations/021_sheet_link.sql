-- The published-CSV link is what the importer reads; it is not a page a
-- person can open and edit. Keeping the editing link separately means the
-- button goes where the work is done rather than to a file download.
ALTER TABLE accounts ADD COLUMN cleanings_sheet_url TEXT;
