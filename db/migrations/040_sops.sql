-- SOPs and articles (§92): how the work is done, kept next to where it is done.
--
-- Two axes, on purpose. A SECTION is a process area of the business — the
-- library is browsed by it, and a thin section is a gap you can see. The
-- FEATURES are the screens of this app an SOP is shown on: each screen's
-- "SOPs" button lists the procedures for the work done there. One SOP can
-- sit on several screens; it lives in one section.
--
-- An SOP is versioned: every change to what it says is a snapshot in
-- sop_versions with who and why, because "what did the procedure say when
-- this went wrong?" is the question an SOP library exists to answer.

CREATE TABLE sop_sections (
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  key         TEXT   NOT NULL CHECK (key ~ '^[a-z0-9-]{2,40}$'),
  label       TEXT   NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  description TEXT,
  sort        INT    NOT NULL DEFAULT 100,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (account_id, key)
);

-- The value chain of a short-term rental operator, in the order a stay moves through it.
INSERT INTO sop_sections (account_id, key, label, description, sort) VALUES
  (1, 'guest',       'Guest lifecycle',        'Booking, pre-arrival, check-in, the stay, check-out and guest messages.', 10),
  (1, 'compliance',  'Buildings & compliance', 'Guest ID, rental agreements, building rules and regulations.', 20),
  (1, 'turnover',    'Turnovers & cleaning',   'Cleans, same-day turnovers, early departures, cleaner pay.', 30),
  (1, 'inspections', 'Inspections & quality',  'When a unit is inspected, what is checked, what happens to findings.', 40),
  (1, 'maintenance', 'Maintenance & repairs',  'Work orders, vendors, costs and follow-up.', 50),
  (1, 'claims',      'Claims & disputes',      'Guest complaints, platform cases, refunds and damage.', 60),
  (1, 'revenue',     'Pricing & revenue',      'Rates, minimum stays, units in red and pricing decisions.', 70),
  (1, 'finance',     'Costs & finance',        'Expenses, cleaning costs, month-end.', 80),
  (1, 'systems',     'Systems & access',       'Kaizen OS, Hostaway, Google Drive, the repository and who can see what.', 90),
  (1, 'team',        'Team & onboarding',      'Roles, training and how we write and keep SOPs.', 100);

CREATE TABLE sops (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  section_key TEXT   NOT NULL,
  -- 'sop': a procedure with steps. 'article': reference text — a policy, a how-to, background.
  kind        TEXT   NOT NULL DEFAULT 'sop' CHECK (kind IN ('sop', 'article')),
  title       TEXT   NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  -- Drafts are seen by editors only; archived ones stay for the record.
  status      TEXT   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  purpose     TEXT,
  trigger     TEXT,
  owner       TEXT,
  done_when   TEXT,
  -- [{ "text": "...", "who": "..." }], in order.
  steps       JSONB  NOT NULL DEFAULT '[]'::jsonb,
  body        TEXT,
  -- App screens this shows on (src/lib/sops.ts FEATURES), e.g. 'operations.todos'.
  features    TEXT[] NOT NULL DEFAULT '{}',
  review_days INT    NOT NULL DEFAULT 180 CHECK (review_days BETWEEN 7 AND 1095),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  version     INT    NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT,
  FOREIGN KEY (account_id, section_key) REFERENCES sop_sections (account_id, key)
);
CREATE INDEX sops_features_idx ON sops USING GIN (features) WHERE deleted_at IS NULL;
CREATE INDEX sops_section_idx ON sops (account_id, section_key) WHERE deleted_at IS NULL;

CREATE TABLE sop_versions (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  sop_id     BIGINT NOT NULL REFERENCES sops(id),
  version    INT    NOT NULL,
  -- What it said: title, kind, purpose, trigger, owner, done_when, steps, body.
  snapshot   JSONB  NOT NULL,
  note       TEXT,
  edited_by  TEXT,
  edited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sop_id, version)
);

-- Everyone reads the procedures; the roles that set up operations write them.
UPDATE roles SET permissions = array_append(permissions, 'sops'), updated_at = now()
 WHERE key <> 'admin' AND NOT ('sops' = ANY(permissions));
UPDATE roles SET permissions = array_append(permissions, 'sops.edit'), updated_at = now()
 WHERE key <> 'admin' AND 'operations.setup' = ANY(permissions) AND NOT ('sops.edit' = ANY(permissions));
