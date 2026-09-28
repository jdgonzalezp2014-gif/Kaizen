-- A claim is removed, never erased (§86) — the same rule as work (§82).
--
-- Removing a claim was a hard DELETE: one wrong tap and the case, its
-- figures and its timeline were gone, and its work unlinked. Now it is
-- stamped, every reader skips it, and it can be restored — with its work
-- still linked, because the links are kept.
ALTER TABLE claims
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by TEXT;
