-- §167 (owner, 2026-10-15): Claims & upselling joined to Operations and Finance.
--
-- `received_on`: the day what a case received was entered. Income is dated by it — Revenue's net and Revenue →
-- Claims & upselling on one rule (they used to date by close day and by raised day, so their totals differed, and
-- re-closing a case moved its money). Existing money is dated when it was taken as income until now.
ALTER TABLE claims ADD COLUMN received_on DATE;
UPDATE claims SET received_on = COALESCE(resolved_on, occurred_on) WHERE refund > 0;

-- How an upsell was collected — the SOP #3 rule: an alteration is upselling only through the Resolution Center or
-- when the reservation carries no price for it; "Direct" = from the guest (card, cash).
ALTER TABLE claims ADD COLUMN collected_via TEXT
  CHECK (collected_via IN ('Resolution Center', 'Not priced on the reservation', 'Direct'));

-- 'Refunded' read as money going back to the guest; a case that brought money in is 'Paid'. A closed case with
-- money is Paid (the rule from now on) — claim #9 ($60 early check-in, Resolved) becomes Paid.
ALTER TABLE claims DROP CONSTRAINT claims_status_check;
INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
  SELECT account_id, 'claim', id::text, 'status', status || ' → Paid (closed with money received, §167)', 'Kaizen'
    FROM claims WHERE status IN ('Refunded', 'Resolved') AND refund > 0;
UPDATE claims SET status = 'Paid' WHERE status IN ('Refunded', 'Resolved') AND refund > 0;
UPDATE claims SET status = 'Resolved' WHERE status = 'Refunded';
ALTER TABLE claims ADD CONSTRAINT claims_status_check
  CHECK (status IN ('Open', 'In progress', 'Resolved', 'Paid', 'Dismissed'));

-- A case's work as money, in one place for /api/claims, /api/claims-money and /api/portfolio (it was written three
-- times). repair_work: a work order's cost, or its estimate until there is one, a to-do's cost, plus what was bought
-- on it; cancelled or removed work counts nothing. owner_work: the part of it charged to the owner (§95: a work order
-- with a listing) — the owner's cost, so a reimbursement goes to the owner up to it (owner, §167).
-- NB: this view reads todos.cost_actual, cost_estimate, kind, charge_owner, unit_ids, status, deleted_at, claim_id —
-- dropping one of them needs the view dropped or rewritten first.
CREATE VIEW claim_work AS
  SELECT t.account_id, t.claim_id,
         sum(COALESCE(t.cost_actual, CASE WHEN t.kind = 'work_order' THEN t.cost_estimate END, 0) + COALESCE(p.bought, 0)) AS repair_work,
         sum(CASE WHEN t.kind = 'work_order' AND t.charge_owner AND cardinality(t.unit_ids) > 0
                  THEN COALESCE(t.cost_actual, t.cost_estimate, 0) ELSE 0 END) AS owner_work
    FROM todos t
    LEFT JOIN (SELECT account_id, todo_id, sum(total) AS bought FROM inventory_purchases GROUP BY account_id, todo_id) p
           ON p.account_id = t.account_id AND p.todo_id = t.id
   WHERE t.claim_id IS NOT NULL AND t.deleted_at IS NULL AND t.status <> 'cancelled'
   GROUP BY t.account_id, t.claim_id;
