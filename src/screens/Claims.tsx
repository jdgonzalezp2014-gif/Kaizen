/**
 * Revenue → Claims & upselling (§162, owner 2026-10-15) — the cases as money, for Finance only
 * (permission `claims.money`). The team opens and follows cases in Operations → To-do; here is what
 * was requested, what came in, and what the work cost.
 *
 * - Received is income: Revenue counts it in net, beside the reservations (/api/portfolio).
 * - Requested is not money — it is what the recovery rate is measured against.
 * - Repair work is read from the case's work orders and purchase orders, which reached Costs on their
 *   own; it is shown to net a claim, never added to costs a second time.
 * - Upselling is revenue. A reservation alteration is not: its price is in the reservation — unless it
 *   was collected through the Resolution Center or no price was recorded on the reservation.
 */
import { useEffect, useMemo, useState } from 'react';
import { getClaimsMoney, saveClaimMoney, type ClaimMoney } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { caseHost, isUpsell } from '../lib/claims.ts';
import { claimStage, shortDay } from '../lib/todos.ts';
import { resolvePreset, type PresetId } from '../lib/ranges.ts';
import type { Period } from '../lib/finance.ts';
import { RangePicker } from '../components/RangePicker.tsx';
import { CategoryOptions } from '../components/Todos.tsx';
import { Hint } from '../components/Hint.tsx';

const what = (c: ClaimMoney) =>
  (c.description ?? '').replace(/\s*—?\s*From Slack:?\s*\S*\s*$/i, '').trim().slice(0, 70) || c.category || 'Case';
const inRange = (c: ClaimMoney, p: Period) => c.occurred_on >= p.from && c.occurred_on <= p.to;

export function ClaimsMoney() {
  // The year so far: cases are few and slow; thirty days would show almost nothing.
  const [preset, setPreset] = useState<PresetId | 'custom'>('ytd');
  const [period, setPeriod] = useState<Period>(() => resolvePreset('ytd')!);
  const [cases, setCases] = useState<ClaimMoney[] | null>(null);
  const [view, setView] = useState<'claims' | 'upsell'>('claims');
  const [err, setErr] = useState('');

  const load = () => getClaimsMoney(period.from, period.to)
    .then(r => { if (r.ok) { setCases(r.cases); setErr(''); } else setErr(r.message ?? 'Could not read the cases.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [period.from, period.to]);

  const sums = useMemo(() => {
    const list = (cases ?? []).filter(c => inRange(c, period));
    const claims = list.filter(c => !isUpsell(c.category)), ups = list.filter(c => isUpsell(c.category));
    const add = (xs: ClaimMoney[], f: (c: ClaimMoney) => number) => xs.reduce((a, c) => a + f(c), 0);
    const byKind = new Map<string, number>();
    for (const c of ups) byKind.set(c.category!, (byKind.get(c.category!) ?? 0) + c.received);
    return {
      claims: { n: claims.length, requested: add(claims, c => c.requested), received: add(claims, c => c.received), work: add(claims, c => c.repair_work) },
      upsell: { n: ups.length, received: add(ups, c => c.received), byKind: [...byKind].sort((a, b) => b[1] - a[1]) }
    };
  }, [cases, period]);

  // Cases raised in the range — and every open one, wherever it started: it is still money to chase.
  const rows = (cases ?? []).filter(c => (view === 'upsell') === isUpsell(c.category))
    .filter(c => inRange(c, period) || c.status === 'Open' || c.status === 'In progress');
  const c = sums.claims;

  return (
    <section>
      <RangePicker period={period} preset={preset} onChange={(p, id) => { setPeriod(p); setPreset(id); }} />
      {err && <p className="banner error">{err}</p>}
      <dl className="strip">
        <div><dt>Claims received</dt><dd>{money2(c.received)}<small>of {money2(c.requested)} requested{c.requested > 0 ? ` · ${Math.round(c.received / c.requested * 100)}%` : ''}</small></dd></div>
        <div><dt>Claims repair work</dt><dd>{money2(c.work)}<small>already in Costs</small></dd></div>
        <div><dt>Claims net</dt><dd>{money2(c.received - c.work)}<small>received − repair work</small></dd></div>
        <div><dt>Upselling</dt><dd>{money2(sums.upsell.received)}<small>{sums.upsell.n} case{sums.upsell.n === 1 ? '' : 's'}{sums.upsell.byKind.length ? ` · ${sums.upsell.byKind.slice(0, 2).map(([k, v]) => `${k} ${money2(v)}`).join(' · ')}` : ''}</small></dd></div>
      </dl>

      <div className="card">
        <div className="row-controls">
          <h2>Claims &amp; upselling <Hint>Figures by the day a case was raised. <b>Received</b> is income — Revenue counts it in
            net, beside the reservations, on the day the case closed. <b>Requested</b> is what was asked for (the recovery rate is
            measured against it). <b>Repair work</b> is what the case's work orders and purchase orders cost; those reached Costs on
            their own, so it is shown here to net a claim, never added again. A reservation alteration is not upselling — its
            price is in the reservation — unless it was collected through the Resolution Center or no price was recorded on
            it. Open cases from before the range are listed too. The team follows the cases in Operations → To-do.</Hint></h2>
          <span className="rb-spacer" />
          <span className="seg" role="group" aria-label="Which cases">
            <button className={view === 'claims' ? 'chip active' : 'chip'} onClick={() => setView('claims')}>Claims · {c.n}</button>
            <button className={view === 'upsell' ? 'chip active' : 'chip'} onClick={() => setView('upsell')}>Upselling · {sums.upsell.n}</button>
          </span>
        </div>
        {cases === null ? <p className="note loading-dot">Reading</p> : !rows.length ? <p className="note">Nothing in this range.</p> : (
          <div className="table-wrap">
            <table className="money-table">
              <thead><tr>
                <th>Raised</th><th>Case</th><th>Kind</th><th>Status</th>
                {view === 'claims' && <th className="n">Requested</th>}
                <th className="n">Received</th>
                {view === 'claims' && <><th className="n">Repair work</th><th className="n">Net</th></>}
              </tr></thead>
              <tbody>{rows.map(x => <MoneyRow key={x.id} c={x} claims={view === 'claims'} onSaved={() => void load()} />)}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function MoneyRow({ c, claims, onSaved }: { c: ClaimMoney; claims: boolean; onSaved: () => void }) {
  const [req, setReq] = useState(c.requested ? String(c.requested) : '');
  const [rec, setRec] = useState(c.received ? String(c.received) : '');
  const [msg, setMsg] = useState('');
  const save = async (body: { requested?: number; received?: number; category?: string | null }) => {
    const r = await saveClaimMoney({ id: c.id, ...body }).catch(e => ({ ok: false, message: String(e) }));
    setMsg(r.ok ? '' : r.message ?? 'Not saved.');
    if (r.ok) onSaved();
  };
  const st = claimStage(c.status);
  const money = (v: string, set: (s: string) => void, key: 'requested' | 'received', was: number) => (
    <input type="number" min={0} step="0.01" className="money-in" value={v} placeholder="$" aria-label={key}
           onChange={e => set(e.target.value)}
           onBlur={() => { const n = Number(v) || 0; if (Math.abs(n - was) > 0.004) void save({ [key]: n }); }} />
  );
  return (
    <tr>
      <td>{shortDay(c.occurred_on)}</td>
      <td>
        <span>{c.unit_name ?? 'Portfolio'} · {what(c)}</span>
        {c.case_url && <> <a className="case-link" href={c.case_url} target="_blank" rel="noreferrer">↗ {caseHost(c.case_url)}</a></>}
        {c.reservation_label && <div className="sub-n">{c.reservation_label}</div>}
        {msg && <div className="breach">{msg}</div>}
      </td>
      <td>
        <select value={c.category ?? ''} aria-label="Kind" onChange={e => void save({ category: e.target.value || null })}>
          <option value="">—</option><CategoryOptions />
        </select>
      </td>
      <td><span className={`m-stage st-${st.key}`}>{st.label}</span></td>
      {claims && <td className="n">{money(req, setReq, 'requested', c.requested)}</td>}
      <td className="n">{money(rec, setRec, 'received', c.received)}</td>
      {claims && <><td className="n">{money2(c.repair_work)}</td><td className="n">{money2(c.received - c.repair_work)}</td></>}
    </tr>
  );
}
