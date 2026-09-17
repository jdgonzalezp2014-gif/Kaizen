-- Multi-tenant shape.
--
-- Hostaway credentials were going to be deployment environment
-- variables, which works exactly once: one deployment, one property
-- manager, forever. Moving them into the database and scoping every row
-- to an account means a second customer is a row rather than a second
-- deployment.
--
-- This is done NOW because it is nearly free now and brutal later. Adding
-- account_id to five populated tables, backfilling it, and auditing every
-- query for a missing filter is the kind of migration that leaks one
-- tenant's revenue into another's dashboard. Adding it while `units` is
-- empty costs one file.
--
-- To be clear about what this is NOT: a single-row accounts table is not
-- production multi-tenancy. There is no row-level security, no per-tenant
-- rate limiting, and no billing. What it buys is that adding those later
-- is additive rather than a rewrite.

CREATE TABLE accounts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT NOT NULL,
  -- Hostaway credentials, entered in the app rather than baked into a
  -- deployment. The key is stored ENCRYPTED: see functions/_lib/crypto.ts.
  -- The encryption key lives in the environment, so a leaked database
  -- dump alone does not hand over anyone's Hostaway account.
  hostaway_account_id   TEXT,
  hostaway_api_key_enc  TEXT,
  -- Per-account settings that used to be global app_config.
  target_net_per_unit   NUMERIC(12,2) NOT NULL DEFAULT 1500,
  occ_floor_pct         INTEGER NOT NULL DEFAULT 60,
  stay_nights           INTEGER NOT NULL DEFAULT 30,
  -- Who may sign in to this account. Cloudflare Access authenticates;
  -- this decides which tenant the authenticated person belongs to.
  allowed_emails        TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The one tenant that exists today. Everything below backfills to it, so
-- nothing breaks and no code has to special-case "no account yet".
INSERT INTO accounts (id, name) OVERRIDING SYSTEM VALUE VALUES (1, 'Kaizen Guest Properties');
SELECT setval(pg_get_serial_sequence('accounts', 'id'), 1, true);

-- ── scope every tenant-owned table ───────────────────────────────────
ALTER TABLE units              ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1 REFERENCES accounts(id);
ALTER TABLE expenses           ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1 REFERENCES accounts(id);
ALTER TABLE claims             ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1 REFERENCES accounts(id);
ALTER TABLE price_observations ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1 REFERENCES accounts(id);
ALTER TABLE pricing_decisions  ADD COLUMN account_id BIGINT NOT NULL DEFAULT 1 REFERENCES accounts(id);

-- The DEFAULT exists only to backfill the row that is already there. Drop
-- it so a future insert that forgets account_id fails loudly instead of
-- silently filing another tenant's data under account 1.
ALTER TABLE units              ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE expenses           ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE claims             ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE price_observations ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE pricing_decisions  ALTER COLUMN account_id DROP DEFAULT;

-- A Hostaway listing id is only unique within its own Hostaway account,
-- so the primary key has to include the tenant. Two customers can both
-- have listing "366041" and they are different apartments.
--
-- Order matters: the dependent foreign keys must go BEFORE the primary
-- key they reference, or Postgres refuses to drop it.
ALTER TABLE expenses           DROP CONSTRAINT expenses_unit_id_fkey;
ALTER TABLE claims             DROP CONSTRAINT claims_unit_id_fkey;
ALTER TABLE price_observations DROP CONSTRAINT price_observations_unit_id_fkey;
ALTER TABLE pricing_decisions  DROP CONSTRAINT pricing_decisions_unit_id_fkey;

ALTER TABLE units DROP CONSTRAINT units_pkey;
ALTER TABLE units ADD  CONSTRAINT units_pkey PRIMARY KEY (account_id, id);

ALTER TABLE expenses           ADD CONSTRAINT expenses_unit_fkey
  FOREIGN KEY (account_id, unit_id) REFERENCES units(account_id, id);
ALTER TABLE claims             ADD CONSTRAINT claims_unit_fkey
  FOREIGN KEY (account_id, unit_id) REFERENCES units(account_id, id);
ALTER TABLE price_observations ADD CONSTRAINT price_obs_unit_fkey
  FOREIGN KEY (account_id, unit_id) REFERENCES units(account_id, id);
ALTER TABLE pricing_decisions  ADD CONSTRAINT decisions_unit_fkey
  FOREIGN KEY (account_id, unit_id) REFERENCES units(account_id, id);

CREATE INDEX expenses_account_idx  ON expenses (account_id, start_date);
CREATE INDEX claims_account_idx    ON claims (account_id, occurred_on);
CREATE INDEX decisions_account_idx ON pricing_decisions (account_id, detected_at DESC);

-- app_config held global settings that are now per-account. Keep the
-- table for genuinely global flags; the seeded rows move to accounts.
DELETE FROM app_config WHERE key IN ('TARGET_NET_PER_UNIT','OCC_FLOOR_PCT','STAY_NIGHTS');
