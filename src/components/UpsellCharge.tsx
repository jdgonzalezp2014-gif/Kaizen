/**
 * Charge an upsell from its case (owner, 2026-11-19, §178 + round 2) — the same block in Operations → To-do (the case's
 * panel) and in the CRM (Upselling's + → Upsell → Next: charge). The guest pays by card (a Stripe link, also on their
 * stay page) or, on Airbnb, through the Resolution Center; an Airbnb date change can also be an alteration made on
 * Airbnb itself. Nothing moves in Hostaway until the money is confirmed. Rules: src/lib/upsell-charge.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { cancelUpsellCharge, getChargePlan, makeCharge, rcChargeReceived, type ChargePlan } from '../api.ts';
import { extraNights, hourLabel, hourOptions, hourPrice, nightsPrice, type ChargeMethod, type UpsellCharge as Charge } from '../lib/upsell-charge.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';

const md = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
type Way = ChargeMethod | 'alter';
const WAY_LABEL: Record<Way, string> = { card: 'Card', rc: 'Resolution Center', alter: 'Change it on Airbnb' };

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
    <Icon n={done ? 'check' : 'clipboard'} /> {done ? 'Copied' : label}</button>;
}

/** What a charge sets up in Hostaway once it is paid, in words. */
const sells = (c: Charge) => c.nights.length ? `${c.nights.length} night${c.nights.length === 1 ? '' : 's'} (${md(c.nights[0]!)}${c.nights.length > 1 ? ` – ${md(c.nights[c.nights.length - 1]!)}` : ''})`
  : c.hour != null ? `${c.need === 'checkin' ? 'check-in' : 'check-out'} at ${hourLabel(c.hour)}` : null;

export function UpsellCharge({ claimId, hasStay, onChanged }: { claimId: string; hasStay: boolean; onChanged?: () => void }) {
  const [plan, setPlan] = useState<ChargePlan | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [way, setWay] = useState<Way>('card');
  const [before, setBefore] = useState(0);
  const [after, setAfter] = useState(0);
  const [hour, setHour] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [typed, setTyped] = useState(false);
  const [got, setGot] = useState('');
  const [made, setMade] = useState<{ guestText: string; warning?: string | null } | null>(null);
  const [sure, setSure] = useState('');
  const load = () => {
    if (!hasStay) return;
    void getChargePlan(claimId).then(r => r.ok ? (setPlan(r), setMsg(r.message ?? '')) : setMsg(r.message ?? r.error ?? 'Could not read the stay.'))
      .catch(e => setMsg(String(e)));
  };
  useEffect(load, [claimId, hasStay]);
  // Airbnb: the Resolution Center first (Airbnb's own door); elsewhere the card is the only way.
  useEffect(() => { if (plan?.methods.length) setWay(w => w === 'alter' || plan.methods.includes(w as ChargeMethod) ? w : plan.methods[0]!); }, [plan?.methods.join()]);

  const stay = plan?.stay;
  const need = plan?.need ?? 'amount';
  const stayHour = need === 'checkin' ? stay?.checkInHour : need === 'checkout' ? stay?.checkOutHour : null;
  const hours = stayHour != null && (need === 'checkin' || need === 'checkout') ? hourOptions(need, stayHour) : [];
  // The price the rules give — filled in until the person types their own.
  const suggested = useMemo(() => {
    if (need === 'nights' && stay?.arrival && stay.departure && (before || after)) return nightsPrice(plan!.nightDays, extraNights(stay.arrival, stay.departure, before, after));
    if ((need === 'checkin' || need === 'checkout') && stayHour != null && hour != null) return hourPrice(need, stayHour, hour) || null;
    return null;
  }, [need, stay, before, after, hour, stayHour, plan]);
  useEffect(() => { if (!typed) setAmount(suggested != null ? String(suggested) : ''); }, [suggested, typed]);

  if (!hasStay) return <p className="note uc-none"><Icon n="card" /> To charge it, pick the stay first (✎ Edit claim → Stay).</p>;
  if (!plan) return <p className="note">{msg || 'Reading the stay…'}</p>;
  const pending = plan.charges.find(c => c.status === 'pending');
  const closed = plan.charges.filter(c => c.status !== 'pending');
  const ways: Way[] = [...(stay?.airbnb && need === 'nights' ? ['alter' as const] : []), ...plan.methods];

  const make = async () => {
    if (way === 'alter') return;
    setBusy(true); setMsg(''); setMade(null);
    const r = await makeCharge({ claim: claimId, amount: Number(amount), method: way, before, after, hour })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? ('error' in r ? r.error : '') ?? 'Not made.'); load(); return; }
    setMade({ guestText: r.guestText, warning: r.warning });
    setBefore(0); setAfter(0); setHour(null); setTyped(false);
    load(); onChanged?.();
  };
  const act = async (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, done: string) => {
    setBusy(true); setMsg('');
    const r: { ok: boolean; message?: string; error?: string } = await fn().catch(e => ({ ok: false, message: String(e) }));
    setBusy(false); setSure(''); setGot('');
    setMsg(r.ok ? done : r.message ?? r.error ?? 'Not saved.');
    setMade(null); load(); onChanged?.();
  };
  const ready = way !== 'alter' && Number(amount) > 0 && (need !== 'nights' || before + after > 0) && ((need !== 'checkin' && need !== 'checkout') || hour != null);
  const step = (v: number, set: (n: number) => void, max: number, label: string) => (
    <label className="uc-step"><span>{label}</span>
      <span className="uc-stepper">
        <button type="button" className="small" aria-label={`Fewer — ${label}`} disabled={v <= 0} onClick={() => set(v - 1)}>−</button>
        <b>{v}</b>
        <button type="button" className="small" aria-label={`More — ${label}`} disabled={v >= max} onClick={() => set(v + 1)}>+</button>
      </span><small>{max ? `${max} free` : 'none free'}</small></label>
  );
  const cancelBtn = (c: Charge) => sure === c.id
    ? <><button type="button" className="small danger" disabled={busy} onClick={() => void act(() => cancelUpsellCharge(c.id), 'Cancelled.')}>Cancel it</button>
        <button type="button" className="link tiny" onClick={() => setSure('')}>Keep</button></>
    : <button type="button" className="link tiny" onClick={() => setSure(c.id)}>Cancel charge…</button>;

  return (
    <section className="uc">
      <div className="uc-head"><b><Icon n="card" /> Charge the guest</b>
        <Hint>How the guest pays: <b>Card</b> — a Stripe pay link (card, Apple Pay, Google Pay) to send in the chat; the guest also sees it on
          their stay page under Pending payments. On Airbnb also <b>Resolution Center</b> — ask there, then mark it received here when the money comes
          in. For more nights on Airbnb, <b>Change it on Airbnb</b> is the alteration the guest accepts (its price lands on the reservation).
          <br /><br />Nothing changes in Hostaway until the money is confirmed. Then Kaizen sets it up on its own: the new check-in / check-out hour
          on the reservation; extra nights on a direct booking extend the reservation; on Airbnb, Vrbo, Booking.com or Expedia the nights are blocked
          on the calendar and an urgent to-do asks for the door code, the clean and the check-out messages (the reservation keeps its dates).
          If Hostaway refuses, an urgent to-do says so. Paid → this case gets the price and closes as Paid; a refund in Stripe comes off it.</Hint>
      </div>

      {stay?.cancelled && <p className="banner warn">▲ The reservation is cancelled in Hostaway — nothing to charge.</p>}
      {stay?.airbnb && plan.links && (
        <p className="uc-links">
          <a className="chip" href={plan.links.resolution} target="_blank" rel="noreferrer"><Icon n="dollar" /> Resolution Center ↗</a>
          {plan.links.reservation && <a className="chip" href={plan.links.reservation} target="_blank" rel="noreferrer"><Icon n="calendar" /> Reservation on Airbnb ↗</a>}
        </p>
      )}

      {pending && (
        <div className="uc-charge">
          <div className="uc-line"><span className="uc-state"><Icon n="clock" /> {pending.method === 'rc' ? 'Asked in the Resolution Center' : 'Waiting for the card payment'}</span>
            <b>{pending.label}</b><span className="uc-amt">{money2(pending.amount)}</span></div>
          {sells(pending) && <p className="note"><Icon n="lock" /> Set up in Hostaway once paid: {sells(pending)}</p>}
          {pending.method === 'card' && pending.payUrl && <p className="uc-acts">
            <Copy text={pending.payUrl} label="Copy pay link" />
            <Copy text={made?.guestText ?? `Here is the link to pay for ${pending.label} (${money2(pending.amount)}): ${pending.payUrl}`} label="Copy message" />
            <a className="chip" href={pending.payUrl} target="_blank" rel="noreferrer">Open ↗</a>
            <span className="rb-spacer" />{cancelBtn(pending)}
          </p>}
          {pending.method === 'rc' && <p className="uc-acts">
            <label className="uc-amount"><span>Received</span>
              <input type="number" min={0} step="0.01" className="money-in" placeholder={String(pending.amount)} value={got} onChange={e => setGot(e.target.value)} /></label>
            <button type="button" className="small ok" disabled={busy} onClick={() => void act(() => rcChargeReceived(pending.id, Number(got || pending.amount)), 'Received — setting it up in Hostaway.')}>
              <Icon n="done" /> Mark received</button>
            {made && <Copy text={made.guestText} label="Copy message" />}
            <span className="rb-spacer" />{cancelBtn(pending)}
          </p>}
        </div>
      )}

      {!pending && stay && !stay.cancelled && (
        <div className="uc-form">
          {ways.length > 1 && <div className="uc-ways" role="radiogroup" aria-label="How the guest pays">
            {ways.map(w => <button key={w} type="button" role="radio" aria-checked={way === w} className={way === w ? 'chip active' : 'chip'} onClick={() => setWay(w)}>{WAY_LABEL[w]}</button>)}
          </div>}
          {way === 'alter'
            ? <p className="note">Open <b>Reservation on Airbnb</b> above → Change reservation, add the nights and send it; the guest accepts it on Airbnb. Its price lands on
                the reservation, so nothing is charged or logged here.</p>
            : <>
              {need === 'nights' && stay.arrival && stay.departure && plan.free && <div className="uc-steps">
                {step(before, setBefore, plan.free.before, `Before ${md(stay.arrival)}`)}
                {step(after, setAfter, plan.free.after, `After ${md(stay.departure)}`)}
              </div>}
              {(need === 'checkin' || need === 'checkout') && (stayHour == null
                ? <p className="note warn">▲ Hostaway has no standard {need === 'checkin' ? 'check-in' : 'check-out'} hour for this stay.</p>
                : <label className="uc-hour"><span>New {need === 'checkin' ? 'check-in' : 'check-out'} (now {hourLabel(stayHour)})</span>
                    <select value={hour ?? ''} onChange={e => setHour(e.target.value === '' ? null : Number(e.target.value))}>
                      <option value="">Pick…</option>{hours.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
                    </select></label>)}
              <label className="uc-amount"><span>Amount</span>
                <input type="number" min={0} step="0.01" className="money-in" placeholder="$" value={amount}
                       onChange={e => { setAmount(e.target.value); setTyped(true); }} />
                {suggested != null && typed && Number(amount) !== suggested && <button type="button" className="link tiny" onClick={() => setTyped(false)}>Use {money2(suggested)}</button>}
              </label>
              <button type="button" className="small ok" disabled={busy || !ready} onClick={() => void make()}>
                {busy ? 'Working…' : way === 'rc' ? 'Log the RC request' : 'Make pay link'}</button>
            </>}
        </div>
      )}

      {made && <div className="uc-made">
        {made.warning && <p className="banner warn">▲ {made.warning}</p>}
        <p className="note">Message for the guest:</p>
        <blockquote>{made.guestText}</blockquote>
        <Copy text={made.guestText} label="Copy message" />
      </div>}

      {closed.length > 0 && <ul className="uc-past">
        {closed.map(c => <li key={c.id}>
          <Icon n={c.status === 'paid' ? 'check' : 'ban'} /> {c.status === 'paid' ? `Paid${c.method === 'rc' ? ' (Resolution Center)' : c.livemode ? '' : ' (test)'}` : 'Cancelled'} · {c.label} · {money2(c.amount)}
          {c.paidAt && <small> · {new Date(c.paidAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small>}
          {c.refunded > 0 && <small> · refunded {money2(c.refunded)}</small>}
          {c.holds.map(h => <small key={h} className="uc-hold"><Icon n="lock" /> {h}</small>)}
          {c.applyError && <small className="uc-err">▲ Not set up in Hostaway: {c.applyError}</small>}
        </li>)}
      </ul>}
      {msg && <p className="note warn" role="status">{msg}</p>}
    </section>
  );
}
