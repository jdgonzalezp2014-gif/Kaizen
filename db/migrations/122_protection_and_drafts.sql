-- Owner, 2026-11-23: every listing's Repository record holds the three numbers the guest portal does its math with —
-- the refundable deposit, the damage waiver per night and its minimum (waiver = max(minimum, per night × nights)).
-- They live in Fees beside the fields that already existed instead of new ones:
--   damage_deposit  "Refundable damage deposit"  → $300
--   insurance_fee   "Damage waiver per night"     → $12 (Hostaway's nightly fee, already filled on 10 records)
--   waiver_price    moved from Guest portal, now "Damage waiver minimum" → $70
-- Only blanks are filled; a value someone typed stays. deposit_hold (Guest portal) is empty everywhere and now only
-- a fallback for damage_deposit (portalFrom). The code reads these keys with or without this migration.
UPDATE repo_columns SET title = 'Damage waiver per night'
 WHERE account_id = 1 AND key = 'insurance_fee' AND table_key IN ('houses', 'the_links', 'cortland_legacy');
UPDATE repo_columns SET title = 'Damage waiver minimum', grp = 'Fees', position = 71
 WHERE account_id = 1 AND key = 'waiver_price' AND table_key IN ('houses', 'the_links', 'cortland_legacy');

UPDATE repo_records SET vals = vals || jsonb_strip_nulls(jsonb_build_object(
    'damage_deposit', CASE WHEN COALESCE(vals->>'damage_deposit', '') = '' THEN to_jsonb(300) END,
    'insurance_fee',  CASE WHEN COALESCE(vals->>'insurance_fee', '')  = '' THEN to_jsonb(12)  END,
    'waiver_price',   CASE WHEN COALESCE(vals->>'waiver_price', '')   = '' THEN to_jsonb(70)  END))
 WHERE account_id = 1 AND table_key IN ('houses', 'the_links', 'cortland_legacy') AND archived_at IS NULL;

INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
SELECT 1, 'kaizen-os', 'columns.edit', t, NULL,
       'Fees: Damage waiver per night ($12), Damage waiver minimum ($70, moved from Guest portal), Refundable damage deposit ($300) filled where blank (owner, 2026-11-23)'
  FROM unnest(ARRAY['houses', 'the_links', 'cortland_legacy']) AS t;

-- Owner, 2026-11-23: the guest AI drafts a reply the moment a guest writes (Hostaway's webhook, guest-events.ts draftEvent);
-- the draft waits on its event for the Inbox to send or dismiss. {"pending":true} while it is being written; {error} when it failed.
ALTER TABLE guest_events ADD COLUMN IF NOT EXISTS draft JSONB;
