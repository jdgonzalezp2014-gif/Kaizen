/**
 * Revenue → Claims & upselling (§162) — the cases as money, Finance's view (permission `claims.money`). §167 (owner,
 * 2026-10-15): the team enters requested and received on the case in Operations → To-do; Finance sees the totals,
 * per listing and portfolio, and can correct the same fields here (one source, the same rules).
 *
 * - Received is income, dated the day it was entered (`received_on`) — the same rule Revenue's net uses, so the
 *   two agree. When the repair was charged to the owner, the reimbursement is the owner's up to that cost; Kaizen
 *   keeps the difference (caseResult).
 * - Requested is an estimate — the recovery rate is measured against it, over the cases raised in the range.
 * - Repair work is read from the case's work orders and purchase orders (claim_work), already in Costs on their own;
 *   the result nets it: what Kaizen kept − what Kaizen spent, a gain or a loss.
 * - Upselling is income too. A reservation alteration is not: its price is in the reservation — unless it was
 *   collected through the Resolution Center or no price was recorded on the reservation.
 */
import { useEffect, useMemo, useState } from 'react';
import { getClaimsMoney, saveClaimMoney, type CaseMoneyChange, type ClaimMoney } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { COLLECTED_VIA, caseHost, caseResult, isUpsell } from '../lib/claims.ts';
import { claimStage, shortDay } from '../lib/todos.ts';
import { resolvePreset, type PresetId } from '../lib/ranges.ts';
import type { Period } from '../lib/finance.ts';
import { RangePicker } from '../components/RangePicker.tsx';
import { CategoryOptions } from '../components/Todos.tsx';
import { Hint } from '../components/Hint.tsx';

const what = (c: ClaimMoney) =>
  (c.description ?? '').replace(/\s*—?\s*From Slack:?\s*\S*\s*$/i, '').trim().slice(0, 70) || c.category || 'Case';
const raisedIn = (c: ClaimMoney, p: Period) => c.occurred_on >= p.from && c.occurred_on <= p.to;
const paidIn = (c: ClaimMoney, p: Period) => !!c.received_on && c.received > 0 && c.received_on >= p.from && c.received_on <= p.to;
const resultOf = (c: ClaimMoney) => caseResult({ requested: c.requested, received: c.received, repairWork: c.repair_work, ownerWork: c.owner_work });
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money2(Math.abs(n))}`;
const word = (n: number) => n > 0 ? 'Gain' : n < 0 ? 'Loss' : 'Even';

export function ClaimsMoney() {
  // The year so far: cases are few and slow; thirty days would show almost nothing.
  const [preset, setPreset] = useState<PresetId | 'custom'>('ytd');
  const [period, setPeriod] = useState<Period>(() => resolvePreset('ytd')!);
  const [cases, setCases] = useState<ClaimMoney[] | null>(null);
  const [view, setView] = useState<'claims' | 'upsell' | 'units'>('claims');
  const [err, setErr] = useState('');

  const load = () => getClaimsMoney(period.from, period.to)
    .then(r => { if (r.ok) { setCases(r.cases); setErr(''); } else setErr(r.message ?? 'Could not read the cases.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [period.from, period.to]);

  const sums = useMemo(() => {
    const all = cases ?? [];
    const add = (xs: ClaimMoney[], f: (c: ClaimMoney) => number) => xs.reduce((a, c) => a + f(c), 0);
    const claims = all.filter(c => !isUpsell(c.category)), ups = all.filter(c => isUpsell(c.category));
    // Money by the day it came in — what Revenue's net counts; the recovery and the result by the cases raised.
    const paidClaims = claims.filter(c => paidIn(c, period)), raised = claims.filter(c => raisedIn(c, period));
    const paidUps = ups.filter(c => paidIn(c, period));
    const byKind = new Map<string, number>();
    for (const c of paidUps) byKind.set(c.category!, (byKind.get(c.category!) ?? 0) + c.received);
    const units = new Map<string, { name: string; n: number; received: number; owner: number; work: number; result: number }>();
    for (const c of all.filter(x => raisedIn(x, period) || paidIn(x, period))) {
      const k = c.unit_id ?? '', u = units.get(k) ?? { name: c.unit_name ?? 'Portfolio-wide', n: 0, received: 0, owner: 0, work: 0, result: 0 };
      const r = resultOf(c);
      u.n++;
      if (paidIn(c, period)) { u.received += c.received; u.owner += r.ownerShare; }
      if (raisedIn(c, period)) { u.work += c.repair_work; u.result += r.result; }
      units.set(k, u);
    }
    return {
      claims: {
        n: raised.length,
        received: add(paidClaims, c => c.received), owner: add(paidClaims, c => resultOf(c).ownerShare),
        raisedRequested: add(raised, c => c.requested), raisedReceived: add(raised, c => c.received),
        result: add(raised, c => resultOf(c).result)
      },
      upsell: { n: ups.filter(c => raisedIn(c, period) || paidIn(c, period)).length, received: add(paidUps, c => c.received),
                owner: add(paidUps, c => resultOf(c).ownerShare), byKind: [...byKind].sort((a, b) => b[1] - a[1]) },
      units: [...units.values()].sort((a, b) => a.result - b.result)
    };
  }, [cases, period]);

  // Cases raised or paid in the range — and every open one, wherever it started: it is still money to chase.
  const rows = (cases ?? []).filter(c => (view === 'upsell') === isUpsell(c.category))
    .filter(c => raisedIn(c, period) || paidIn(c, period) || c.status === 'Open' || c.status === 'In progress');
  const c = sums.claims;
  const inNet = c.received - c.owner + sums.upsell.received - sums.upsell.owner;

  return (
    <section>
      <RangePicker period={period} preset={preset} onChange={(p, id) => { setPeriod(p); setPreset(id); }} />
      {err && <p className="banner error">{err}</p>}
      <dl className="strip">
        <div><dt>Claims received</dt><dd>{money2(c.received)}<small>{c.owner > 0 ? `${money2(c.owner)} to the owner · ` : ''}by the day it came in</small></dd></div>
        <div><dt>Recovery</dt><dd>{c.raisedRequested > 0 ? `${Math.round(c.raisedReceived / c.raisedRequested * 100)}%` : '—'}
          <small>{money2(c.raisedReceived)} of {money2(c.raisedRequested)} requested · {c.n} raised</small></dd></div>
        <div><dt>Claims result</dt><dd className={c.result < 0 ? 'neg' : undefined}>{signed(c.result)}<small>{word(c.result)} · cases raised in range</small></dd></div>
        <div><dt>Upselling</dt><dd>{money2(sums.upsell.received)}<small>{sums.upsell.byKind.length ? sums.upsell.byKind.slice(0, 2).map(([k, v]) => `${k} ${money2(v)}`).join(' · ') : `${sums.upsell.n} cases`}</small></dd></div>
        <div><dt>In net</dt><dd>{money2(inNet)}<small>what Revenue counts</small></dd></div>
      </dl>

      <div className="card">
        <div className="row-controls">
          <h2>Claims &amp; upselling <Hint>The team enters each case's money in Operations → To-do (Claims &amp; upselling); you can
            correct it here. <b>Received</b> is income on the day it was entered — Revenue's net counts it on that day, so
            "In net" here is the figure Revenue shows. When a repair was charged to the owner, the reimbursement is the owner's
            up to that cost; Kaizen keeps the difference. <b>Requested</b> is an estimate — recovery is received of requested
            over the cases raised in the range. <b>Repair work</b> is what the case's work orders and purchase orders cost; it
            reached Costs on its own and is netted here, never added again. <b>Result</b> = what Kaizen kept − what Kaizen
            spent: a gain or a loss. A reservation alteration is not upselling — its price is in the reservation — unless it was
            collected through the Resolution Center or no price was recorded on it. Open cases from before the range are
            listed too.</Hint></h2>
          <span className="rb-spacer" />
          <span className="seg" role="group" aria-label="Which cases">
            <button className={view === 'claims' ? 'chip active' : 'chip'} onClick={() => setView('claims')}>Claims · {c.n}</button>
            <button className={view === 'upsell' ? 'chip active' : 'chip'} onClick={() => setView('upsell')}>Upselling · {sums.upsell.n}</button>
            <button className={view === 'units' ? 'chip active' : 'chip'} onClick={() => setView('units')}>By listing</button>
          </span>
        </div>
        {cases === null ? <p className="note loading-dot">Reading</p> : view === 'units' ? (
          !sums.units.length ? <p className="note">Nothing in this range.</p> : (
            <div className="table-wrap">
              <table className="money-table">
                <thead><tr><th>Listing</th><th className="n">Cases</th><th className="n">Received</th><th className="n">To the owner</th>
                  <th className="n">Repair work</th><th className="n">Result</th></tr></thead>
                <tbody>{sums.units.map(u => (
                  <tr key={u.name}><td>{u.name}</td><td className="n">{u.n}</td><td className="n">{money2(u.received)}</td>
                    <td className="n">{u.owner ? money2(u.owner) : '—'}</td><td className="n">{money2(u.work)}</td>
                    <td className={`n${u.result < 0 ? ' neg' : ''}`}>{signed(u.result)} <small>{word(u.result)}</small></td></tr>
                ))}</tbody>
              </table>
            </div>
          )
        ) : !rows.length ? <p className="note">Nothing in this range.</p> : (
          <div className="table-wrap">
            <table className="money-table">
              <thead><tr>
                <th>Raised</th><th>Case</th><th>Kind</th><th>Status</th>
                {view === 'claims' ? <><th className="n">Requested</th><th className="n">Received</th><th className="n">Repair work</th><th className="n">Result</th></>
                  : <><th className="n">Price charged</th><th>Collected how</th></>}
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
  const shown = (n: number) => n ? String(n) : '';
  const [req, setReq] = useState(shown(c.requested));
  const [rec, setRec] = useState(shown(c.received));
  const [msg, setMsg] = useState('');
  useEffect(() => { setReq(shown(c.requested)); setRec(shown(c.received)); }, [c.requested, c.received]);
  const save = async (body: CaseMoneyChange) => {
    const r = await saveClaimMoney({ id: c.id, ...body }).catch(e => ({ ok: false, message: String(e) }));
    setMsg(r.ok ? '' : r.message ?? 'Not saved.');
    if (r.ok) onSaved(); else { setReq(shown(c.requested)); setRec(shown(c.received)); }
  };
  const st = claimStage(c.status);
  const res = resultOf(c);
  const money = (v: string, set: (s: string) => void, key: 'requested' | 'received', was: number) => (
    <input type="number" min={0} step="0.01" className="money-in" value={v} placeholder="$" aria-label={key}
           onChange={e => set(e.target.value)}
           onBlur={() => {
             const n = Math.round((Number(v) || 0) * 100) / 100;
             // An upsell is one amount: the price charged is what was asked and what came in.
             if (Math.abs(n - was) > 0.004) void save(claims ? { [key]: n } : { received: n, requested: n });
           }} />
  );
  // The day it came in — the day Revenue counts it; set it when the money arrived before it was entered.
  const day = c.received > 0 && (
    <div className="sub-n"><input type="date" value={c.received_on ?? ''} aria-label="Received on"
                                  onChange={e => e.target.value && void save({ receivedOn: e.target.value })} /></div>
  );
  return (
    <tr>
      <td>{shortDay(c.occurred_on)}</td>
      <td>
        <span>{c.unit_name ?? 'Portfolio'} · {what(c)}</span>
        {c.case_url && <> <a className="case-link" href={c.case_url} target="_blank" rel="noreferrer">↗ {caseHost(c.case_url)}</a></>}
        {c.reservation_label && <div className="sub-n">{c.reservation_label}</div>}
        {msg && <div className="breach">▲ {msg}</div>}
      </td>
      <td>
        <select value={c.category ?? ''} aria-label="Kind" onChange={e => void save({ category: e.target.value || null })}>
          <option value="">—</option><CategoryOptions />
        </select>
      </td>
      <td><span className={`m-stage st-${st.key}`}>{st.label}</span></td>
      {claims ? <>
        <td className="n">{money(req, setReq, 'requested', c.requested)}</td>
        <td className="n">{money(rec, setRec, 'received', c.received)}{day}</td>
        <td className="n">{money2(c.repair_work)}</td>
        <td className={`n${res.result < 0 ? ' neg' : ''}`}>{signed(res.result)} <small>{word(res.result)}</small>
          {res.ownerShare > 0 && <div className="sub-n">{money2(res.ownerShare)} to the owner</div>}</td>
      </> : <>
        <td className="n">{money(rec, setRec, 'received', c.received)}{day}</td>
        <td><select value={c.collected_via ?? ''} aria-label="Collected how" onChange={e => void save({ collectedVia: e.target.value || null })}>
          <option value="">—</option>{COLLECTED_VIA.map(x => <option key={x}>{x}</option>)}
        </select></td>
      </>}
    </tr>
  );
}
