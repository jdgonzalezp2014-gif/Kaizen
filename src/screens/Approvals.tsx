/**
 * Approvals — a tab of To-do and of Home's card (owner, 2026-10-28: "approvals in a section of their own, so they are not confused — every
 * purchase and charge from outside, apart"). What people outside the team spent or charged, waiting for a person:
 * cleaners' extras, purchases paid in the field (a cleaner or their helper), a handyman's labor and materials.
 *
 * Every line has the shape a cost has everywhere (Costs, the repair's Handyman's work): who · house · amount — what for,
 * the receipts drawn small, two small buttons. A handyman's charge opens its repair — the to-do's own card, photos
 * and all — in a pop-up, as a line of Costs does. Decided here, it is decided everywhere (crew-admin decideExtra /
 * decideField): the repair's cost, the invoice, Costs.
 */
import { useEffect, useState } from 'react';
import { getCrewAdmin, type FieldExpense, type PendingExtra } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { todayIn } from '../lib/dates.ts';
import { Hint } from '../components/Hint.tsx';
import { Icon, ic } from '../components/Icon.tsx';
import { PhotoStrip } from '../components/WorkProof.tsx';
import { TodoList } from '../components/Todos.tsx';
import { Decide } from './Crew.tsx';

const day = (d: string) => d.slice(5, 10).replace('-', '/');

/**
 * What waits, read once by the screen that shows the tab (To-do, Home) — its count is the tab's, its list the tab's body.
 * The fast answer: no cleaner's page and no schedule (those read Hostaway).
 */
export function useApprovals(enabled: boolean) {
  const [extras, setExtras] = useState<PendingExtra[] | null>(null);
  const [field, setField] = useState<FieldExpense[]>([]);
  const [err, setErr] = useState('');
  const load = () => enabled ? getCrewAdmin(null, null, null, true)
    .then(r => { if (r.ok) { setExtras(r.pending); setField(r.fieldPending ?? []); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
    .catch(e => setErr(String(e))) : Promise.resolve();
  useEffect(() => { void load(); }, [enabled]);
  const count = (extras?.length ?? 0) + field.length;
  const total = [...(extras ?? []), ...field].reduce((a, x) => a + Number(x.amount || 0), 0);
  return { extras, field, err, load, count, total };
}
export type ApprovalsData = ReturnType<typeof useApprovals>;

/** Owner, 2026-10-28: a tab of To-do (and of Home's card), not a screen of its own. */
export function Approvals({ canEdit, data }: { canEdit: boolean; data: ApprovalsData }) {
  const { extras, field, err, load, count: n, total } = data;
  const [repair, setRepair] = useState<string | null>(null);

  return (
    <>
      {err && <p className="banner error">{ic(err)}</p>}
      <div className="approvals">
        <p className="note">{n > 0 ? <><b>{n}</b> waiting · <b>{ic(money2(total))}</b></> : null}
          <Hint label="Approvals">What people outside the team spent or charged, waiting for a person. Nothing is paid or reaches Costs before
            it is approved. A cleaner's extra is paid on the invoice of its clean. A cleaner's purchase is approved by recording it in the
            inventory — which items, to which place — and is paid back with their clean (no clean → Costs' "To pay back"); if they also
            sent it as an extra, deny that one or it is paid twice. A handyman's charge becomes the repair's cost: on their invoice, and in
            Costs once the repair is done — "Open the repair" shows its photos and the rest of its work. Denied, they read why.</Hint></p>
        {extras === null && !err && <div className="load-note" role="status"><div className="load-bar" />Loading…</div>}
        {extras !== null && !n && <p className="note">Nothing waiting. ✓</p>}
        <div className="approve-list">
          {field.map(f => (
            <Line key={`f${f.id}`} icon={f.source === 'vendor' ? 'wrench' : 'brush'}
                  who={f.byName.replace(/^(.*)'s team: (.*)$/, '$2 ($1’s team)')} where={f.unit} at={f.at} amount={f.amount}
                  what={f.description.replace(/ — repair #\d+.*$/, '')} kind={f.source === 'vendor' ? 'Handyman charge' : 'Paid in the field'}
                  photos={f.photos} serve noReceipt={!f.photos.length}
                  open={f.todoId ? () => setRepair(f.todoId) : undefined} openWord={f.source === 'vendor' ? 'Open the repair' : 'Open the to-do'}>
              {canEdit && <Decide id={f.id} kind="decideField" onDone={load}
                record={f.source === 'vendor' ? undefined : { unitId: f.unitId, said: f.description, amount: f.amount, hasReceipt: f.photos.length > 0 }} />}
            </Line>
          ))}
          {(extras ?? []).map(e => (
            <Line key={`x${e.id}`} icon="brush" who={e.cleaner} where={e.unit} at={e.createdAt} amount={e.amount} what={e.description}
                  kind={`Extra on the clean of ${day(e.date)}`} photos={(e.files ?? []).map(f => ({ name: f.name, url: f.url }))} serve={false}>
              {canEdit && <Decide id={e.id} onDone={load} />}
            </Line>
          ))}
        </div>
      </div>
      {repair && <TodoList today={todayIn('America/New_York')} task={repair} onClose={() => { setRepair(null); void load(); }} />}
    </>
  );
}

/** One thing waiting — the same shape as a cost line anywhere. */
function Line({ icon, who, where, at, amount, what, kind, photos, serve, noReceipt = false, open, openWord, children }: {
  icon: string; who: string; where: string | null; at: string; amount: number; what: string; kind: string;
  photos: { name: string; url: string }[]; serve: boolean; noReceipt?: boolean; open?: () => void; openWord?: string; children?: React.ReactNode;
}) {
  return (
    <div className="approve-line">
      <div className="approve-head">
        <b>{ic(money2(amount))}</b>
        <span className="approve-what" title={what}>{ic(what)}</span>
        <span className="sub-n"><Icon n={icon as never} /> {ic(who)}{where ? ` · ${where}` : ''} · <span title={`Asked ${at}`}>{ic(kind)}</span>
          {noReceipt && <span title="Sent without a receipt"> · no receipt</span>}</span>
      </div>
      <PhotoStrip photos={photos} serve={serve} />
      <div className="approve-acts">
        {children}
        {open && <button className="link tiny" onClick={open}>{openWord} ›</button>}
      </div>
    </div>
  );
}
