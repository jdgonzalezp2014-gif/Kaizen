/**
 * The guest's page (guests module, 2026-11-05): their stay, what is due, the check-in instructions, extras.
 * Same look as the handyman's page by house (Work.tsx): the island on top, a carousel of cards, a card opens
 * into its detail. Owner: premium because it sells, simple enough for anyone — no explaining text on screen.
 * Demo data only: nothing is charged, nothing goes to Hostaway; `send` is the seam for the API.
 */
import { useState } from 'react';
import { Carousel } from './Work.tsx';
import { Icon, ic } from '../components/Icon.tsx';
import { Hint } from '../components/Hint.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { useUrlState } from '../components/useUrlState.ts';
import { money2 } from '../lib/format.ts';
import { UPSELLS, availability, choiceLine, guide, nights, payState, quote, ready, upsellRequest,
  type Choice, type GuestStay, type Upsell, type UpsellRequest } from '../lib/guest-portal.ts';

type Send = (r: UpsellRequest) => Promise<{ ok: boolean; message?: string }>;
type Sec = 'stay' | 'extras';
const of = (i: number, n: number) => `${i} of ${n}`;

const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
// The houses are in Texas: the release time reads in Central.
const whenLabel = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

export function GuestPortal({ stay, send, now = new Date(), demoBar }: { stay: GuestStay; send: Send; now?: Date; demoBar?: React.ReactNode }) {
  const [sec, setSec] = useState<Sec>('stay');
  const [pick, setPick] = useState<Upsell['kind'] | null>(null);
  const [sent, setSent] = useState<UpsellRequest[]>([]);
  useUrlState('sec', sec, setSec, { def: 'stay', valid: v => v === 'stay' || v === 'extras' });
  useUrlState('extra', pick ?? '', v => setPick((v || null) as Upsell['kind'] | null), { def: '' });
  const open = UPSELLS.find(u => u.kind === pick) ?? null;
  const go = (s: Sec) => { setSec(s); setPick(null); };

  return <>
    <header className="v-island">
      <span className="v-island-name">{ic(`Hi, ${stay.guestFirst}`)}</span>
      <span className="v-seg" role="tablist">
        {([['stay', 'home', 'Stay'], ['extras', 'sparkles', 'Extras']] as [Sec, string, string][]).map(([k, icon, label]) =>
          <button key={k} role="tab" aria-selected={sec === k} className={sec === k ? 'on' : ''} onClick={() => go(k)}><Icon n={icon} /> {label}</button>)}
      </span>
      <span className="mini-tools"><ThemeToggle /></span>
    </header>
    <div className="report-page v-page g-page">
      {sec === 'stay' ? <StayView stay={stay} now={now} toExtras={() => go('extras')} />
        : open ? <Pick stay={stay} u={open} back={() => setPick(null)}
            send={async c => { const r = upsellRequest(stay, open, c, now); const res = await send(r); if (res.ok) { setSent(s => [...s, r]); setPick(null); } return res; }} />
        : <Extras stay={stay} sent={sent} choose={setPick} />}
      {demoBar}
    </div>
  </>;
}

function StayView({ stay, now, toExtras }: { stay: GuestStay; now: Date; toExtras: () => void }) {
  const n = nights(stay);
  const g = guide(stay, now);
  const [showGuide, setShowGuide] = useState(false);
  return <>
    <section className="card g-hero">
      <div className="g-photo" style={stay.photo ? { backgroundImage: `url(${stay.photo})` } : undefined}>
        {!stay.photo && <span className="g-photo-mark" aria-hidden><Icon n="home" /></span>}
        <span className="g-photo-name">{ic(stay.unitName)}</span>
      </div>
      <div className="g-dates">
        <div><span className="g-k">Check-in</span><b>{dateLabel(stay.arrival)}</b><span>{stay.checkInTime}</span></div>
        <span className="g-arrow" aria-hidden>→</span>
        <div><span className="g-k">Check-out</span><b>{dateLabel(stay.departure)}</b><span>{stay.checkOutTime}</span></div>
      </div>
      <p className="g-meta"><Icon n="bed" /> {n} {n === 1 ? 'night' : 'nights'} · <Icon n="users" /> {stay.guests} {stay.guests === 1 ? 'guest' : 'guests'}
        {stay.address && <> · <a href={`https://maps.google.com/?q=${encodeURIComponent(stay.address)}`} target="_blank" rel="noreferrer"><Icon n="pin" /> Map</a></>}</p>
    </section>

    <PayCard stay={stay} />

    <button className="card g-action" onClick={() => g.open && setShowGuide(v => !v)} aria-disabled={!g.open} aria-expanded={g.open ? showGuide : undefined}>
      <span className="g-action-icon"><Icon n="key" /></span>
      <span className="g-action-main"><b>Check-in instructions</b>
        {!g.open && <span className="g-lock"><Icon n="lock" /> {g.why === 'unpaid' ? 'Opens after payment' : g.at ? `Opens ${whenLabel(g.at)}` : 'Opens before arrival'}</span>}</span>
      {g.open && <span className="g-go">{showGuide ? '⌃' : '›'}</span>}
    </button>
    {/* The content (door code, Wi-Fi, parking) comes with the guidebook — said, not faked. */}
    {g.open && showGuide && <div className="card g-guide"><p className="note"><Icon n="clock" /> Coming soon: door code, Wi-Fi and parking will show here.</p></div>}

    <button className="card g-action" onClick={toExtras}>
      <span className="g-action-icon"><Icon n="sparkles" /></span>
      <span className="g-action-main"><b>Make it better</b><span className="note">Early check-in · Late check-out · Extra nights</span></span>
      <span className="g-go">›</span>
    </button>
  </>;
}

/** What is due and the one way to pay it. No link yet → the button says so instead of doing nothing. */
function PayCard({ stay }: { stay: GuestStay }) {
  const p = payState(stay);
  if (p.state === 'channel') return <p className="g-paid"><Icon n="done" /> {stay.channel === 'airbnb' ? 'Paid through Airbnb' : stay.channel === 'vrbo' ? 'Paid through Vrbo' : 'Nothing due'}</p>;
  if (p.state === 'paid') return <p className="g-paid"><span className="g-dot ok" aria-hidden>●</span> Paid · {money2(stay.total)}</p>;
  const url = stay.pay.url;
  return (
    <section className="card g-pay">
      <div className="g-pay-head">
        <span className="g-warn" aria-hidden>▲</span>
        <span><b className="g-due">{money2(p.due)} due</b>{p.state === 'partial' && <span className="note">{money2(stay.paid)} of {money2(stay.total)} paid</span>}</span>
        <Hint>Damage waiver for your stay. The check-in instructions open once it is paid. Payment is handled by our booking system — Kaizen never sees your card.</Hint>
      </div>
      {url ? <button className="g-cta" onClick={() => window.open(url, '_blank', 'noopener')}><Icon n="dollar" /> Pay {money2(p.due)}</button>
        : <><button className="g-cta" disabled><Icon n="dollar" /> Pay {money2(p.due)}</button>
          <p className="note g-limit">Payment link not connected yet.</p></>}
    </section>
  );
}

function priceLabel(stay: GuestStay, u: Upsell) {
  if (u.kind === 'extra-nights') return stay.nightly != null ? `${money2(stay.nightly)} / night` : '—';
  return u.price == null ? '—' : `${money2(u.price)}${u.per === 'item' ? ' each' : ''}`;
}

function Extras({ stay, sent, choose }: { stay: GuestStay; sent: UpsellRequest[]; choose: (k: Upsell['kind']) => void }) {
  const NO = { calendar: 'Not available for your dates', price: 'Ask us for a price', short: 'For stays of 4+ nights' } as const;
  return <>
    <h2 className="v-h g-h">Extras <Hint>Pick an extra and send the request. We confirm it, then you pay it with the same Pay button. Nothing is charged when you ask.</Hint></h2>
    <Carousel label="Extras" of={of}>{UPSELLS.map(u => {
      const a = availability(stay, u);
      const asked = sent.some(r => r.kind === u.kind);
      return (
        <button key={u.kind} className={`card v-house g-up${a.ok ? '' : ' off'}`} disabled={!a.ok} onClick={() => choose(u.kind)}>
          <span className="g-up-icon" aria-hidden><Icon n={u.icon} /></span>
          <span className="v-house-name">{u.title}</span>
          <span className="v-house-n">{priceLabel(stay, u)}</span>
          {!a.ok ? <span className="note">{NO[a.why]}</span>
            : a.flag === 'turnover' ? <span className="v-house-flag g-flag">▲ Depends on the clean</span> : null}
          {asked && <span className="v-house-flag"><Icon n="done" /> Requested</span>}
          {a.ok && <span className="v-house-go">Choose ›</span>}
        </button>);
    })}</Carousel>
    {sent.length > 0 && <section className="card g-reqs">
      <h3>Your requests</h3>
      {sent.map((r, i) => <div key={i} className="g-req">
        <span><b>{r.title}</b>{choiceLine(r) && <span className="note"> · {choiceLine(r)}</span>}</span>
        <span className="g-req-r">{r.quote != null && <b>{money2(r.quote)}</b>}<span className="g-pill">○ Pending</span></span>
      </div>)}
    </section>}
  </>;
}

function Pick({ stay, u, back, send }: { stay: GuestStay; u: Upsell; back: () => void; send: (c: Choice) => Promise<{ ok: boolean; message?: string }> }) {
  const [c, setC] = useState<Choice>(u.pick.type === 'qty' ? { qty: 1 } : u.kind === 'extra-nights' ? { before: stay.freeAfter > 0 ? 0 : Math.min(1, stay.freeBefore), after: stay.freeAfter > 0 ? 1 : 0 } : {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const a = availability(stay, u);
  const total = quote(stay, u, c);
  const ok = ready(stay, u, c);
  const submit = async () => { setBusy(true); setMsg(''); try { const r = await send(c); if (!r.ok) setMsg(r.message ?? 'Not sent.'); } catch (e) { setMsg(String(e)); } finally { setBusy(false); } };
  return <>
    <div className="v-house-head"><button className="chip" onClick={back}>‹ Extras</button></div>
    <section className="card g-pick">
      <p className="g-pick-title"><span className="g-up-icon" aria-hidden><Icon n={u.icon} /></span> {u.title}</p>
      {u.pick.type === 'time' && <div className="g-times" role="radiogroup" aria-label={u.kind === 'early-checkin' ? 'Arrive from' : 'Leave by'}>
        {u.pick.options.map(t => <button key={t} role="radio" aria-checked={c.time === t} className={c.time === t ? 'chip active' : 'chip'} onClick={() => setC({ time: t })}>{t}</button>)}
      </div>}
      {u.pick.type === 'nights' && <>
        {stay.freeBefore > 0 && <Stepper label={`Before ${dateLabel(stay.arrival)}`} value={c.before ?? 0} max={stay.freeBefore} set={v => setC({ ...c, before: v })} />}
        {stay.freeAfter > 0 && <Stepper label={`After ${dateLabel(stay.departure)}`} value={c.after ?? 0} max={stay.freeAfter} set={v => setC({ ...c, after: v })} />}
      </>}
      {u.pick.type === 'qty' && <Stepper label="How many" value={c.qty ?? 1} min={1} max={u.pick.max} set={v => setC({ qty: v })} />}
      {a.ok && a.flag === 'turnover' && <p className="g-turn">▲ Another guest {u.kind === 'early-checkin' ? 'leaves' : 'arrives'} that day — we confirm after the clean is planned.</p>}
      <div className="g-total"><span>Total</span><b>{total != null ? money2(total) : '—'}</b></div>
      <button className="g-cta" disabled={!ok || busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Request'}</button>
      {msg && <p className="breach" role="alert">{msg}</p>}
    </section>
  </>;
}

function Stepper({ label, value, set, min = 0, max }: { label: string; value: number; set: (v: number) => void; min?: number; max: number }) {
  return <div className="g-step">
    <span>{label}</span>
    <span className="g-step-ctl">
      <button className="chip" disabled={value <= min} onClick={() => set(value - 1)} aria-label={`Fewer — ${label}`}>−</button>
      <b aria-live="polite">{value}</b>
      <button className="chip" disabled={value >= max} onClick={() => set(value + 1)} aria-label={`More — ${label}`}>+</button>
    </span>
  </div>;
}

// ── Demo stays (the reference's scenarios that matter here) ──

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d; };
export type DemoKey = 'unpaid' | 'partial' | 'paid' | 'airbnb';
export const DEMO_KEYS: DemoKey[] = ['unpaid', 'partial', 'paid', 'airbnb'];
const DEMO_LABEL: Record<DemoKey, string> = { unpaid: 'Unpaid', partial: 'Partly paid', paid: 'Paid', airbnb: 'Airbnb' };

export function demoStay(k: DemoKey): GuestStay {
  const base: GuestStay = {
    id: `demo-${k}`, guestFirst: 'Sarah', unitName: 'Frisco Lakeside · 4BR', address: null, photo: null,
    arrival: iso(plus(3)), departure: iso(plus(6)), checkInTime: '4:00 PM', checkOutTime: '11:00 AM', guests: 6,
    channel: 'direct', total: 75, paid: 0, nightly: 189, freeBefore: 1, freeAfter: 2, turnIn: false, turnOut: true,
    guideReleaseAt: `${iso(plus(2))}T17:00:00Z`, pay: { provider: 'hostaway', url: null },
  };
  if (k === 'partial') return { ...base, paid: 36 };
  // Paid and released: arriving today, the guide is open.
  if (k === 'paid') return { ...base, paid: 75, arrival: iso(plus(0)), departure: iso(plus(5)), guideReleaseAt: `${iso(plus(-1))}T17:00:00Z`, turnIn: true, freeBefore: 0 };
  if (k === 'airbnb') return { ...base, channel: 'airbnb', total: 0, freeAfter: 0, freeBefore: 0, nightly: null };
  return base;
}

/** /guest/demo and /crew/guest-demo: one page, a strip to switch the demo stay. Nothing is sent. */
export function GuestDemoPage() {
  const q = new URLSearchParams(location.search).get('stay');
  const [k, setK] = useState<DemoKey>(DEMO_KEYS.includes(q as DemoKey) ? q as DemoKey : 'unpaid');
  const pickDemo = (x: DemoKey) => { setK(x); const u = new URL(location.href); u.searchParams.set('stay', x); history.replaceState(history.state, '', u); };
  return <GuestPortal key={k} stay={demoStay(k)} send={async () => ({ ok: true })}
    demoBar={<div className="g-demo" role="group" aria-label="Demo stay">
      <span className="note"><Icon n="eye" /> Demo</span>
      {DEMO_KEYS.map(x => <button key={x} className={x === k ? 'chip active' : 'chip'} onClick={() => pickDemo(x)}>{DEMO_LABEL[x]}</button>)}
    </div>} />;
}

/** A real stay link (/guest/<id>.<sig>) — the API that checks the signature and reads Hostaway is not built yet. */
export function GuestLinkPage() {
  return <div className="report-page v-page g-page"><p className="banner warn">▲ This stay page is not active yet.</p></div>;
}
