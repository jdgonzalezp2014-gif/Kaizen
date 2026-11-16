-- Guest Services → Inbox (the CRM, owner 2026-11-16): conversations stay in Hostaway and Quo — Kaizen keeps only what
-- they do not: the messages it scheduled, staged, sent or failed to send (the outbox), the templates, and the settings.

-- The guest AI: { mode: off | suggest, provider: claude | gemini, model, instructions }. It drafts; a person sends.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS guest_ai JSONB NOT NULL DEFAULT '{}'::jsonb;
-- OFF = everything Kaizen would send to a guest is kept as "staged" instead (Hostaway's own automations keep sending).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS guest_messages_live BOOLEAN NOT NULL DEFAULT false;
-- The guest portal moves to its own domain: every link to it is built from this address, never from the team app's.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS guest_portal_url TEXT;

CREATE TABLE IF NOT EXISTS message_templates (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL,
  name         TEXT NOT NULL,
  body         TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'hostaway',   -- hostaway | sms
  trigger      TEXT NOT NULL DEFAULT 'manual',     -- manual | booked | before_checkin | after_checkin | before_checkout | after_checkout
  offset_hours INT  NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS message_templates_account_idx ON message_templates (account_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS guest_messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      BIGINT NOT NULL,
  reservation_id  TEXT NOT NULL,
  conversation_id TEXT,
  listing_id      TEXT,
  channel         TEXT NOT NULL,                    -- hostaway | sms
  body            TEXT NOT NULL,
  status          TEXT NOT NULL,                    -- scheduled | staged | sent | failed | cancelled
  send_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  error           TEXT,
  template_id     BIGINT,
  source          TEXT NOT NULL DEFAULT 'manual',   -- manual (typed now) | scheduled (a person picked a time) | auto (a template's trigger)
  -- What the AI proposed, when the person started from its draft: how much they changed is how the AI is judged.
  ai_draft        TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_messages_res_idx ON guest_messages (account_id, reservation_id, send_at);
CREATE INDEX IF NOT EXISTS guest_messages_due_idx ON guest_messages (account_id, send_at) WHERE status = 'scheduled';
-- An automatic template goes once per stay, whatever the clock does: the second insert is refused.
CREATE UNIQUE INDEX IF NOT EXISTS guest_messages_auto_once ON guest_messages (account_id, reservation_id, template_id) WHERE source = 'auto';
