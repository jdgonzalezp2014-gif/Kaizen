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
import { UPSELLS, availability, offered, choiceLine, mapsUrl, nights, priceOf, quote, ready, requestMode, upsellRequest,
  type Choice, type GuestGuide, type GuestStay, type Upsell, type UpsellRequest } from '../lib/guest-portal.ts';
import { FLOW_KEY, VS_KEY, doorCodeFor, doneFlow, entry, newFlow, progress, protectionFor, steps, type Flow, type Protection, type StepKey } from '../lib/guest-checkin.ts';
import { CheckinProgress, StepList, StepScreen } from './GuestCheckin.tsx';

type Send = (r: UpsellRequest) => Promise<{ ok: boolean; message?: string }>;
export type Sec = 'stay' | 'checkin' | 'guide' | 'extras';
const of = (i: number, n: number) => `${i} of ${n}`;

const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
function returnedFlow(): Flow | null {
  try {
    const q = new URLSearchParams(location.search);
    if (!q.get('paid') && !q.get('verified')) return null;
    const f = JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? 'null') as Flow | null;
    return f && typeof f === 'object' ? f : null;
  } catch { return null; }
}

const demoKey = () => { try { const h = new URLSearchParams(location.search).get('house'); return h ? `kaizen-demo-flow:${h}` : null; } catch { return null; } };
function savedDemoFlow(): Flow | null {
  const k = demoKey(); if (!k) return null;
  try { const f = JSON.parse(localStorage.getItem(k) ?? 'null') as Flow | null; return f && typeof f === 'object' ? f : null; } catch { return null; }
}
function saveDemoFlow(f: Flow) { const k = demoKey(); if (!k) return; try { localStorage.setItem(k, JSON.stringify(f)); } catch { /* no storage */ } }
/** "Start over" on the open demo link: forget this browser's saved check-in. */
export function resetDemoFlow() {
  const k = demoKey(); try { if (k) localStorage.removeItem(k); sessionStorage.removeItem(FLOW_KEY); sessionStorage.removeItem(VS_KEY); } catch { /* no storage */ }
  const u = new URL(location.href); for (const x of ['paid', 'verified', 'step', 'sec']) u.searchParams.delete(x); location.href = u.toString();
}

// The houses are in Texas: the release time reads in Central.
const whenLabel = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

/** `embedded`: the builder's live preview — no URL state, no page-wide theme (the preview box carries `.g-scope`). */
export function GuestPortal({ stay, send, now = new Date(), demoBar, embedded = false, startSec = 'stay' }: {
  stay: GuestStay; send: Send; now?: Date; demoBar?: React.ReactNode; embedded?: boolean; startSec?: Sec }) {
  const [sec, setSec] = useState<Sec>(startSec);
  const [pick, setPick] = useState<Upsell['kind'] | null>(null);
  const [sent, setSent] = useState<UpsellRequest[]>([]);
  const [menu, setMenu] = useState(false);
  const [flow, setFlow] = useState<Flow>(() => (!embedded && (returnedFlow() ?? savedDemoFlow())) || (stay.checkedIn ? doneFlow() : newFlow()));
  // The open demo link (?house=) keeps its check-in in this browser, so a reload or Stripe's return does not start over.
  useEffect(() => { if (!embedded) saveDemoFlow(flow); }, [flow, embedded]);
  // Back from Stripe Checkout (`?paid=cs_…`): the step is done only if Stripe says the session is complete.
  const [payNote, setPayNote] = useState<string | null>(null);
  useEffect(() => {
    if (embedded) return;
    const q = new URLSearchParams(location.search);
    const id = q.get('paid');
    if (id) fetch(`/api/report-link?checkout=${encodeURIComponent(id)}`).then(r => r.json() as Promise<{ paid?: boolean; message?: string }>).then(j => {
      if (j.paid) setFlow(f => ({ ...f, paid: true }));
      else setPayNote(j.message ?? 'The payment was not completed.');
    }).catch(() => setPayNote('Could not check the payment.'));
    // Back from Stripe Identity (`?verified=1`): the session id was kept in the tab.
    let vs: string | null = null;
    try { vs = q.get('verified') ? sessionStorage.getItem(VS_KEY) : null; } catch { /* no storage */ }
    if (vs) fetch(`/api/report-link?identity=${encodeURIComponent(vs)}`).then(r => r.json() as Promise<{ done?: boolean; message?: string }>).then(j => {
      if (j.done) { setFlow(f => ({ ...f, identity: true })); setStep(null); }
      else setPayNote(j.message ?? 'Verification was not finished.');
    }).catch(() => setPayNote('Could not check the verification.'));
  }, [embedded]);
  const [step, setStep] = useState<StepKey | null>(null);
  const prot = protectionFor(stay.unitType ?? 'house', stay.protection ?? {});
  useUrlState('step', step ?? '', v => setStep((v || null) as StepKey | null), { def: '', on: !embedded });
  useUrlState('sec', sec, setSec, { def: 'stay', valid: v => (SECS as string[]).includes(v), on: !embedded });
  useUrlState('extra', pick ?? '', v => setPick((v || null) as Upsell['kind'] | null), { def: '', on: !embedded });
  const open = UPSELLS.find(u => u.kind === pick) ?? null;
  const top = () => window.scrollTo?.({ top: 0 });
  const go = (s: Sec) => { setSec(s); setPick(null); setStep(null); setMenu(false); top(); };
  const goStep = (k: StepKey | null) => { setSec('checkin'); setPick(null); setStep(k); setMenu(false); top(); };
  const choose = (k: Upsell['kind']) => { setSec('extras'); setPick(k); top(); };
  const [theme, setTheme] = useGuestTheme(!embedded);
  useBrandFonts();
  const ck = { flow, prot, goStep };
  const g = entry(flow, stay, prot, now);

  return <>
    <header className="gx-bar">
      <button className="gx-icon-btn" onClick={() => setMenu(true)} aria-label="Menu" aria-expanded={menu} aria-haspopup="dialog"><Icon n="menu" /></button>
      <button className="gx-brand" onClick={() => go('stay')} aria-label="Your stay — home">KAIZEN</button>
      {embedded ? <span className="gx-icon-btn" aria-hidden /> : <button className="gx-icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}><Icon n={theme === 'dark' ? 'sun' : 'moon'} /></button>}
    </header>
    {menu && <Menu stay={stay} sec={sec} g={g} st={steps(flow, stay, prot)} go={go} close={() => setMenu(false)} theme={embedded ? null : theme} setTheme={setTheme} />}
    <div className="report-page v-page g-page">
      {sec === 'stay' ? <StayView stay={stay} now={now} go={go} sent={sent} choose={choose} {...ck} />
        : sec === 'checkin' ? step && steps(flow, stay, prot).some(x => x.key === step) ? <StepScreen k={step} stay={stay} flow={flow} set={setFlow} p={prot} back={() => goStep(null)} go={goStep} />
          : <CheckinView stay={stay} now={now} {...ck} />
        : sec === 'guide' ? <GuideView stay={stay} g={g} goStep={goStep} />
        : open ? <Pick stay={stay} u={open} back={() => setPick(null)}
            send={async c => { const r = upsellRequest(stay, open, c, now); const res = await send(r); if (res.ok) { setSent(s => [...s, r]); setPick(null); } return res; }} />
        : <><h2 className="v-h g-h">Make it better <ExtrasHint /></h2><Extras stay={stay} sent={sent} choose={setPick} /></>}
      {demoBar}
      {payNote && <p className="banner warn">▲ {payNote}</p>}
    </div>
  </>;
}

const SECS: Sec[] = ['stay', 'checkin', 'guide', 'extras'];
const THEME_KEY = 'kaizen-guest-theme';
type Theme = 'light' | 'dark';

/**
 * Light or dark (owner's boss, 2026-11-15: "white and black, gold as the focus — like Airbnb, but Apple"). Follows the
 * phone until the guest picks one; the pick stays in this browser. Applied to the whole document while the guest page
 * is open, without touching the staff's saved day/night choice. The builder's preview (`embedded`) stays dark.
 */
function useGuestTheme(on = true): [Theme, (t: Theme) => void] {
  const sys = (): Theme => { try { return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return 'dark'; } };
  const [picked, setPicked] = useState<Theme | null>(() => { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } });
  const [auto, setAuto] = useState<Theme>(sys);
  useEffect(() => {
    if (!on || picked) return;
    try { const m = matchMedia('(prefers-color-scheme: light)'); const f = () => setAuto(sys()); m.addEventListener('change', f); return () => m.removeEventListener('change', f); } catch { return; }
  }, [on, picked]);
  const theme = picked ?? auto;
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const was = root.getAttribute('data-theme');
    root.classList.add('guest-brand');
    root.setAttribute('data-theme', theme);
    return () => { root.classList.remove('guest-brand'); if (was) root.setAttribute('data-theme', was); };
  }, [on, theme]);
  return [theme, (t: Theme) => { setPicked(t); try { localStorage.setItem(THEME_KEY, t); } catch { /* no storage */ } }];
}

/** Apple's own type on Apple devices (SF, the system font); Inter — its closest open cousin — everywhere else. */
function useBrandFonts() {
  useEffect(() => {
    if (document.getElementById('kz-guest-fonts')) return;
    const l = document.createElement('link');
    l.id = 'kz-guest-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(l);
  }, []);
}

/**
 * The one menu (☰, top left — owner, 2026-11-15): every part of the stay in one list, the locked ones say so.
 * A sheet from the left; tap outside, ✕ or Esc closes it.
 */
function Menu({ stay, sec, g, st, go, close, theme, setTheme }: { stay: GuestStay; sec: Sec; g: Entry; st: ReturnType<typeof steps>;
  go: (s: Sec) => void; close: () => void; theme: Theme | null; setTheme: (t: Theme) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [close]);
  const p = progress(st); // required steps — the same count as the home's ring
  const phone = stay.guide?.phone;
  const item = (s: Sec, icon: string, label: string, side?: React.ReactNode) =>
    <li><button className={`gx-mi${sec === s ? ' on' : ''}`} onClick={() => go(s)} aria-current={sec === s ? 'page' : undefined}>
      <span className="gx-mi-icon"><Icon n={icon} /></span><span className="gx-mi-label">{label}</span>{side}</button></li>;
  const locked = !g.open && <span className="gx-mi-side"><Icon n="lock" /> Locked</span>;
  return <div className="gx-scrim" onClick={close}>
    <nav className="gx-sheet" role="dialog" aria-modal="true" aria-label="Menu" onClick={e => e.stopPropagation()}>
      <div className="gx-sheet-top">
        <button ref={first} className="gx-icon-btn" onClick={close} aria-label="Close menu">✕</button>
      </div>
      <div className="gx-who">
        <b>Hi, {stay.guestFirst}</b>
        <span className="note">{ic(stay.unitName)} · {shortDay(stay.arrival)} – {shortDay(stay.departure)}</span>
      </div>
      <ul className="gx-menu">
        {item('stay', 'home', 'Your stay')}
        {item('checkin', 'key', 'Check-in & door code', <span className={`gx-mi-side${p.done >= p.of ? ' ok' : ''}`}>{p.done >= p.of ? <><Icon n="check" /> Done</> : `${p.done} of ${p.of}`}</span>)}
        {item('guide', 'wifi', 'Wi-Fi & house guide', locked)}
        {item('extras', 'sparkles', 'Make it better')}
        {phone && <li><a className="gx-mi" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><span className="gx-mi-icon"><Icon n="phone" /></span><span className="gx-mi-label">Call us</span><span className="gx-mi-side">{phone}</span></a></li>}
      </ul>
      {theme && <div className="gx-appear">
        <span className="note">Appearance</span>
        <span className="ci-seg" role="radiogroup" aria-label="Appearance">
          {(['light', 'dark'] as Theme[]).map(t => <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
            <Icon n={t === 'light' ? 'sun' : 'moon'} /> {t === 'light' ? 'Light' : 'Dark'}</button>)}
        </span>
      </div>}
      <a className="gx-site" href="https://kaizenguestproperties.com" target="_blank" rel="noopener noreferrer">Kaizen Guest Properties ↗</a>
    </nav>
  </div>;
}

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

type Ck = { flow: Flow; prot: Protection; goStep: (k: StepKey | null) => void };
type Entry = ReturnType<typeof entry>;
const lockLine = (g: Entry) => g.open ? '' : g.why === 'steps' ? 'Opens when you finish check-in' : g.at ? `Opens ${whenLabel(g.at)}` : 'Opens before arrival';

/**
 * Stay — the home (2026-11-15 redesign, Airbnb's trip page in Apple's manners): the house and dates, the check-in
 * progress, four tiles for what the stay unlocks (shown, but blocked until check-in is done), then the extras carousel.
 */
function StayView({ stay, now, go, sent, choose, flow, prot, goStep }: { stay: GuestStay; now: Date; go: (s: Sec) => void;
  sent: UpsellRequest[]; choose: (k: Upsell['kind']) => void } & Ck) {
  const n = nights(stay);
  const g = entry(flow, stay, prot, now);
  const st = steps(flow, stay, prot);
  const guide = stay.guide ?? null;
  const unlock = () => !g.open && g.why === 'steps' ? goStep(null) : go('checkin');
  const tile = (icon: string, title: string, value: React.ReactNode, onOpen: () => void) =>
    <button className={`card gx-tile${g.open ? '' : ' locked'}`} onClick={g.open ? onOpen : unlock} aria-label={g.open ? title : `${title} — ${lockLine(g)}`}>
      <span className="gx-tile-icon" aria-hidden><Icon n={icon} /></span>
      <b>{title}</b>
      {g.open ? <span className="gx-tile-v">{value}</span>
        : <span className="gx-tile-v gx-veil" aria-hidden><i /><Icon n="lock" /></span>}
    </button>;
  return <>
    <section className="gx-hero">
      <div className="g-photo" style={stay.photo ? { backgroundImage: `url(${stay.photo})` } : undefined}>
        {!stay.photo && <span className="g-photo-mark" aria-hidden><Icon n="home" /></span>}
      </div>
      <h1 className="gx-title">{ic(stay.unitName)}</h1>
      <p className="gx-sub"><Icon n="bed" /> {n} {n === 1 ? 'night' : 'nights'} · <Icon n="users" /> {stay.guests} {stay.guests === 1 ? 'guest' : 'guests'}
        {stay.address && <> · <a href={mapsUrl(stay.address)} target="_blank" rel="noreferrer">Map</a></>}</p>
      <div className="card gx-dates">
        <div><span className="gx-k">Check-in</span><b>{dateLabel(stay.arrival)}</b><span className="note">{stay.checkInTime}</span></div>
        <div><span className="gx-k">Checkout</span><b>{dateLabel(stay.departure)}</b><span className="note">{stay.checkOutTime}</span></div>
      </div>
    </section>

    {st.some(x => !x.done) && <CheckinProgress st={st} go={goStep} />}

    <h2 className="v-h g-h">Your stay {!g.open && <span className="gx-h-lock"><Icon n="lock" /> {lockLine(g)}</span>}</h2>
    <div className="gx-tiles">
      {tile('key', 'Door code', stay.doorCode ? <span className="g-mono">{stay.doorCode}</span> : 'Arrival steps', () => go('checkin'))}
      {tile('wifi', 'Wi-Fi', guide?.wifi?.network ?? 'House guide', () => go('guide'))}
      {tile('pin', 'Directions', guide?.steps?.length ? `${guide.steps.length} steps with photos` : 'Address & map', () => go('checkin'))}
      {tile('book', 'House guide', 'Rules, parking, contact', () => go('guide'))}
    </div>

    <h2 className="v-h g-h">Make it better <ExtrasHint /></h2>
    <Extras stay={stay} sent={sent} choose={choose} />
  </>;
}

const ExtrasHint = () => <Hint>Pick an extra and send the request. We confirm it first, then charge the card you used at check-in. Nothing is charged when you ask. Extra nights follow the house's live calendar.</Hint>;

/** What check-in unlocks, shown but blocked (owner, 2026-11-15: "reading it and showing a block"): blurred lines + why. */
function Locked({ g, goStep, title, icon, lines = 4 }: { g: Entry; goStep: (k: StepKey | null) => void; title: string; icon: string; lines?: number }) {
  return <section className="card gx-locked" aria-label={`${title} — ${lockLine(g)}`}>
    <span className="gx-locked-head"><span className="gx-tile-icon" aria-hidden><Icon n={icon} /></span><b>{title}</b></span>
    <span className="gx-blur" aria-hidden>{Array.from({ length: lines }, (_, i) => <i key={i} style={{ width: `${92 - (i % 3) * 17}%` }} />)}</span>
    <span className="gx-lock-over">
      <span className="gx-lock-badge"><Icon n="lock" /> {lockLine(g)}</span>
      {!g.open && g.why === 'steps' && <button className="g-cta gx-cta-sm" onClick={() => goStep(null)}>Finish check-in</button>}
    </span>
  </section>;
}

/** Check-in: the online check-in steps, then — once done and released — the door code and the arrival steps. */
function CheckinView({ stay, now, flow, prot, goStep }: { stay: GuestStay; now: Date } & Ck) {
  const g = entry(flow, stay, prot, now);
  const st = steps(flow, stay, prot);
  return <>
    <h2 className="v-h g-h">Check-in</h2>
    <p className="g-meta g-checkin-when"><Icon n="clock" /> From {stay.checkInTime}, {dateLabel(stay.arrival)}</p>
    {g.open ? <><DoorCode stay={stay} /><Arrival g={stay.guide ?? null} /></>
      : <>{g.why === 'steps' && <><CheckinProgress st={st} go={goStep} /><StepList st={st} go={goStep} /></>}
        {g.why !== 'steps' && <p className="card g-guide g-lock ci-done"><Icon n="done" /> You are checked in.</p>}
        <Locked g={g} goStep={goStep} title="Door code & arrival steps" icon="key" lines={5} /></>}
  </>;
}

/** House guide & Wi-Fi: the manual, or its blocked preview until check-in opens it. */
function GuideView({ stay, g, goStep }: { stay: GuestStay; g: Entry; goStep: (k: StepKey | null) => void }) {
  return <>
    <h2 className="v-h g-h">House guide</h2>
    {g.open ? <HouseManual g={stay.guide ?? null} /> : <Locked g={g} goStep={goStep} title="Wi-Fi, parking, rules & contact" icon="wifi" lines={6} />}
  </>;
}

/** The door code, big and copyable — the thing check-in unlocks. None set → say who sends it. */
function DoorCode({ stay }: { stay: GuestStay }) {
  const [copied, setCopied] = useState(false);
  const code = stay.doorCode;
  // Hostaway sets a code per reservation only where its smart-lock link runs; lockbox / fob houses have none —
  // their way in is in the arrival steps ({lockbox} from the record).
  if (!code) return stay.guide?.steps?.length ? null : <p className="card g-guide g-lock"><Icon n="key" /> Your door code arrives by message before check-in.</p>;
  const copy = () => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); };
  return <section className="card ci-code">
    <span className="ci-eyebrow"><Icon n="key" /> Your door code</span>
    <button className="ci-digits" onClick={copy} aria-label={`Door code ${code.split('').join(' ')} — copy`}>{code.split('').map((d, i) => <span key={i}>{d}</span>)}</button>
    <span className="note">Works from {stay.checkInTime}, {dateLabel(stay.arrival)} · {copied ? 'Copied' : 'Tap to copy'}</span>
  </section>;
}

function priceLabel(stay: GuestStay, u: Upsell) {
  if (u.kind === 'extra-nights') return stay.nightly != null ? `${money2(stay.nightly)} / night` : '—';
  const p = priceOf(stay, u);
  return p == null ? '—' : `${money2(p)}${u.per === 'item' ? ' each' : u.per === 'hour' ? ' / hour' : ''}`;
}

function Extras({ stay, sent, choose }: { stay: GuestStay; sent: UpsellRequest[]; choose: (k: Upsell['kind']) => void }) {
  const NO = { calendar: 'Not available for your dates', price: 'Ask us for a price', short: 'For stays of 4+ nights' } as const;
  return <>
    <Carousel label="Extras" of={of}>{offered(stay).map(u => {
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
        <span className="g-req-r">{r.quote != null && <b>{money2(r.quote)}</b>}{r.mode === 'auto' ? <span className="g-pill ok"><Icon n="check" /> Confirmed</span> : <span className="g-pill">○ Waiting for our OK</span>}</span>
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
    <div className="v-house-head"><button className="chip" onClick={back}>‹ Make it better</button></div>
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
      {u.per === 'hour' && !(a.ok && a.flag === 'turnover') && (requestMode(stay, u, new Date()).mode === 'auto'
        ? <p className="ci-mode ok"><Icon n="check" /> Confirmed right away <Hint>Asked by 8 PM (Texas time) the day before: it is yours as soon as you send it.</Hint></p>
        : <p className="ci-mode">Needs our OK — asked after 8 PM the day before <Hint>We check the cleaning plan and answer quickly. Nothing is charged unless we confirm.</Hint></p>)}
      <div className="g-total"><span>Total</span><b>{total != null ? money2(total) : '—'}</b></div>
      <button className="g-cta" disabled={!ok || busy} onClick={() => void submit()}>{busy ? 'Sending…' : u.per === 'hour' && requestMode(stay, u, new Date()).mode === 'auto' ? 'Book it' : 'Request'}</button>
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
export type DemoKey = 'unpaid' | 'paid' | 'airbnb';
export const DEMO_KEYS: DemoKey[] = ['unpaid', 'paid', 'airbnb'];
const DEMO_LABEL: Record<DemoKey, string> = { unpaid: 'New stay', paid: 'Checked in', airbnb: 'Airbnb' };

export function demoStay(k: DemoKey): GuestStay {
  const base: GuestStay = {
    id: `demo-${k}`, guestFirst: 'Sarah', unitName: 'Frisco Legacy · 1BR', address: null,
    // A real listing's cover from Hostaway (366041) — the demo shows what the photo does; real houses read their own.
    photo: 'https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/144914-366041-Pqfp---C0--1kIUrqqkFbgMAJKWF5fzsoONnBYRDEDlUk-67c24f54305ee',
    arrival: iso(plus(0)), departure: iso(plus(5)), checkInTime: '4:00 PM', checkOutTime: '11:00 AM', guests: 3,
    channel: 'direct', total: 0, paid: 0, nightly: 189, freeBefore: 0, freeAfter: 2, turnIn: true, turnOut: false,
    // Released already: finishing check-in in the demo opens the door code right away.
    guideReleaseAt: `${iso(plus(-1))}T17:00:00Z`, pay: { provider: 'none', url: null },
    guest: { name: 'Sarah Mitchell', email: 'sarah.m@example.com', phone: '+1 (214) 555-0148', adults: 2, children: 1, infants: 0, pets: 0 },
    maxGuests: 4, unitType: 'apartment', doorCode: '4821',
    // A sample guide so the demo shows what check-in unlocks (a real house comes from the Repository).
    guide: { address: '7200 Dallas Pkwy, Frisco, TX 75034', wifi: { network: 'Kaizen-Legacy', password: 'stay-well-48' },
      checkIn: '4 PM', checkOut: '11 AM', parking: { notes: 'Free garage parking for one car — any spot without a number.', freeStreet: false, coveredPerNight: null },
      access: 'The whole apartment, the pool and the fitness room.', manual: null, rules: null, phone: '+1 (469) 555-0110',
      steps: [
        { title: 'Park in the garage', text: 'Enter from Dallas Pkwy. Any spot without a number is free for guests.', pin: null },
        { title: 'Your door keypad', text: 'Take the elevator to the 3rd floor. Touch the keypad, enter your door code and press the lock key.', pin: null },
        { title: 'Make yourself at home', text: 'Wi-Fi and the house manual are on the Stay tab. Message us anytime.', pin: null },
      ] },
  };
  if (k === 'paid') return { ...base, checkedIn: true };
  if (k === 'airbnb') return { ...base, channel: 'airbnb', guest: { ...base.guest!, email: null } };
  return base;
}

/** /guest/demo and /crew/guest-demo: one page, a strip to switch the demo stay. Nothing is sent. */
export function GuestDemoPage() {
  const q = new URLSearchParams(location.search).get('stay');
  const [k, setK] = useState<DemoKey>(DEMO_KEYS.includes(q as DemoKey) ? q as DemoKey : 'unpaid');
  const pickDemo = (x: DemoKey) => { setK(x); const u = new URL(location.href); u.searchParams.set('stay', x); history.replaceState(history.state, '', u); };
  const house = useHouse(demoStay(k));
  // Demo: a picked house's code follows its Lock type; the sample 4821 stands in for Hostaway's per-stay code unless the record has its own.
  const stay: GuestStay = house.data ? { ...demoStay(k), doorCode: doorCodeFor(house.data.lockType, house.data.guestCode, house.data.guestCode ? null : '4821'), unitName: house.data.unitName, photo: house.data.photo ?? null, unitType: house.data.unitType ?? 'house', protection: house.data.protection ?? null, address: house.data.guide?.address ?? null,
    guide: house.data.guide, prices: house.data.prices, notOffered: house.data.notOffered ?? [], ...(house.data.calendar ?? {}) } : demoStay(k);
  return <GuestPortal key={`${k}-${house.unit}`} stay={stay} send={async () => ({ ok: true })}
    demoBar={<div className="g-demo" role="group" aria-label="Demo stay">
      <span className="note"><Icon n="eye" /> Demo</span>
      {house.signed ? <button className="chip" onClick={resetDemoFlow}>Start over</button>
        : DEMO_KEYS.map(x => <button key={x} className={x === k ? 'chip active' : 'chip'} onClick={() => pickDemo(x)}>{DEMO_LABEL[x]}</button>)}
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
type HouseData = { unitName: string; notOffered?: GuestStay['notOffered']; photo?: string | null; lockType?: string | null; guestCode?: string | null; unitType?: GuestStay['unitType'] | null; protection?: GuestStay['protection']; guide: GuestGuide | null; prices: GuestStay['prices'];
  calendar?: Pick<GuestStay, 'freeBefore' | 'freeAfter' | 'turnIn' | 'turnOut'> | null };
function useHouse(dates: { arrival: string; departure: string }) {
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [unit, setUnit] = useState(() => new URLSearchParams(location.search).get('unit') ?? '');
  const [data, setData] = useState<HouseData | null>(null);
  useEffect(() => { fetch('/api/guest-guide').then(r => r.ok ? r.json() as Promise<{ units?: { id: string; name: string }[] }> : null).then(j => j?.units && setUnits(j.units)).catch(() => undefined); }, []);
  useEffect(() => {
    // An open signed link (?house=<token>, guest-demo.ts) loads its one unit without sign-in.
    const signed = new URLSearchParams(location.search).get('house');
    if (!unit && !signed) { setData(null); return; }
    let live = true;
    // The stay's dates ask Hostaway's live calendar what extra nights are free around them.
    const d = `&arrival=${dates.arrival}&departure=${dates.departure}`;
    fetch(signed ? `/api/report-link?house=${encodeURIComponent(signed)}${d}` : `/api/guest-guide?unit=${encodeURIComponent(unit)}${d}`).then(r => r.ok ? r.json() as Promise<HouseData> : null).then(j => { if (live) setData(j?.unitName ? j : null); }).catch(() => undefined);
    return () => { live = false; };
  }, [unit, dates.arrival, dates.departure]);
  const pick = (id: string) => { setUnit(id); const u = new URL(location.href); if (id) u.searchParams.set('unit', id); else u.searchParams.delete('unit'); history.replaceState(history.state, '', u); };
  return { units, unit, data, pick, signed: new URLSearchParams(location.search).has('house') };
}

/** A real stay link (/guest/<id>.<sig>) — the API that checks the signature and reads Hostaway is not built yet. */
export function GuestLinkPage() {
  return <div className="report-page v-page g-page"><p className="banner warn">▲ This stay page is not active yet.</p></div>;
}
