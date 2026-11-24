/**
 * The guest's page (guests module, 2026-11-05): their stay, what is due, the check-in instructions, extras.
 * Same look as the handyman's page by house (Work.tsx): the island on top, a carousel of cards, a card opens
 * into its detail. Owner: premium because it sells, simple enough for anyone — no explaining text on screen.
 * Demo data only: nothing is charged, nothing goes to Hostaway; `send` is the seam for the API.
 */
import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import { Carousel } from './Work.tsx';
import { DEFAULT_FIELDS, DEFAULT_FIELDS_AFTER, appleDir, googleDir, type HouseItem } from '../lib/checkin.ts';
import { checkinPhotoUrl } from '../api.ts';
import { Icon, ic } from '../components/Icon.tsx';
import { timeOfHour } from '../lib/stay-time.ts';
import { Hint } from '../components/Hint.tsx';
import { useUrlState } from '../components/useUrlState.ts';
import { money2 } from '../lib/format.ts';
import { UPSELLS, availability, guestLink, stayToken, extendStay, offered, choiceLine, mapsUrl, nights, priceOf, quote, ready, paidExtra, timeOptions, needsApproval, APPROVAL_NOTE,
  type Choice, type GuestGuide, type GuestStay, type Upsell, type UpsellKind, type PaidExtra } from '../lib/guest-portal.ts';
import { FLOW_KEY, VS_KEY, channelCovers, doorCodeFor, doneFlow, entry, newFlow, progress, protectionFor, steps, type Flow, type Protection, type StepKey } from '../lib/guest-checkin.ts';
import { AirbnbPay, CheckinProgress, Island, PaidIsland, SecTop, StepIsland, StepScreen, StripePay, type IslandItem } from './GuestCheckin.tsx';

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
export function GuestPortal({ stay: booked, now = new Date(), demoBar, topBar, due, embedded = false, startSec = 'stay', remote }: {
  stay: GuestStay; now?: Date; demoBar?: React.ReactNode; topBar?: React.ReactNode; due?: Due; embedded?: boolean; startSec?: Sec;
  /** The real stay link (Phase 2): the check-in as the server keeps it, and where each change is saved. */
  remote?: { flow: Flow; save: (f: Flow) => void } }) {
  const [sec, setSec] = useState<Sec>(startSec);
  const [pick, setPick] = useState<Upsell['kind'] | null>(null);
  // What the guest bought on this visit (paid on the spot; the real link will read them back from guest_payments).
  const [sent, setSent] = useState<PaidExtra[]>([]);
  const [menu, setMenu] = useState(false);
  const [flow, setFlow] = useState<Flow>(() => remote ? { ...remote.flow, ...(returnedFlow() ?? {}), identity: remote.flow.identity, paid: remote.flow.paid }
    : (!embedded && (returnedFlow() ?? savedDemoFlow())) || (booked.checkedIn ? doneFlow() : newFlow()));
  // The real link saves every change (a short pause first, so a fast tapper sends one save).
  const first = useRef(true);
  useEffect(() => {
    if (!remote) return;
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => remote.save(flow), 350);
    return () => clearTimeout(t);
  }, [flow]); // eslint-disable-line react-hooks/exhaustive-deps
  // The server confirmed the ID check or the payment (Stripe): the page follows it.
  useEffect(() => {
    if (remote && (remote.flow.identity !== flow.identity || remote.flow.paid !== flow.paid) && (remote.flow.identity || remote.flow.paid))
      setFlow(f => ({ ...f, identity: f.identity || remote.flow.identity, paid: f.paid || remote.flow.paid, paidTotal: f.paidTotal ?? remote.flow.paidTotal }));
  }, [remote?.flow.identity, remote?.flow.paid]); // eslint-disable-line react-hooks/exhaustive-deps
  // A paid extension moves the stay's dates (and what is still free around them) everywhere on the page.
  const stay = extendStay(booked, flow.extended);
  // The open demo link (?house=) keeps its check-in in this browser, so a reload or Stripe's return does not start over.
  useEffect(() => { if (!embedded && !remote) saveDemoFlow(flow); }, [flow, embedded]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from Stripe Checkout (`?paid=cs_…`): the step is done only if Stripe says the session is complete.
  const [payNote, setPayNote] = useState<string | null>(null);
  useEffect(() => {
    if (embedded) return;
    const q = new URLSearchParams(location.search);
    const id = q.get('paid');
    const st = stayToken() ? `&stay=${encodeURIComponent(stayToken()!)}` : q.get('house') ? `&house=${encodeURIComponent(q.get('house')!)}` : '';
    if (id) fetch(`/api/report-link?checkout=${encodeURIComponent(id)}${st}`).then(r => r.json() as Promise<{ paid?: boolean; total?: number; message?: string }>).then(j => {
      if (j.paid) setFlow(f => ({ ...f, paid: true, paidTotal: j.total ?? null }));
      else setPayNote(j.message ?? 'The payment was not completed.');
    }).catch(() => setPayNote('Could not check the payment.'));
    // Back from Stripe Identity (`?verified=1`): the session id was kept in the tab.
    let vs: string | null = null;
    try { vs = q.get('verified') ? sessionStorage.getItem(VS_KEY) : null; } catch { /* no storage */ }
    if (vs) fetch(`/api/report-link?identity=${encodeURIComponent(vs)}${st}`).then(r => r.json() as Promise<{ done?: boolean; message?: string }>).then(j => {
      if (j.done) { setFlow(f => ({ ...f, identity: true })); setStep(null); }
      else setPayNote(j.message ?? 'Verification was not finished.');
    }).catch(() => setPayNote('Could not check the verification.'));
  }, [embedded]);
  const [step, setStep] = useState<StepKey | null>(null);
  const prot = protectionFor(stay.unitType ?? 'house', stay.protection ?? {}, nights(stay));
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
      {topBar}
      {sec === 'stay' ? <StayView stay={stay} now={now} go={go} sent={sent} choose={choose} due={due} {...ck} />
        : sec === 'checkin' ? step && steps(flow, stay, prot).some(x => x.key === step) ? <StepScreen k={step} stay={stay} flow={flow} set={setFlow} p={prot} back={() => goStep(null)} go={goStep} />
          : <CheckinView stay={stay} now={now} go={go} {...ck} />
        : sec === 'guide' ? <GuideView stay={stay} g={g} goStep={goStep} go={go} />
        : open ? <><ExtrasTop stay={stay} at={open.kind} back={() => setPick(null)} pick={setPick} />
          <Pick stay={stay} u={open} extend={x => setFlow(f => ({ ...f, extended: { before: (f.extended?.before ?? 0) + (x.before ?? 0), after: (f.extended?.after ?? 0) + (x.after ?? 0) } }))}
            paid={c => setSent(s => [...s, paidExtra(stay, open, c, now)])} /></>
        : <><ExtrasTop stay={stay} at={null} back={() => go('stay')} pick={setPick} />
          <h2 className="v-h g-h">Make it better <ExtrasHint /></h2><Extras stay={stay} sent={sent} choose={setPick} /></>}
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
    // Phones' forced dark ignores CSS alone in some browsers; the meta says the page already handles both.
    const meta = (name: string, content: string) => {
      let m = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!m) { m = document.createElement('meta'); m.name = name; document.head.appendChild(m); }
      m.content = content; return m;
    };
    const cs = meta('color-scheme', theme === 'light' ? 'only light' : 'dark');
    const tc = meta('theme-color', theme === 'light' ? '#ffffff' : '#000000');
    return () => { root.classList.remove('guest-brand'); cs.remove(); tc.remove(); if (was) root.setAttribute('data-theme', was); };
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
const lockLine = (g: Entry) => g.open ? '' : g.why === 'steps' ? 'After check-in' : g.at ? `Opens ${whenLabel(g.at)}` : 'Before arrival';

/**
 * Stay — the home (2026-11-15 redesign, Airbnb's trip page in Apple's manners): the house and dates, the check-in
 * progress, four tiles for what the stay unlocks (shown, but blocked until check-in is done), then the extras carousel.
 */
function StayView({ stay, now, go, sent, choose, due, flow, prot, goStep }: { stay: GuestStay; now: Date; go: (s: Sec) => void;
  sent: PaidExtra[]; choose: (k: Upsell['kind']) => void; due?: Due } & Ck) {
  const n = nights(stay);
  const g = entry(flow, stay, prot, now);
  const st = steps(flow, stay, prot);
  const guide = stay.guide ?? null;
  const phone = guide?.phone ?? null;
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
        {(stay.guest?.pets ?? 0) > 0 && <> · <Icon n="paw" /> {stay.guest!.pets} {stay.guest!.pets === 1 ? 'pet' : 'pets'}</>}
        {stay.address && <> · <a href={mapsUrl(stay.address)} target="_blank" rel="noreferrer">Map</a></>}</p>
      <Reservation stay={stay} choose={choose} due={due} />
    </section>

    {st.some(x => !x.done) && <CheckinProgress st={st} go={goStep} list />}

    <h2 className="v-h g-h">Your stay {!g.open && <span className="gx-h-lock"><Icon n="lock" /> {lockLine(g)}</span>}</h2>
    <div className="gx-tiles">
      {tile('key', 'Door code & access', stay.doorCode ? <span className="g-mono">{stay.doorCode}</span> : 'Arrival steps', () => go('checkin'))}
      {tile('wifi', 'Wi-Fi', guide?.wifi?.network ?? 'House guide', () => go('guide'))}
      {phone ? <a className="card gx-tile" href={`tel:${phone.replace(/[^\d+]/g, '')}`} aria-label={`Call us — ${phone}`}>
        <span className="gx-tile-icon" aria-hidden><Icon n="phone" /></span><b>Contact</b><span className="gx-tile-v">{phone}</span></a>
        : tile('phone', 'Contact', 'From your host', () => go('guide'))}
      {tile('book', 'House guide', 'Rules, parking, contact', () => go('guide'))}
    </div>

    <h2 className="v-h g-h">Make it better <ExtrasHint /></h2>
    <Extras stay={stay} sent={sent} choose={choose} />
  </>;
}

/**
 * The reservation box, drawn like Airbnb's booking card (boss, 2026-11-16: "the borders, like when you book on Airbnb"):
 * one outlined box, check-in | checkout, a thin "Extend stay" strip under. Each date offers its change ("suggest the change") when the house
 * offers it and the calendar allows: earlier arrival, later checkout, more nights — each opens that extra.
 */
/** An hour waiting on a payment (owner, 2026-11-23): "!" beside that date until it is paid; it opens the pending payments. */
export type Due = { checkin?: string | null; checkout?: string | null; open: () => void };

function Reservation({ stay, choose, due }: { stay: GuestStay; choose: (k: Upsell['kind']) => void; due?: Due }) {
  const may = (k: Upsell['kind']) => { const u = offered(stay).find(x => x.kind === k); return !!u && availability(stay, u).ok; };
  const cell = (label: string, day: string, time: string, k: Upsell['kind'], ask: string, wait?: string | null) => {
    if (wait && due) return <div className="gx-cell"><span className="gx-k">{label}</span><b>{dateLabel(day)}</b><span className="note">{time}</span>
      <button type="button" className="gx-due-pill" onClick={due.open} aria-label={`${wait} — pending payment, pay to confirm`}>
        <span className="gx-due-bang" aria-hidden>!</span>Pay for {wait}</button></div>;
    const inner = <><span className="gx-k">{label}</span><b>{dateLabel(day)}</b><span className="note">{time}</span>
      {may(k) && <span className="gx-ask">{ask} ›</span>}</>;
    return may(k) ? <button className="gx-cell" onClick={() => choose(k)}>{inner}</button> : <div className="gx-cell">{inner}</div>;
  };
  return <div className="gx-resv">
    <div className="gx-resv-row">
      {cell('Check-in', stay.arrival, stay.checkInTime, 'early-checkin', 'Arrive earlier', due?.checkin)}
      {cell('Checkout', stay.departure, stay.checkOutTime, 'late-checkout', 'Leave later', due?.checkout)}
    </div>
    {may('extra-nights') && <button className="gx-extend" onClick={() => choose('extra-nights')}><Icon n="calendar" /> Extend stay <span aria-hidden>›</span></button>}
  </div>;
}

const XSHORT: Record<UpsellKind, string> = { 'extra-nights': 'Nights', 'early-checkin': 'Early in', 'late-checkout': 'Late out', 'mid-clean': 'Clean',
  pet: 'Pet', crib: 'Crib', welcome: 'Welcome', parking: 'Parking' };
/** Make it better's island: all extras, then each one — the same back + island as check-in and the guide. */
function ExtrasTop({ stay, at, back, pick }: { stay: GuestStay; at: UpsellKind | null; back: () => void; pick: (k: UpsellKind | null) => void }) {
  const items: IslandItem[] = [{ key: 'all', icon: 'sparkles', label: 'Extras' },
    ...offered(stay).map(u => ({ key: u.kind, icon: u.icon, label: XSHORT[u.kind], locked: !availability(stay, u).ok }))];
  return <SecTop back={back}><Island label="Extras" items={items} at={at ?? 'all'} pick={k => pick(k === 'all' ? null : k as UpsellKind)} /></SecTop>;
}

const ExtrasHint = () => <Hint>Pick an extra and pay for it right here — it is confirmed as soon as the payment goes through. Only what the house can give is offered: extra nights follow its live calendar, and on a day another guest leaves or arrives, an early check-in or late check-out leaves time for the clean and is asked a day ahead.</Hint>;

/** What check-in unlocks, shown but blocked (owner, 2026-11-15: "reading it and showing a block"): blurred lines + why. */
function Locked({ g, goStep, title, icon, lines = 4 }: { g: Entry; goStep: (k: StepKey | null) => void; title: string; icon: string; lines?: number }) {
  return <section className="card gx-locked" aria-label={`${title} — ${lockLine(g)}`}>
    <span className="gx-locked-head"><span className="gx-tile-icon" aria-hidden><Icon n={icon} /></span><b>{title}</b></span>
    <span className="gx-blur" aria-hidden>{Array.from({ length: lines }, (_, i) => <i key={i} style={{ width: `${92 - (i % 3) * 17}%` }} />)}</span>
    <span className="gx-lock-over">
      <span className="gx-lock-badge"><Icon n="lock" /> {lockLine(g)}</span>
      {!g.open && g.why === 'steps' && <button className="g-cta gx-cta-sm" onClick={() => goStep(null)}>Check in</button>}
    </span>
  </section>;
}

/** Check-in: the online check-in steps, then — once done and released — the door code and the arrival steps. */
function CheckinView({ stay, now, go, flow, prot, goStep }: { stay: GuestStay; now: Date; go: (s: Sec) => void } & Ck) {
  const g = entry(flow, stay, prot, now);
  const st = steps(flow, stay, prot);
  return <>
    <SecTop back={() => go('stay')}>{flow.paid || g.open ? <PaidIsland label="Checked in" /> : <StepIsland st={st} at={null} go={goStep} />}</SecTop>
    {g.open ? <><DoorCode stay={stay} /><Arrival g={stay.guide ?? null} /></>
      : <>{g.why === 'steps' && <CheckinProgress st={st} go={goStep} list />}
        {g.why !== 'steps' && <p className="card g-guide g-lock ci-done"><Icon n="done" /> You are checked in.</p>}
        <Locked g={g} goStep={goStep} title="Door code & arrival steps" icon="key" lines={5} /></>}
  </>;
}

/** House guide & Wi-Fi: the manual, or its blocked preview until check-in opens it. */
function GuideView({ stay, g, goStep, go }: { stay: GuestStay; g: Entry; goStep: (k: StepKey | null) => void; go: (s: Sec) => void }) {
  // The island lists the guide's parts as they render (data-gk on each block); scrolling moves the open one.
  const [items, setItems] = useState<IslandItem[]>([]);
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    if (!g.open) return;
    const els = [...document.querySelectorAll<HTMLElement>('.g-guide [data-gk]')];
    setItems(els.map(e => ({ key: e.dataset.gk!, icon: e.dataset.icon ?? 'note', label: e.dataset.label ?? '' })));
    setAt(els[0]?.dataset.gk ?? null);
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(es => { const v = es.find(e => e.isIntersecting); if (v) setAt((v.target as HTMLElement).dataset.gk ?? null); },
      { rootMargin: '-35% 0px -55% 0px' });
    els.forEach(e => io.observe(e)); return () => io.disconnect();
  }, [g.open]);
  const jump = (k: string) => { setAt(k); document.querySelector(`.g-guide [data-gk="${k}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  return <>
    <SecTop back={() => go('stay')}>{g.open && items.length ? <Island label="House guide" items={items} at={at} pick={jump} />
      : <Island label="House guide" at="lock" pick={() => undefined} items={[{ key: 'lock', icon: 'lock', label: lockLine(g) || 'House guide' }]} />}</SecTop>
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
  if (u.kind === 'extra-nights') {
    const hp = stay.nightPrices ? [...stay.nightPrices.before, ...stay.nightPrices.after] : [];
    return hp.length ? `from ${money2(Math.min(...hp))} / night` : stay.nightly != null ? `${money2(stay.nightly)} / night` : '—';
  }
  const p = priceOf(stay, u);
  return p == null ? '—' : `${money2(p)}${u.per === 'item' ? ' each' : u.per === 'hour' ? ' / hour' : u.per === 'night' ? ' / night' : ''}`;
}

function Extras({ stay, sent, choose }: { stay: GuestStay; sent: PaidExtra[]; choose: (k: Upsell['kind']) => void }) {
  const NO = { calendar: 'Not available for your dates', price: 'Ask us for a price', short: 'For stays of 4+ nights', turnover: 'Not available — another guest that day' } as const;
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
            : needsApproval(stay, u) ? <span className="note">Subject to approval</span> : null}
          {asked && <span className="v-house-flag"><Icon n="done" /> Paid</span>}
          {a.ok && <span className="v-house-go">Choose ›</span>}
        </button>);
    })}</Carousel>
    {sent.length > 0 && <section className="card g-reqs">
      <h3>Your extras</h3>
      {sent.map((r, i) => <div key={i} className="g-req">
        <span><b>{r.title}</b>{choiceLine(r) && <span className="note"> · {choiceLine(r)}</span>}</span>
        <span className="g-req-r"><b>{money2(r.amount)}</b><span className="g-pill ok"><Icon n="check" /> Paid</span></span>
      </div>)}
    </section>}
  </>;
}

/**
 * One extra: pick, see the total, pay here (owner, 2026-11-17: nothing waits for an OK — the payment confirms it). Extra
 * nights also move the stay's dates once Stripe confirms.
 */
function Pick({ stay, u, paid, extend }: { stay: GuestStay; u: Upsell; paid: (c: Choice) => void; extend: (c: Choice) => void }) {
  const [done, setDone] = useState<{ title: string; line: string; sub?: string } | null>(null);
  // Airbnb (owner, 2026-11-23): extras through Airbnb's Resolution Center first; the card stays one tap away.
  const [card, setCard] = useState(false);
  const [c, setC] = useState<Choice>(u.pick.type === 'qty' ? { qty: 1 } : u.kind === 'extra-nights' ? { before: stay.freeAfter > 0 ? 0 : Math.min(1, stay.freeBefore), after: stay.freeAfter > 0 ? 1 : 0 } : {});
  const total = quote(stay, u, c);
  if (done) return <section className="card ci-card ci-confirmed">
    <span className="ci-seal" aria-hidden><Icon n="check" /></span>
    <b className="ci-name">{done.title}</b>
    <span className="ci-paid">{done.line}</span>
    <span className="note">{done.sub ?? 'Paid — it is yours'}</span>
  </section>;
  const ok = ready(stay, u, c) && total != null && total > 0;
  const nightsN = (c.before ?? 0) + (c.after ?? 0);
  const label = u.kind === 'extra-nights' ? `Extra nights (${nightsN})` : u.title;
  const approval = needsApproval(stay, u);
  const note = [choiceLine({ kind: u.kind, choice: c }), stay.unitName, approval ? APPROVAL_NOTE : ''].filter(Boolean).join(' · ');
  const onPaid = () => {
    if (u.kind === 'extra-nights') {
      const end = new Date(`${stay.departure}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + (c.after ?? 0));
      extend(c); setDone({ title: 'Stay extended', line: `Checkout ${dateLabel(end.toISOString().slice(0, 10))}` });
    } else setDone({ title: approval ? `${u.title} — requested` : `${u.title} — confirmed`, line: [choiceLine({ kind: u.kind, choice: c }), total != null ? money2(total) : ''].filter(Boolean).join(' · '),
      sub: approval ? 'Paid — we confirm it soon, or refund it in full' : undefined });
    paid(c);
  };
  return <>
    <section className="card g-pick">
      <p className="g-pick-title"><span className="g-up-icon" aria-hidden><Icon n={u.icon} /></span> {u.title}</p>
      {u.pick.type === 'time' && <div className="g-times" role="radiogroup" aria-label={u.kind === 'early-checkin' ? 'Arrive from' : 'Leave by'}>
        {timeOptions(stay, u).map(t => <button key={t} role="radio" aria-checked={c.time === t} className={c.time === t ? 'chip active' : 'chip'} onClick={() => setC({ time: t })}>{t}</button>)}
      </div>}
      {u.pick.type === 'nights' && <NightStrip stay={stay} c={c} set={setC} />}
      {u.pick.type === 'qty' && <Stepper label="How many" value={c.qty ?? 1} min={1} max={u.pick.max} set={v => setC({ qty: v })} />}
      {approval && <p className="note">Another guest leaves or arrives that day and you are asking on the day itself, so this is subject to our approval. If we cannot make it work, you get a full refund.</p>}
      <div className="g-total"><span>Total</span><b>{total != null ? money2(total) : '—'}</b></div>
      {ok && channelCovers(stay) && !card
        ? <AirbnbPay key={JSON.stringify(c)} amount={total!} purpose="extra" extra={{ kind: u.kind, choice: c as Record<string, unknown> }} onCard={() => setCard(true)}
            onSaid={() => setDone({ title: `${u.title} — requested`, line: [choiceLine({ kind: u.kind, choice: c }), money2(total!)].filter(Boolean).join(' · '),
              sub: 'Paid on Airbnb — we confirm it there, then set it up' })} />
        : ok ? <StripePay key={JSON.stringify(c)} email={stay.guest?.email ?? null} label={`${u.kind === 'extra-nights' ? 'Book' : 'Add'} & pay ${money2(total!)}`} back="extras"
          stay={stay} lines={[{ label, amount: total!, kind: 'charge', item: u.kind, note: note || undefined }]} onPaid={onPaid}
          extra={{ kind: u.kind, choice: c as Record<string, unknown> }} />
        : <button className="g-cta" disabled>{u.pick.type === 'time' ? 'Pick a time' : u.pick.type === 'nights' ? 'Pick your nights' : 'Not available'}</button>}
    </section>
  </>;
}

/** Check-in instructions: the builder's arrival steps (photos inline, video in a new tab), then the address. */
/** **word** in a guide's text shows bold (owner, 2026-11-23: the call box code stands out); everything else stays plain text. */
function boldText(text: string): React.ReactNode {
  const parts = text.split(/\*\*([^*]+)\*\*/);
  return parts.length === 1 ? text : parts.map((x, i) => i % 2 ? <b key={i}>{x}</b> : x);
}

function Arrival({ g }: { g: GuestGuide | null }) {
  const [view, setView] = useState<{ step: number; i: number } | null>(null);
  if (!g || (!g.steps?.length && !g.address)) return <div className="card g-guide"><p className="note"><Icon n="clock" /> Your check-in instructions will show here before arrival.</p></div>;
  return <div className="card g-guide">
    {g.steps && g.steps.length > 0 && <ol className="g-steps">
      {g.steps.map((st, i) => <li key={i} className="g-stepi">
        <span className="g-stepn" aria-hidden>{i + 1}</span>
        <div className="g-stepb"><b>{st.title}</b>{st.text && <p className="g-text">{boldText(st.text)}</p>}
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
  const tag: Record<string, [string, string]> = { wifi: ['wifi', 'Wi-Fi'], times: ['clock', 'Times'], parking: ['car', 'Parking'], access: ['home', 'Access'], rules: ['book', 'Rules'], contact: ['phone', 'Contact'] };
  return <div className="card g-guide">{order.map((h, i) => {
    const el = block(h, i);
    if (!isValidElement(el)) return null;
    const [icon, label] = h.field ? tag[h.field] ?? ['note', h.title] : ['note', h.title || 'More'];
    return cloneElement(el as React.ReactElement<Record<string, unknown>>, { 'data-gk': h.field ?? `item-${i}`, 'data-icon': icon, 'data-label': label });
  })}</div>;
}

/**
 * Extra nights straight from Hostaway's calendar (owner, 2026-11-16): the free nights before and after the stay, each
 * with its date and Hostaway's price. Nights join the stay, so picking one picks every night between it and the stay;
 * tapping the outermost picked one lets it go.
 */
function NightStrip({ stay, c, set }: { stay: GuestStay; c: Choice; set: (c: Choice) => void }) {
  const day = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const chip = (date: string, price: number | null | undefined, on: boolean, tap: () => void) => {
    const d = new Date(`${date}T12:00:00Z`);
    return <button key={date} className={`ci-night${on ? ' on' : ''}`} onClick={tap} aria-pressed={on}>
      <span>{d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span>
      <b>{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</b>
      <em>{price != null ? (price % 1 ? money2(price) : `$${price}`) : '—'}</em></button>;
  };
  const pick = (side: 'before' | 'after', i: number) => { const cur = c[side] ?? 0; set({ ...c, [side]: cur === i + 1 ? i : i + 1 }); };
  const price = (side: 'before' | 'after', i: number) => stay.nightPrices?.[side][i] ?? stay.nightly;
  const before = Array.from({ length: stay.freeBefore }, (_, i) => i).reverse();
  return <div className="ci-nights">
    <div className="ci-nights-row" role="group" aria-label="Free nights around your stay">
      {before.map(i => chip(day(stay.arrival, -(i + 1)), price('before', i), i < (c.before ?? 0), () => pick('before', i)))}
      <span className="ci-night stay" aria-label="Your stay"><span>Your stay</span><b>{nights(stay)} nights</b><em>{shortDay(stay.arrival)}–{shortDay(stay.departure)}</em></span>
      {Array.from({ length: stay.freeAfter }, (_, i) => chip(day(stay.departure, i), price('after', i), i < (c.after ?? 0), () => pick('after', i)))}
    </div>
    <span className="note"><Icon n="calendar" /> Live from our calendar</span>
  </div>;
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
  return <GuestPortal key={`${k}-${house.unit}`} stay={stay}
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
  calendar?: Pick<GuestStay, 'freeBefore' | 'freeAfter' | 'turnIn' | 'turnOut' | 'turnInGuest' | 'turnOutGuest' | 'nightPrices'> | null };
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

/**
 * The stay's own link (/guest/<reservation>.<sig>) — the portal's real door (Phase 2, owner 2026-11-23). The stay comes
 * from Hostaway through /api/report-link?stay= (functions/_lib/guest-stay.ts); every answer is saved there; the address,
 * Wi-Fi, arrival steps and door code arrive only once the server opens the entry. Charges the team made from a case
 * (upsell links, §178) show under the page as "Pending payments".
 */
type StayCharge = { id: string; label: string; amount: number; status: 'pending' | 'paid'; method?: 'card' | 'rc'; need?: string; hour?: number | null; payUrl: string | null;
  rcUrl?: string | null; saidPaidAt?: string | null; paidAt: string | null };
/**
 * Pending payments as one bar at the top that opens (owner, 2026-11-23: "on top, it slides open, very little text"). A Resolution
 * Center request stays here until the team marks it received; "I already paid" only tells the team.
 */
function PendingPayments({ pending, saidPaid, open, setOpen }: { pending: StayCharge[]; saidPaid: (id: string) => void; open: boolean; setOpen: (f: (o: boolean) => boolean) => void }) {
  const n = pending.length;
  return <section id="pending-payments" className={`gl-due ${open ? 'open' : ''}`}>
    <button type="button" className="gl-due-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Icon n="card" /><span>You have {n} pending payment{n === 1 ? '' : 's'}</span><span className="gl-due-arrow" aria-hidden>›</span>
    </button>
    <div className="gl-due-body"><div>
      <ul className="gl-charges">{pending.map(c => <li key={c.id}>
        <span className="gl-due-what"><b>{c.label}</b><small><Icon n="lock" /> {c.rcUrl ? 'Secure payment on Airbnb' : 'Secure card payment'}</small></span>
        <span className="gl-amt">{money2(c.amount)}</span>
        <span className="gl-due-acts">
          {c.payUrl && <a className="gl-pay" href={c.payUrl}>Pay</a>}
          {c.rcUrl && (c.saidPaidAt
            ? <span className="gl-due-check"><Icon n="clock" /> Confirming</span>
            : <><a className="gl-pay" href={c.rcUrl} target="_blank" rel="noreferrer">Pay on Airbnb</a>
              <button type="button" className="gl-paid" onClick={() => saidPaid(c.id)}>I already paid</button></>)}
        </span>
      </li>)}</ul>
    </div></div>
  </section>;
}

type StayAnswer = { ok: true; stay: GuestStay; flow: Flow; open: boolean } | { ok: false; message?: string };
export function GuestLinkPage() {
  const gl = guestLink(location.pathname);
  const token = gl?.sig ? `${gl.id}.${gl.sig}` : null;
  const [data, setData] = useState<{ stay: GuestStay; flow: Flow } | null>(null);
  const [charges, setCharges] = useState<StayCharge[]>([]);
  const [dueOpen, setDueOpen] = useState(false);
  const [bad, setBad] = useState('');
  const [saveNote, setSaveNote] = useState('');
  useEffect(() => {
    if (!token) { setBad('This stay link is not valid.'); return; }
    const q = encodeURIComponent(token);
    void fetch(`/api/report-link?stay=${q}`).then(r => r.json() as Promise<StayAnswer>)
      .then(j => j.ok ? setData({ stay: j.stay, flow: j.flow }) : setBad(j.message ?? 'This stay link is not valid.')).catch(() => setBad('Could not load — try again.'));
    void fetch(`/api/report-link?charges=${q}`).then(r => r.json() as Promise<{ ok: boolean; charges?: StayCharge[] }>)
      .then(j => { if (j.ok) setCharges(j.charges ?? []); }).catch(() => undefined);
  }, [token]);
  const save = (f: Flow) => {
    if (!token) return;
    void fetch(`/api/report-link?stay=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: f }) })
      .then(r => r.json() as Promise<StayAnswer>)
      .then(j => { if (j.ok) { setData({ stay: j.stay, flow: j.flow }); setSaveNote(''); } else setSaveNote(j.message ?? 'Not saved — check the connection.'); })
      .catch(() => setSaveNote('Not saved — check the connection.'));
  };
  if (bad) return <div className="report-page v-page g-page"><p className="banner warn">▲ {bad}</p></div>;
  if (!data) return <div className="report-page v-page g-page"><p className="note">Loading your stay…</p></div>;
  const pending = charges.filter(c => c.status === 'pending');
  const hourOf = (need: string) => { const c = pending.find(x => x.need === need && x.hour != null); return c ? timeOfHour(c.hour!) : null; };
  const due: Due = { checkin: hourOf('checkin'), checkout: hourOf('checkout'),
    open: () => { setDueOpen(true); document.getElementById('pending-payments')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
  const saidPaid = (id: string) => {
    if (!token) return;
    void fetch(`/api/report-link?charges=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ charge: id }) })
      .then(r => r.json() as Promise<{ ok: boolean; saidPaidAt?: string; message?: string }>)
      .then(j => j.ok ? setCharges(cs => cs.map(c => c.id === id ? { ...c, saidPaidAt: j.saidPaidAt ?? new Date().toISOString() } : c)) : setSaveNote(j.message ?? 'Not sent — try again.'))
      .catch(() => setSaveNote('Not sent — check the connection.'));
  };
  return <GuestPortal stay={data.stay} remote={{ flow: data.flow, save }}
    topBar={pending.length > 0 && <PendingPayments pending={pending} saidPaid={saidPaid} open={dueOpen} setOpen={setDueOpen} />} due={due}
    demoBar={saveNote && <p className="banner warn">▲ {saveNote}</p>} />;
}
