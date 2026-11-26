/**
 * Guest Services → Payments (owner, 2026-11-26): what each guest paid in the portal and whether it was set up, refunds,
 * deposits released or kept, the team's charges and their cancellations, how many online check-ins were completed with
 * which protection, and which listings have Hostaway's refundable deposit on. Server: functions/_lib/payments-desk.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { getPayments, paymentAction } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { chargesOf, share, tally, type ProtectionPick } from '../lib/payments-desk.ts';
import type { GuestPayment } from '../lib/guest-payments.ts';
import { Hint } from '../components/Hint.tsx';
import { Modal } from '../components/Modal.tsx';

export type DeskPayment = GuestPayment & { createdAt: string; followUps: { id: string; status: string; done: boolean }[]; hold: number; holdEndsOn: string | null; refundable: number };
type Charge = { id: string; claim_id: string; reservation_id: string; unit_name: string | null; guest: string | null; label: string; amount: number;
  status: 'pending' | 'paid' | 'cancelled'; method: string; created_by: string; created_at: string; paid_at: string | null; cancelled_at: string | null; cancelled_by: string | null };
type Action = { id: string; session_id: string; kind: 'refund' | 'release' | 'capture'; amount: number; reason: string | null; created_by: string; created_at: string;
  guest: string | null; unit_name: string | null; livemode: boolean | null };
type Checkin = { reservationId: string; listingId: string | null; source: string; completedAt: string; pick: ProtectionPick; depositOn: boolean | null };
type Listing = { id: string; name: string; deposit: number | null; picks: ProtectionPick[] };
export interface Overview { days: number; payments: DeskPayment[]; charges: Charge[]; actions: Action[]; checkins: Checkin[]; listings: Listing[]; hostawayRead: boolean }

const STATE: Record<GuestPayment['status'], string> = { paid: '✓ Paid', held: '○ Held', refunded: '↺ Refunded', released: '○ Released' };
const day = (iso: string | null) => iso ? iso.slice(0, 10) : '—';
const who = (email: string | null) => email ? email.split('@')[0] : '—';

export type Ask = { kind: 'refund' | 'release' | 'keep'; p: DeskPayment } | { kind: 'cancel-charge'; c: Charge };

export function Payments({ canAct }: { canAct: boolean }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [tests, setTests] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    setData(null);
    getPayments(days).then(r => { if (r.ok) { setData(r); setErr(''); } else setErr(r.message ?? 'Could not read the payments.'); }).catch(e => setErr(String(e)));
  }, [days, n]);

  const v = useMemo(() => {
    if (!data) return null;
    const pays = data.payments.filter(p => tests || p.livemode);
    const t = tally(data.checkins.map(c => c.pick));
    const on = tally(data.checkins.filter(c => c.depositOn === true).map(c => c.pick));
    const off = tally(data.checkins.filter(c => c.depositOn === false).map(c => c.pick));
    const held = data.payments.filter(p => p.livemode && p.status === 'held');
    const refunds = data.actions.filter(a => a.kind === 'refund').reduce((s, a) => s + a.amount, 0);
    const log = [
      ...data.actions.map(a => ({ at: a.created_at, what: a.kind === 'refund' ? '↺ Refund' : a.kind === 'release' ? '○ Deposit released' : '✓ Deposit kept',
        guest: a.guest, unit: a.unit_name, amount: a.amount, by: a.created_by, why: a.reason, test: a.livemode === false })),
      ...data.charges.filter(c => c.status === 'cancelled').map(c => ({ at: c.cancelled_at ?? c.created_at, what: '✕ Charge cancelled',
        guest: c.guest, unit: c.unit_name, amount: c.amount, by: c.cancelled_by ?? '', why: c.label, test: false })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const withDeposit = data.listings.filter(l => (l.deposit ?? 0) > 0).length;
    return { pays, t, on, off, held, refunds, log, withDeposit };
  }, [data, tests]);

  return (
    <section>
      <div className="row-controls">
        <h1>Payments <Hint>What guests paid in the portal (card, through Stripe) and what was done with it. Refund gives money back
          on a paid line; a held deposit is released (nothing charged) or part of it is kept for damage. Every action is re-read from
          Stripe and listed under Refunds &amp; cancellations with who did it and why.</Hint></h1>
        <span className="rb-spacer" />
        {[7, 30, 90].map(d => <button key={d} className={days === d ? 'chip active' : 'chip'} onClick={() => setDays(d)}>{d} days</button>)}
      </div>
      {err && <p className="banner error">{err}</p>}
      {!data || !v ? (!err && <p className="note loading-dot">Reading</p>) : <>
        <dl className="strip">
          <div><dt>Check-ins completed</dt><dd>{v.t.completed}<small>{data.checkins.filter(c => c.source === 'portal').length} online · {data.checkins.filter(c => c.source === 'team').length} by the team</small></dd></div>
          <div><dt>Damage waiver</dt><dd>{v.t.waiver}<small>{share(v.t.waiver, v.t.completed)} of check-ins</small></dd></div>
          <div><dt>Security deposit</dt><dd>{v.t.deposit}<small>{share(v.t.deposit, v.t.completed)} of check-ins</small></dd></div>
          <div><dt>None (Airbnb)</dt><dd>{v.t.none}<small>{share(v.t.none, v.t.completed)} of check-ins</small></dd></div>
          <div><dt>Deposits held</dt><dd>{money2(v.held.reduce((s, p) => s + p.hold, 0))}<small>{v.held.length} on guests' cards</small></dd></div>
          <div><dt>Refunded</dt><dd>{money2(v.refunds)}<small>from Kaizen, last {days} days</small></dd></div>
        </dl>

        <div className="card">
          <div className="row-controls">
            <h2>Payments <Hint>One row per payment, newest first; held deposits stay listed whatever their date. "Set up" is the to-do
              Kaizen makes when a guest buys an extra (early check-in, late check-out, pet…): the team changes Hostaway and tells the
              cleaner, then ticks it. A hold lasts about 7 days — after "Hold ends" Stripe lets it go by itself and nothing can be kept.
              Keeping part of a deposit charges that part; the rest goes back to the guest at once.</Hint></h2>
            <span className="rb-spacer" />
            <label className="chip"><input type="checkbox" checked={tests} onChange={e => setTests(e.target.checked)} /> Show test</label>
          </div>
          {!v.pays.length ? <p className="note">No payments in the last {days} days.</p> : (
            <div className="table-wrap">
              <table className="money-table">
                <thead><tr><th>Day</th><th>Guest</th><th>Unit</th><th>Items</th><th className="n">Amount</th><th>State</th><th>Set up</th>{canAct && <th />}</tr></thead>
                <tbody>{v.pays.map(p => (
                  <tr key={p.id}>
                    <td>{p.paidOn}</td><td>{p.guest ?? '—'}</td><td>{p.unitName ?? '—'}</td>
                    <td>{p.lines.map(l => `${l.label}${l.hold ? ' (hold)' : ''}`).join(' · ')}</td>
                    <td className="n">{money2(p.amount)}{p.refunded > 0 && <small> −{money2(p.refunded)}</small>}</td>
                    <td>{STATE[p.status]}{p.holdEndsOn && <small> · hold ends {p.holdEndsOn}</small>}{!p.livemode && <span className="g-pill"> Test</span>}</td>
                    <td>{p.followUps.length ? p.followUps.map(t => <span key={t.id}>{t.done ? '✓' : '!'} #{t.id} {t.done ? 'done' : 'pending'} </span>) : '—'}</td>
                    {canAct && <td>
                      {p.status === 'held' && <><button className="chip" onClick={() => setAsk({ kind: 'release', p })}>Release</button>
                        <button className="chip" onClick={() => setAsk({ kind: 'keep', p })}>Keep…</button></>}
                      {p.refundable > 0 && <button className="chip" onClick={() => setAsk({ kind: 'refund', p })}>Refund…</button>}
                    </td>}
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </div>

        {data.charges.length > 0 && <div className="card">
          <h2>Team charges <Hint>Charges the team made from a case (a pay link or Airbnb's Resolution Center). Pending = not paid yet;
            Cancel closes the pay link. Once paid, Kaizen sets Hostaway up by itself. A paid card charge is refunded in Payments above.</Hint></h2>
          <div className="table-wrap">
            <table className="money-table">
              <thead><tr><th>Made</th><th>Guest</th><th>Unit</th><th>What</th><th>How</th><th className="n">Amount</th><th>State</th>{canAct && <th />}</tr></thead>
              <tbody>{data.charges.map(c => (
                <tr key={c.id}>
                  <td>{day(c.created_at)}</td><td>{c.guest ?? '—'}</td><td>{c.unit_name ?? '—'}</td><td>{c.label}</td>
                  <td>{c.method === 'rc' ? 'Airbnb RC' : 'Card link'}</td><td className="n">{money2(c.amount)}</td>
                  <td>{c.status === 'paid' ? `✓ Paid ${day(c.paid_at)}` : c.status === 'cancelled' ? `✕ Cancelled · ${who(c.cancelled_by)}` : '○ Pending'}</td>
                  {canAct && <td>{c.status === 'pending' && <button className="chip" onClick={() => setAsk({ kind: 'cancel-charge', c })}>Cancel</button>}</td>}
                </tr>))}</tbody>
            </table>
          </div>
        </div>}

        <div className="card">
          <h2>Refunds &amp; cancellations <Hint>Everything given back or called off from Kaizen in the last {days} days: refunds, deposits
            released or kept, team charges cancelled. A refund made in Stripe's own dashboard shows on the payment's amount, not here.</Hint></h2>
          {!v.log.length ? <p className="note">Nothing refunded or cancelled in the last {days} days.</p> : (
            <div className="table-wrap">
              <table className="money-table">
                <thead><tr><th>When</th><th>What</th><th>Guest</th><th>Unit</th><th className="n">Amount</th><th>By</th><th>Why</th></tr></thead>
                <tbody>{v.log.map((a, i) => (
                  <tr key={i}><td>{day(a.at)}</td><td>{a.what}{a.test && <span className="g-pill"> Test</span>}</td><td>{a.guest ?? '—'}</td><td>{a.unit ?? '—'}</td>
                    <td className="n">{money2(a.amount)}</td><td>{who(a.by)}</td><td>{a.why ?? '—'}</td></tr>))}</tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="row-controls">
            <h2>Deposit by listing <Hint>Hostaway's own "Refundable damage deposit" for each active listing, read from Hostaway now.
              On → the channel requires it, so the portal does not offer Airbnb guests "None of them": only the waiver or the deposit.
              Off → Airbnb guests may also pick None. The check-in columns count the online check-ins completed in the last {days} days.</Hint></h2>
            <span className="rb-spacer" />
            <span className="note">{data.hostawayRead ? `${v.withDeposit} on · ${data.listings.length - v.withDeposit} off` : '! Hostaway could not be read'}</span>
          </div>
          <div className="table-wrap">
            <table className="money-table">
              <thead><tr><th>Listing</th><th>Hostaway deposit</th><th>"None" on Airbnb</th><th className="n">Check-ins</th><th className="n">Waiver</th><th className="n">Deposit</th><th className="n">None</th></tr></thead>
              <tbody>{[...data.listings].sort((a, b) => (b.deposit ?? 0) - (a.deposit ?? 0) || a.name.localeCompare(b.name)).map(l => {
                const t = tally(l.picks);
                return <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.deposit == null ? '? Not read' : l.deposit > 0 ? `✓ On · ${money2(l.deposit)}` : '— Off'}</td>
                  <td>{l.deposit == null ? '—' : l.deposit > 0 ? 'Not offered' : 'Offered'}</td>
                  <td className="n">{t.completed || '—'}</td><td className="n">{t.waiver || '—'}</td><td className="n">{t.deposit || '—'}</td><td className="n">{t.none || '—'}</td>
                </tr>;
              })}</tbody>
              <tfoot>
                <tr><td>Deposit on</td><td /><td /><td className="n">{v.on.completed}</td><td className="n">{v.on.waiver}</td><td className="n">{v.on.deposit}</td><td className="n">{v.on.none}</td></tr>
                <tr><td>Deposit off</td><td /><td /><td className="n">{v.off.completed}</td><td className="n">{v.off.waiver}</td><td className="n">{v.off.deposit}</td><td className="n">{v.off.none}</td></tr>
              </tfoot>
            </table>
          </div>
        </div>
      </>}
      {ask && <ActionDialog ask={ask} onClose={() => setAsk(null)} onDone={() => { setAsk(null); setN(x => x + 1); }} />}
    </section>
  );
}

export function ActionDialog({ ask, onClose, onDone }: { ask: Ask; onClose: () => void; onDone: () => void }) {
  const p = ask.kind === 'cancel-charge' ? null : ask.p;
  const target = ask.kind === 'cancel-charge' ? ask.c.id : ask.p.id;
  const max = !p ? 0 : ask.kind === 'refund' ? p.refundable : p.hold;
  const [amount, setAmount] = useState(String(max || ''));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = Number(amount);
  const needsAmount = ask.kind === 'refund' || ask.kind === 'keep';
  const needsReason = ask.kind === 'refund' || ask.kind === 'keep';
  const ok = (!needsAmount || (n > 0 && n <= max + 1e-9)) && (!needsReason || reason.trim().length > 2);
  const guest = ask.kind === 'cancel-charge' ? ask.c.guest : ask.p.guest;
  const title = ask.kind === 'refund' ? 'Refund' : ask.kind === 'release' ? 'Release the deposit' : ask.kind === 'keep' ? 'Keep part of the deposit' : 'Cancel the charge';
  const cta = ask.kind === 'refund' ? `Refund ${money2(n || 0)}` : ask.kind === 'release' ? `Release ${money2(p!.hold)}`
    : ask.kind === 'keep' ? `Keep ${money2(n || 0)}, release ${money2(Math.max(0, max - (n || 0)))}` : `Cancel ${money2(ask.kind === 'cancel-charge' ? ask.c.amount : 0)}`;
  const go = async () => {
    setBusy(true); setErr('');
    const r = await paymentAction({ action: ask.kind, id: target, amount: needsAmount ? n : undefined, reason: reason.trim() || undefined })
      .catch(e => ({ ok: false, message: String(e) }));
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.message ?? 'It did not go through.');
  };
  return (
    <Modal title={`${title} — ${guest ?? 'guest'}`} onClose={onClose}>
      {p && <p className="note">{p.unitName ?? '—'} · {p.lines.map(l => `${l.label} ${money2(l.amount)}${l.hold ? ' (hold)' : ''}`).join(' · ')}</p>}
      {ask.kind === 'cancel-charge' && <p className="note">{ask.c.unit_name ?? '—'} · {ask.c.label} · {ask.c.method === 'rc' ? 'Airbnb RC' : 'card link'}. The pay link stops working; nothing was set up in Hostaway yet.</p>}
      {ask.kind === 'release' && <p className="note">Nothing of the deposit is charged; the hold comes off the guest's card.{p && chargesOf(p.lines) > 0 ? ` The other lines (${money2(chargesOf(p.lines))}) are charged now.` : ''}</p>}
      {ask.kind === 'keep' && <p className="note">Up to {money2(max)}. The rest goes back to the guest now; this can be done once.</p>}
      {needsAmount && <label className="field">Amount<input type="number" min="0.01" step="0.01" max={max} value={amount} onChange={e => setAmount(e.target.value)} /></label>}
      {needsAmount && max > 0 && <small className="note">Up to {money2(max)}</small>}
      <label className="field">{needsReason ? 'Why' : 'Note (optional)'}<input value={reason} onChange={e => setReason(e.target.value)}
        placeholder={ask.kind === 'keep' ? 'The damage it pays for' : ask.kind === 'refund' ? 'e.g. early check-in not possible' : ''} /></label>
      {err && <p className="banner error">{err}</p>}
      <div className="row-controls"><span className="rb-spacer" />
        <button className="chip" onClick={onClose}>Back</button>
        <button className="primary" disabled={!ok || busy} onClick={go}>{busy ? 'Working…' : cta}</button></div>
    </Modal>
  );
}
