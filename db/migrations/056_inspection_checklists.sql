-- Inspections become a checklist (§133). The inspector walks the unit room
-- by room on a phone — the rooms come from the unit's bedrooms and bathrooms —
-- marking each item OK, needs attention, or not applicable. What needs
-- attention becomes work: a purchase (a to-do), a repair (a work order with
-- an "Assign and schedule" sub-task), or something for a clean to do.

-- The checklist template: items per area, edited in Setup. An item can be for
-- every unit (unit_id NULL) or one unit only.
CREATE TABLE inspection_items (
  id              BIGSERIAL PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  area            TEXT   NOT NULL CHECK (area IN ('general', 'living', 'kitchen', 'bedroom', 'bathroom', 'exterior')),
  label           TEXT   NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  -- What a failure usually becomes; the inspector can change it at the end.
  default_outcome TEXT   NOT NULL DEFAULT 'repair' CHECK (default_outcome IN ('repair', 'purchase', 'clean')),
  unit_id         TEXT,
  position        INT    NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspection_items_area_idx ON inspection_items (account_id, area, position);

-- An inspection in progress: started, not finished. A row with no result and
-- no start is still a plan (as before).
ALTER TABLE inspections ADD COLUMN started_at TIMESTAMPTZ;
ALTER TABLE inspections ADD COLUMN finished_at TIMESTAMPTZ;

-- What the inspector found, item by item — and what it became.
CREATE TABLE inspection_checks (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  inspection_id BIGINT NOT NULL REFERENCES inspections(id),
  -- NULL: added on the spot (the fixed "Cleaning / Repair / Purchase" buttons).
  item_id       BIGINT REFERENCES inspection_items(id),
  area          TEXT   NOT NULL,
  -- Which bedroom or bathroom (1, 2…); 1 for single areas.
  area_n        SMALLINT NOT NULL DEFAULT 1,
  label         TEXT   NOT NULL,
  result        TEXT   CHECK (result IN ('ok', 'attention', 'na')),
  note          TEXT,
  -- [{name, url, driveId}] in Google Drive.
  photos        JSONB  NOT NULL DEFAULT '[]'::jsonb,
  outcome       TEXT   CHECK (outcome IN ('repair', 'purchase', 'clean_next', 'clean_new', 'none')),
  todo_id       BIGINT,
  clean_task_id BIGINT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inspection_checks_item_idx ON inspection_checks (inspection_id, item_id, area_n) WHERE item_id IS NOT NULL;

-- Things for a clean to do, from an inspection: shown on the board's row and
-- on the cleaner's page with that clean. `cleaning_key` is the reservation of
-- a checkout clean, or MAN-<n> for a manual one.
CREATE TABLE clean_tasks (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  cleaning_key  TEXT   NOT NULL,
  unit_id       TEXT,
  unit_name     TEXT,
  clean_on      DATE,
  text          TEXT   NOT NULL,
  photos        JSONB  NOT NULL DEFAULT '[]'::jsonb,
  inspection_id BIGINT REFERENCES inspections(id),
  created_by    TEXT   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clean_tasks_key_idx ON clean_tasks (account_id, cleaning_key);

-- Handymen and suppliers. A directory for now; a vendor with an email can get
-- their own page later, as the cleaners did.
CREATE TABLE vendors (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  name       TEXT   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  trade      TEXT,
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_name_idx ON vendors (account_id, lower(name));

-- Work that came from an inspection says so.
ALTER TABLE todos ADD COLUMN inspection_id BIGINT;
-- Where inspection photos go in Drive (made on first use).
ALTER TABLE accounts ADD COLUMN inspection_photos_folder TEXT;

-- A starter checklist, quality-first. Edited in Setup → Inspection checklist.
INSERT INTO inspection_items (account_id, area, label, default_outcome, position, created_by) VALUES
  (1, 'general',  'Entry door, lock and keypad work', 'repair', 1, 'kaizen-os'),
  (1, 'general',  'Smoke and CO detectors work', 'repair', 2, 'kaizen-os'),
  (1, 'general',  'Wi-Fi works; network name and password posted', 'repair', 3, 'kaizen-os'),
  (1, 'general',  'Thermostat and A/C or heating work', 'repair', 4, 'kaizen-os'),
  (1, 'general',  'No smells, pests or signs of leaks', 'repair', 5, 'kaizen-os'),
  (1, 'living',   'Walls and ceiling: no marks, holes or stains', 'repair', 1, 'kaizen-os'),
  (1, 'living',   'Sofa and furniture clean and undamaged', 'clean', 2, 'kaizen-os'),
  (1, 'living',   'TV, remotes and lights work', 'repair', 3, 'kaizen-os'),
  (1, 'living',   'Floors and rugs clean', 'clean', 4, 'kaizen-os'),
  (1, 'kitchen',  'Kitchen stock: coffee, tea, sugar, oil, salt and pepper', 'purchase', 1, 'kaizen-os'),
  (1, 'kitchen',  'Cleaning stock: dish soap, sponges, paper towels, trash bags', 'purchase', 2, 'kaizen-os'),
  (1, 'kitchen',  'Fridge, oven, microwave and dishwasher clean and working', 'clean', 3, 'kaizen-os'),
  (1, 'kitchen',  'Dishes, glasses, cutlery and cookware complete and clean', 'purchase', 4, 'kaizen-os'),
  (1, 'kitchen',  'Sink and faucet: no leaks, drains well', 'repair', 5, 'kaizen-os'),
  (1, 'bedroom',  'Sheets and pillowcases clean, no stains or tears', 'purchase', 1, 'kaizen-os'),
  (1, 'bedroom',  'Mattress protector and pillows in good shape', 'purchase', 2, 'kaizen-os'),
  (1, 'bedroom',  'Walls: no marks, holes or stains', 'repair', 3, 'kaizen-os'),
  (1, 'bedroom',  'Closet: hangers, and nothing left behind', 'clean', 4, 'kaizen-os'),
  (1, 'bedroom',  'Lamps, outlets and blinds work', 'repair', 5, 'kaizen-os'),
  (1, 'bathroom', 'Towels: complete, clean, no stains', 'purchase', 1, 'kaizen-os'),
  (1, 'bathroom', 'Toiletries: toilet paper, soap, shampoo, conditioner', 'purchase', 2, 'kaizen-os'),
  (1, 'bathroom', 'Toilet, shower and sink clean; no hair or mildew', 'clean', 3, 'kaizen-os'),
  (1, 'bathroom', 'No leaks; good water pressure and hot water', 'repair', 4, 'kaizen-os'),
  (1, 'bathroom', 'Grout, caulking and mirror in good shape', 'repair', 5, 'kaizen-os'),
  (1, 'exterior', 'Entrance and patio clean, furniture in place', 'clean', 1, 'kaizen-os'),
  (1, 'exterior', 'Outdoor lights work', 'repair', 2, 'kaizen-os'),
  (1, 'exterior', 'Pool / hot tub (if any): clean and working', 'repair', 3, 'kaizen-os');
