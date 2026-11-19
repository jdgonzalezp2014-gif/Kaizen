/**
 * Charge an upsell from its case (owner, 2026-11-19) — the same block in Operations → To-do (the case's panel) and in
 * the Inbox (right after the chat's + → Upsell). Airbnb: the Resolution Center / the reservation's page and a message
 * for the guest; any other channel: Kaizen holds the nights or the hour in Hostaway and makes a Stripe pay link, which
 * also shows on the guest's stay page as a pending payment. Rules: src/lib/upsell-charge.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { cancelUpsellCharge, getChargePlan, makeCharge, type ChargePlan } from '../api.ts';
import { extraNights, hourLabel, hourOptions, hourPrice, nightsPrice } from '../lib/upsell-charge.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';

const md = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
    <Icon n={done ? 'check' : 'clipboard'} /> {done ? 'Copied' : label}</button>;
}

export function UpsellCharge({ claimId, hasStay, onChanged }: { claimId: string; hasStay: boolean; onChanged?: () => void }) {
  const [plan, setPlan] = useState<ChargePlan | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState(0);
  const [after, setAfter] = useState(0);
  const [hour, setHour] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [typed, setTyped] = useState(false);
  const [made, setMade] = useState<{ guestText: string; warning?: string | null } | null>(null);
  const [sure, setSure] = useState('');
  const load = () => {
    if (!hasStay) return;
    void getChargePlan(claimId).then(r => r.ok ? (setPlan(r), setMsg(r.message ?? '')) : setMsg(r.message ?? r.error ?? 'Could not read the stay.'))
      .catch(e => setMsg(String(e)));
  };
  useEffect(load, [claimId, hasStay]);

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

  const make = async () => {
    setBusy(true); setMsg(''); setMade(null);
    const r = await makeCharge({ claim: claimId, amount: Number(amount), before, after, hour })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? ('error' in r ? r.error : '') ?? 'Not made.'); load(); return; }
    setMade({ guestText: r.guestText, warning: r.airbnb ? null : r.warning });
    setBefore(0); setAfter(0); setHour(null); setTyped(false);
    load(); onChanged?.();
  };
  const cancel = async (id: string) => {
    setBusy(true); setMsg('');
    const r = await cancelUpsellCharge(id).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false); setSure('');
    setMsg(r.ok ? `Cancelled${r.notes.length ? ` — ${r.notes.join(', ')}` : ''}.` : r.message ?? 'Not cancelled.');
    setMade(null); load(); onChanged?.();
  };
  const ready = Number(amount) > 0 && (need !== 'nights' || before + after > 0) && ((need !== 'checkin' && need !== 'checkout') || hour != null);
  const step = (v: number, set: (n: number) => void, max: number, label: string) => (
    <label className="uc-step"><span>{label}</span>
      <span className="uc-stepper">
        <button type="button" className="small" aria-label={`Fewer — ${label}`} disabled={v <= 0} onClick={() => set(v - 1)}>−</button>
        <b>{v}</b>
        <button type="button" className="small" aria-label={`More — ${label}`} disabled={v >= max} onClick={() => set(v + 1)}>+</button>
      </span><small>{max ? `${max} free` : 'none free'}</small></label>
  );

  return (
    <section className="uc">
      <div className="uc-head"><b><Icon n="card" /> Charge the guest</b>
        <Hint>{stay?.airbnb
          ? <>Airbnb collects on its own bookings, so nothing is charged or blocked here. Ask for the money in Airbnb's <b>Resolution Center</b>,
            or for more nights use <b>Change reservation</b> on the reservation's page (the nights must stay open for it). <b>Log it</b> saves
            the amount asked on this case and gives you a message to paste in the chat.</>
          : <>For any channel but Airbnb, Kaizen does it all from here: first it <b>holds</b> what the upsell takes in Hostaway — extra nights blocked on
            the calendar, or the new check-in / check-out hour on the reservation (read back to confirm) — and only then makes a <b>pay link</b> (Stripe:
            card, Apple Pay, Google Pay). Send the link in the chat; the guest also sees it on their stay page under <b>Pending payments</b>.
            Paid → this case gets the price and closes as Paid. <b>Cancel</b> reopens the nights / puts the hour back. Extending the reservation's own
            dates in Hostaway is still done there — the block keeps the nights until then.</>}</Hint>
      </div>

      {stay?.airbnb && plan.links && (
        <p className="uc-links">
          <a className="chip" href={plan.links.resolution} target="_blank" rel="noreferrer"><Icon n="dollar" /> Resolution Center ↗</a>
          {plan.links.reservation && <a className="chip" href={plan.links.reservation} target="_blank" rel="noreferrer"><Icon n="calendar" /> Change dates on Airbnb ↗</a>}
        </p>
      )}

      {pending && (
        <div className="uc-charge">
          <div className="uc-line"><span className="uc-state"><Icon n="clock" /> Pending</span><b>{pending.label}</b><span className="uc-amt">{money2(pending.amount)}</span></div>
          {pending.holds.map(h => <p key={h} className="note"><Icon n="lock" /> {h}</p>)}
          {pending.payUrl && <p className="uc-acts">
            <Copy text={pending.payUrl} label="Copy pay link" />
            <Copy text={made?.guestText ?? `Here is the link to pay for ${pending.label} (${money2(pending.amount)}): ${pending.payUrl}`} label="Copy message" />
            <a className="chip" href={pending.payUrl} target="_blank" rel="noreferrer">Open ↗</a>
            <span className="rb-spacer" />
            {sure === pending.id
              ? <><button type="button" className="small danger" disabled={busy} onClick={() => void cancel(pending.id)}>Cancel it{pending.nights.length ? ' & reopen nights' : pending.hour != null ? ' & put the hour back' : ''}</button>
                  <button type="button" className="link tiny" onClick={() => setSure('')}>Keep</button></>
              : <button type="button" className="link tiny" onClick={() => setSure(pending.id)}>Cancel charge…</button>}
          </p>}
        </div>
      )}

      {!pending && stay && (
        <div className="uc-form">
          {need === 'nights' && !stay.airbnb && stay.arrival && stay.departure && plan.free && <div className="uc-steps">
            {step(before, setBefore, plan.free.before, `Before ${md(stay.arrival)}`)}
            {step(after, setAfter, plan.free.after, `After ${md(stay.departure)}`)}
          </div>}
          {(need === 'checkin' || need === 'checkout') && !stay.airbnb && (stayHour == null
            ? <p className="note warn">▲ Hostaway has no standard {need === 'checkin' ? 'check-in' : 'check-out'} hour for this stay.</p>
            : <label className="uc-hour"><span>New {need === 'checkin' ? 'check-in' : 'check-out'} (now {hourLabel(stayHour)})</span>
                <select value={hour ?? ''} onChange={e => setHour(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">Pick…</option>{hours.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select></label>)}
          <label className="uc-amount"><span>{stay.airbnb ? 'Amount asked' : 'Amount'}</span>
            <input type="number" min={0} step="0.01" className="money-in" placeholder="$" value={amount}
                   onChange={e => { setAmount(e.target.value); setTyped(true); }} />
            {suggested != null && typed && Number(amount) !== suggested && <button type="button" className="link tiny" onClick={() => setTyped(false)}>Use {money2(suggested)}</button>}
          </label>
          <button type="button" className="small ok" disabled={busy || !ready} onClick={() => void make()}>
            {busy ? 'Working…' : stay.airbnb ? 'Log it' : need === 'nights' ? 'Block nights & make pay link' : need === 'checkin' || need === 'checkout' ? 'Set the hour & make pay link' : 'Make pay link'}
          </button>
        </div>
      )}

      {made && <div className="uc-made">
        {made.warning && <p className="banner warn">▲ {made.warning}</p>}
        <p className="note">Message for the guest:</p>
        <blockquote>{made.guestText}</blockquote>
        <Copy text={made.guestText} label="Copy message" />
      </div>}

      {closed.length > 0 && <ul className="uc-past">
        {closed.map(c => <li key={c.id}><Icon n={c.status === 'paid' ? 'check' : 'ban'} /> {c.status === 'paid' ? `Paid${c.livemode ? '' : ' (test)'}` : 'Cancelled'} · {c.label} · {money2(c.amount)}
          {c.paidAt && <small> · {new Date(c.paidAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small>}</li>)}
      </ul>}
      {msg && <p className="note warn" role="status">{msg}</p>}
    </section>
  );
}
