/**
 * Revenue → Portal sales (owner, 2026-11-17): what the guest portal sold through Stripe — the damage waiver, each extra,
 * extra nights. Paid on the spot, so every payment is a sale; Stripe's fee is a cost (Costs → Payment fees). Test-mode
 * payments are listed (the team tries the flow) and marked, never counted in profit.
 */
import { useEffect, useMemo, useState } from 'react';
import { getGuestPayments } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { keptLines, salesByItem, type GuestPayment } from '../lib/guest-payments.ts';
import { resolvePreset, type PresetId } from '../lib/ranges.ts';
import type { Period } from '../lib/finance.ts';
import { RangePicker } from '../components/RangePicker.tsx';
import { Hint } from '../components/Hint.tsx';

const STATUS: Record<GuestPayment['status'], string> = { paid: '✓ Paid', held: '○ Held', refunded: '↺ Refunded' };

export function PortalSales() {
  const [preset, setPreset] = useState<PresetId | 'custom'>('mtd');
  const [period, setPeriod] = useState<Period>(() => resolvePreset('mtd')!);
  const [list, setList] = useState<GuestPayment[] | null>(null);
  const [err, setErr] = useState('');
  const [tests, setTests] = useState(true);
  useEffect(() => {
    setList(null);
    getGuestPayments(period.from, period.to)
      .then(r => { if (r.ok) { setList(r.payments); setErr(''); } else setErr(r.message ?? 'Could not read the payments.'); })
      .catch(e => setErr(String(e)));
  }, [period.from, period.to]);

  const s = useMemo(() => {
    const all = list ?? [];
    // §178: a payment that settled an upsell case is the case's income (Revenue → Claims & upselling) — shown apart, never
    // in Portal sales, so this screen and Profit agree.
    const cases = all.filter(p => p.livemode && p.claimId);
    const live = all.filter(p => p.livemode && !p.claimId);
    const kept = (ps: GuestPayment[]) => ps.reduce((a, p) => a + keptLines(p).reduce((b, l) => b + l.amount, 0), 0);
    return {
      live, test: all.filter(p => !p.livemode), cases, caseSales: kept(cases),
      sales: kept(live), fees: [...live, ...cases].reduce((a, p) => a + (p.fee ?? 0), 0),
      held: live.filter(p => p.status === 'held').reduce((a, p) => a + p.amount, 0),
      byItem: salesByItem(live), testSales: kept(all.filter(p => !p.livemode)), testByItem: salesByItem(all.filter(p => !p.livemode)),
    };
  }, [list]);
  const rows = (list ?? []).filter(p => tests || p.livemode);
  const items = s.live.length ? s.byItem : s.testByItem;

  return (
    <section>
      <RangePicker period={period} preset={preset} onChange={(p, id) => { setPeriod(p); setPreset(id); }} />
      {err && <p className="banner error">{err}</p>}
      <dl className="strip">
        <div><dt>Portal sales</dt><dd>{money2(s.sales)}<small>{s.live.length} payment(s) · in net</small></dd></div>
        <div><dt>Stripe fees</dt><dd>{money2(s.fees)}<small>in Costs · Payment fees</small></dd></div>
        <div><dt>Kept</dt><dd>{money2(s.sales + s.caseSales - s.fees)}<small>sales + upsell links − fees</small></dd></div>
        {s.cases.length > 0 && <div><dt>Upsell links</dt><dd>{money2(s.caseSales)}<small>{s.cases.length} payment(s) · counted in Claims &amp; upselling</small></dd></div>}
        {s.held > 0 && <div><dt>Held</dt><dd>{money2(s.held)}<small>deposits not captured yet</small></dd></div>}
        {s.test.length > 0 && <div><dt>Test mode</dt><dd>{money2(s.testSales)}<small>{s.test.length} payment(s) · not counted</small></dd></div>}
      </dl>

      <div className="card">
        <div className="row-controls">
          <h2>What sold <Hint>Each line is one item the guest paid for in the portal: the damage waiver, early check-in, late
            check-out, extra nights, a mid-stay clean… Nothing waits for an OK — the payment is the sale. Revenue's net counts it on
            the day the guest paid; Stripe's fee is a cost that day. A refund comes off the sale. A deposit is only held: what the
            team captures after check-out beyond the charges shows as "Security deposit kept". Test-mode payments show here
            so the team can try the flow, and are never counted.</Hint></h2>
        </div>
        {list === null ? <p className="note loading-dot">Reading</p> : !items.length ? <p className="note">Nothing sold in this range.</p> : (
          <div className="table-wrap">
            <table className="money-table">
              <thead><tr><th>Item</th><th className="n">Sold</th><th className="n">Amount</th></tr></thead>
              <tbody>{items.map(i => <tr key={i.item}><td>{i.label}</td><td className="n">{i.count}</td><td className="n">{money2(i.amount)}</td></tr>)}</tbody>
            </table>
            {!s.live.length && <p className="note">Test mode only — these figures are not in profit.</p>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="row-controls">
          <h2>Payments <Hint>One row per payment, newest first. Unit = the house the guest paid from; "—" when the page did not know
            it (the demo). Each row is re-read from Stripe when the guest's page confirms it and again by Stripe's webhook
            (Settings → Integrations → Stripe).</Hint></h2>
          <span className="rb-spacer" />
          {s.test.length > 0 && <label className="chip"><input type="checkbox" checked={tests} onChange={e => setTests(e.target.checked)} /> Show test</label>}
        </div>
        {list === null ? null : !rows.length ? <p className="note">No payments in this range.</p> : (
          <div className="table-wrap">
            <table className="money-table">
              <thead><tr><th>Day</th><th>Unit</th><th>Guest</th><th>Items</th><th className="n">Amount</th><th className="n">Fee</th><th>State</th></tr></thead>
              <tbody>{rows.map(p => (
                <tr key={p.id}>
                  <td>{p.paidOn}</td><td>{p.unitName ?? '—'}</td><td>{p.guest ?? '—'}</td>
                  <td>{p.lines.map(l => `${l.label}${l.hold ? ' (held)' : ''}`).join(' · ')}</td>
                  <td className="n">{money2(p.amount)}{p.refunded > 0 && <small> −{money2(p.refunded)}</small>}</td>
                  <td className="n">{p.fee != null ? money2(p.fee) : '—'}</td>
                  <td>{STATUS[p.status]}{!p.livemode && <span className="g-pill"> Test</span>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
