/**
 * The guest's page (guests module, 2026-11-05): their stay, what is due, the check-in instructions, extras.
 * Same look as the handyman's page by house (Work.tsx): the island on top, a carousel of cards, a card opens
 * into its detail. Owner: premium because it sells, simple enough for anyone — no explaining text on screen.
 * Demo data only: nothing is charged, nothing goes to Hostaway; `send` is the seam for the API.
 */
import { useEffect, useRef, useState } from 'react';
import { Carousel } from './Work.tsx';
import { DEFAULT_FIELDS, DEFAULT_FIELDS_AFTER, appleDir, googleDir, type HouseItem } from '../lib/checkin.ts';
import { checkinPhotoUrl } from '../api.ts';
import { Icon, ic } from '../components/Icon.tsx';
import { Hint } from '../components/Hint.tsx';
import { useUrlState } from '../components/useUrlState.ts';
import { money2 } from '../lib/format.ts';
import { UPSELLS, availability, choiceLine, guide, mapsUrl, nights, payState, priceOf, quote, ready, upsellRequest,
  type Choice, type GuestGuide, type GuestStay, type Upsell, type UpsellRequest } from '../lib/guest-portal.ts';

type Send = (r: UpsellRequest) => Promise<{ ok: boolean; message?: string }>;
export type Sec = 'stay' | 'checkin' | 'extras';
const of = (i: number, n: number) => `${i} of ${n}`;

const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
// The houses are in Texas: the release time reads in Central.
const whenLabel = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

/** `embedded`: the builder's live preview — no URL state, no page-wide theme (the preview box carries `.g-scope`). */
export function GuestPortal({ stay, send, now = new Date(), demoBar, embedded = false, startSec = 'stay' }: {
  stay: GuestStay; send: Send; now?: Date; demoBar?: React.ReactNode; embedded?: boolean; startSec?: Sec }) {
  const [sec, setSec] = useState<Sec>(startSec);
  const [pick, setPick] = useState<Upsell['kind'] | null>(null);
  const [sent, setSent] = useState<UpsellRequest[]>([]);
  useUrlState('sec', sec, setSec, { def: 'stay', valid: v => v === 'stay' || v === 'checkin' || v === 'extras', on: !embedded });
  useUrlState('extra', pick ?? '', v => setPick((v || null) as Upsell['kind'] | null), { def: '', on: !embedded });
  const open = UPSELLS.find(u => u.kind === pick) ?? null;
  const go = (s: Sec) => { setSec(s); setPick(null); };
  useBrand(!embedded);

  return <>
    <header className="v-island">
      <span className="v-island-name">{ic(`Hi, ${stay.guestFirst}`)}</span>
      <span className="v-seg" role="tablist">
        {([['stay', 'home', 'Stay'], ['checkin', 'key', 'Check-in'], ['extras', 'sparkles', 'Extras']] as [Sec, string, string][]).map(([k, icon, label]) =>
          <button key={k} role="tab" aria-selected={sec === k} className={sec === k ? 'on' : ''} onClick={() => go(k)}><Icon n={icon} /> {label}</button>)}
      </span>
    </header>
    <div className="report-page v-page g-page">
      {sec === 'stay' ? <StayView stay={stay} now={now} go={go} />
        : sec === 'checkin' ? <CheckinView stay={stay} now={now} />
        : open ? <Pick stay={stay} u={open} back={() => setPick(null)}
            send={async c => { const r = upsellRequest(stay, open, c, now); const res = await send(r); if (res.ok) { setSent(s => [...s, r]); setPick(null); } return res; }} />
        : <Extras stay={stay} sent={sent} choose={setPick} />}
      {demoBar}
    </div>
  </>;
}

/** The public site's palette (kaizenguestproperties, dark-only): warm black + gold. Applied to the whole
 *  document while the guest page is open, without touching the staff's saved day/night choice. */
function useBrand(on = true) {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const was = root.getAttribute('data-theme');
    root.classList.add('guest-brand');
    root.setAttribute('data-theme', 'dark');
    return () => { root.classList.remove('guest-brand'); if (was) root.setAttribute('data-theme', was); };
  }, [on]);
}

const lockLine = (g: ReturnType<typeof guide>) => g.open ? '' : g.why === 'unpaid' ? 'Opens after payment' : g.at ? `Opens ${whenLabel(g.at)}` : 'Opens before arrival';

/**
 * Stay (owner, 2026-11-09): the trip, what is due, the way to Check-in (its own tab — the most important part),
 * then the house info right on the page: Wi-Fi, trash, parking, rules, contact. Locked like the check-in.
 */
function StayView({ stay, now, go }: { stay: GuestStay; now: Date; go: (s: Sec) => void }) {
  const n = nights(stay);
  const g = guide(stay, now);
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

    <button className="card g-action g-action-main-cta" onClick={() => go('checkin')}>
      <span className="g-action-icon"><Icon n="key" /></span>
      <span className="g-action-main"><b>Check-in instructions</b>
        {g.open ? <span className="note">Step by step, from parking to your door</span> : <span className="g-lock"><Icon n="lock" /> {lockLine(g)}</span>}</span>
      <span className="g-go">›</span>
    </button>

    <h2 className="v-h g-h">Your stay</h2>
    {g.open ? <HouseManual g={stay.guide ?? null} />
      : <p className="card g-guide g-lock"><Icon n="lock" /> Wi-Fi, house info and contact {lockLine(g).replace(/^Opens/, 'open')}.</p>}

    <button className="card g-action" onClick={() => go('extras')}>
      <span className="g-action-icon"><Icon n="sparkles" /></span>
      <span className="g-action-main"><b>Make it better</b><span className="note">Early check-in · Late check-out · Extra nights</span></span>
      <span className="g-go">›</span>
    </button>
  </>;
}

/** Check-in (its own tab): the arrival steps with photos, or why they are not open yet. */
function CheckinView({ stay, now }: { stay: GuestStay; now: Date }) {
  const g = guide(stay, now);
  return <>
    <h2 className="v-h g-h">Check-in · {ic(stay.unitName)}</h2>
    <p className="g-meta g-checkin-when"><Icon n="clock" /> From {stay.checkInTime}, {dateLabel(stay.arrival)}</p>
    {g.open ? <Arrival g={stay.guide ?? null} />
      : <><p className="card g-guide g-lock"><Icon n="lock" /> {lockLine(g)}.</p><PayCard stay={stay} /></>}
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
  const p = priceOf(stay, u);
  return p == null ? '—' : `${money2(p)}${u.per === 'item' ? ' each' : ''}`;
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

/** Check-in instructions: the builder's arrival steps (photos inline, video in a new tab), then the address. */
function Arrival({ g }: { g: GuestGuide | null }) {
  const [view, setView] = useState<{ step: number; i: number } | null>(null);
  if (!g || (!g.steps?.length && !g.address)) return <div className="card g-guide"><p className="note"><Icon n="clock" /> Your check-in instructions will show here before arrival.</p></div>;
  return <div className="card g-guide">
    {g.steps && g.steps.length > 0 && <ol className="g-steps">
      {g.steps.map((st, i) => <li key={i} className="g-stepi">
        <span className="g-stepn" aria-hidden>{i + 1}</span>
        <div className="g-stepb"><b>{st.title}</b>{st.text && <p className="g-text">{st.text}</p>}
          {st.photos && st.photos.length > 0 && <span className={`g-pics n${st.photos.length}`}>
            {st.photos.map((id, j) => <button key={id} className="g-pic" onClick={() => setView({ step: i, i: j })} aria-label={`Open photo ${j + 1} of ${st.title}`}>
              <img src={checkinPhotoUrl(id)} alt={`${st.title} — photo`} loading="lazy" /></button>)}</span>}
          {(st.pin || st.link) && <span className="g-maps">
            {st.pin && <><a className="chip" href={googleDir(st.pin)} target="_blank" rel="noopener noreferrer"><Icon n="pin" /> Google Maps</a>
              <a className="chip" href={appleDir(st.pin)} target="_blank" rel="noopener noreferrer"><Icon n="pin" /> Apple Maps</a></>}
            {st.link && <a className="chip" href={st.link} target="_blank" rel="noopener noreferrer"><Icon n="eye" /> Watch video</a>}</span>}</div>
      </li>)}
    </ol>}
    {g.address && <div className="g-gi"><span className="g-k">Address</span><b>{g.address}</b>
      <a className="chip" href={mapsUrl(g.address)} target="_blank" rel="noopener noreferrer"><Icon n="pin" /> Open in Maps</a></div>}
    {view && g.steps?.[view.step]?.photos && <Lightbox title={g.steps[view.step]!.title} photos={g.steps[view.step]!.photos!} at={view.i}
      move={i => setView(v => v && { ...v, i })} close={() => setView(null)} />}
  </div>;
}

/** A step's photos full screen (owner, 2026-11-09: "the guests cannot open the photos, they are tiny"): tap to open,
 *  ‹ › or swipe between them, tap outside / ✕ / Esc to close. */
function Lightbox({ title, photos, at, move, close }: { title: string; photos: string[]; at: number; move: (i: number) => void; close: () => void }) {
  const n = photos.length;
  const go = (d: number) => move((at + d + n) % n);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  });
  return <div className="g-lightbox" role="dialog" aria-modal="true" aria-label={`${title} — photo ${at + 1} of ${n}`} onClick={close}
    onTouchStart={e => { touch.current = e.touches[0]?.clientX ?? null; }}
    onTouchEnd={e => { const x = e.changedTouches[0]?.clientX; if (touch.current != null && x != null && Math.abs(x - touch.current) > 50) go(x < touch.current ? 1 : -1); touch.current = null; }}>
    <img src={checkinPhotoUrl(photos[at]!)} alt={`${title} — photo ${at + 1}`} onClick={e => e.stopPropagation()} />
    <span className="g-lb-bar" onClick={e => e.stopPropagation()}>
      {n > 1 && <button className="chip" onClick={() => go(-1)} aria-label="Previous photo">‹</button>}
      <span>{title}{n > 1 ? ` · ${at + 1} / ${n}` : ''}</span>
      {n > 1 && <button className="chip" onClick={() => go(1)} aria-label="Next photo">›</button>}
      <button className="chip" onClick={close} aria-label="Close">✕</button>
    </span>
  </div>;
}

/**
 * House manual (Stay): blocks in the guide's order — a record part (`field`) or the house's own text. A guide with no
 * record blocks keeps the first layout: Wi-Fi, times, parking, its items, then access, rules, contact.
 */
function HouseManual({ g }: { g: GuestGuide | null }) {
  const [rules, setRules] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!g) return <div className="card g-guide"><p className="note"><Icon n="clock" /> The house manual will show here before arrival.</p></div>;
  const copy = (t: string) => { void navigator.clipboard?.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); };
  const items = g.house ?? [];
  const order: HouseItem[] = items.some(h => h.field) ? items
    : [...DEFAULT_FIELDS.map(field => ({ title: '', text: '', field })), ...items, ...DEFAULT_FIELDS_AFTER.map(field => ({ title: '', text: '', field }))];
  const block = (h: HouseItem, i: number): React.ReactNode => {
    switch (h.field) {
      case 'wifi': return g.wifi && <div key={i} className="g-gi"><span className="g-k"><Icon n="wifi" /> Wi-Fi</span><b>{g.wifi.network}</b>
        {g.wifi.password && <button className="chip g-copy" onClick={() => copy(g.wifi!.password!)} aria-label="Copy the Wi-Fi password"><span className="g-mono">{g.wifi.password}</span> {copied ? 'Copied' : 'Copy'}</button>}</div>;
      case 'times': return (g.checkIn || g.checkOut) && <div key={i} className="g-gi g-gi-row">
        {g.checkIn && <span><span className="g-k">Check-in from</span><b>{g.checkIn}</b></span>}
        {g.checkOut && <span><span className="g-k">Check-out by</span><b>{g.checkOut}</b></span>}</div>;
      case 'parking': return g.parking && <div key={i} className="g-gi"><span className="g-k">Parking</span>
        {g.parking.notes && <p className="g-text">{g.parking.notes}</p>}
        {g.parking.freeStreet && <span className="note">Free street parking</span>}
        {g.parking.coveredPerNight != null && <span className="note">Covered parking {money2(g.parking.coveredPerNight)} / night</span>}</div>;
      case 'access': return g.access && <div key={i} className="g-gi"><span className="g-k">What you can use</span><p className="g-text">{g.access}</p></div>;
      case 'rules': return g.rules && <div key={i} className="g-gi"><button className="chip" onClick={() => setRules(v => !v)} aria-expanded={rules}>House rules {rules ? '⌃' : '›'}</button>
        {rules && <p className="g-text">{g.rules}</p>}</div>;
      case 'contact': return (g.manual || g.phone) && <div key={i} className="g-gi g-links">
        {g.manual && <a className="chip" href={g.manual} target="_blank" rel="noopener noreferrer"><Icon n="book" /> Full guide</a>}
        {g.phone && <a className="chip" href={`tel:${g.phone.replace(/[^\d+]/g, '')}`}><Icon n="phone" /> {g.phone}</a>}</div>;
      default: return <div key={i} className="g-gi"><span className="g-k">{h.title}</span>{h.text && <p className="g-text">{h.text}</p>}</div>;
    }
  };
  return <div className="card g-guide">{order.map(block)}</div>;
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
  const house = useHouse();
  const stay: GuestStay = house.data ? { ...demoStay(k), unitName: house.data.unitName, address: house.data.guide?.address ?? null,
    guide: house.data.guide, prices: house.data.prices } : demoStay(k);
  return <GuestPortal key={`${k}-${house.unit}`} stay={stay} send={async () => ({ ok: true })}
    demoBar={<div className="g-demo" role="group" aria-label="Demo stay">
      <span className="note"><Icon n="eye" /> Demo</span>
      {DEMO_KEYS.map(x => <button key={x} className={x === k ? 'chip active' : 'chip'} onClick={() => pickDemo(x)}>{DEMO_LABEL[x]}</button>)}
      {house.units.length > 0 && <select className="g-house" value={house.unit} onChange={e => house.pick(e.target.value)} aria-label="House (from the Repository)">
        <option value="">Sample house</option>
        {house.units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>}
    </div>} />;
}

/**
 * The demo with a real house (2026-11-09): its guide and prices from the Repository via /api/guest-guide,
 * which answers only behind the staff sign-in — on /crew/guest-demo (no sign-in) the picker simply never shows.
 */
type HouseData = { unitName: string; guide: GuestGuide | null; prices: GuestStay['prices'] };
function useHouse() {
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [unit, setUnit] = useState(() => new URLSearchParams(location.search).get('unit') ?? '');
  const [data, setData] = useState<HouseData | null>(null);
  useEffect(() => { fetch('/api/guest-guide').then(r => r.ok ? r.json() as Promise<{ units?: { id: string; name: string }[] }> : null).then(j => j?.units && setUnits(j.units)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!unit) { setData(null); return; }
    let live = true;
    fetch(`/api/guest-guide?unit=${encodeURIComponent(unit)}`).then(r => r.ok ? r.json() as Promise<HouseData> : null).then(j => { if (live) setData(j?.unitName ? j : null); }).catch(() => undefined);
    return () => { live = false; };
  }, [unit]);
  const pick = (id: string) => { setUnit(id); const u = new URL(location.href); if (id) u.searchParams.set('unit', id); else u.searchParams.delete('unit'); history.replaceState(history.state, '', u); };
  return { units, unit, data, pick };
}

/** A real stay link (/guest/<id>.<sig>) — the API that checks the signature and reads Hostaway is not built yet. */
export function GuestLinkPage() {
  return <div className="report-page v-page g-page"><p className="banner warn">▲ This stay page is not active yet.</p></div>;
}
