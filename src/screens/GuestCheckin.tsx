/**
 * Online check-in (guests module, 2026-11-15) — the steps before the door code, as the boss's reference
 * (Hostop) runs them, in Kaizen's look: details from the reservation (confirm only), identity (placeholder until
 * the provider is chosen), damage protection (waiver or deposit, values by unit type), house rules, extras,
 * one payment. Demo: nothing is charged and nothing is saved; `onPay` is where Stripe goes.
 */
import { useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Hint } from '../components/Hint.tsx';
import { money2 } from '../lib/format.ts';
import { UPSELLS, quote, requestMode, type GuestStay, type UpsellKind } from '../lib/guest-portal.ts';
import { FLOW_KEY, VS_KEY, bill, channelCovers, flowExtras, nextStep, onRequest, progress, rulesList, steps, SAMPLE_RULES,
  type Arrival, type Flow, type Protection, type Step, type StepKey } from '../lib/guest-checkin.ts';

const STEP_ICON: Record<StepKey, string> = { details: 'user', identity: 'idcard', protection: 'shield', rules: 'book', extras: 'sparkles', pay: 'card' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0, minimumFractionDigits: n % 1 ? 2 : 0 })}`;

/** The progress card: a ring with "n of m", and the one button that takes the guest to what is next. */
export function CheckinProgress({ st, go }: { st: Step[]; go: (k: StepKey) => void }) {
  const p = progress(st);
  const next = nextStep(st);
  const pct = p.of ? p.done / p.of : 0;
  return <section className="card ci-prog">
    <span className="ci-ring" style={{ ['--p' as string]: pct }} aria-hidden><b>{p.done}</b><span>of {p.of}</span></span>
    <span className="ci-prog-main">
      <span className="ci-eyebrow">Online check-in</span>
      <b className="ci-title">{next ? p.done === 0 ? 'Get ready for your stay' : 'Almost there' : 'You are checked in'}</b>
      <span className="note">{next ? <><Icon n="lock" /> Door code and Wi-Fi open when you finish</> : <><Icon n="done" /> Everything is done</>}</span>
    </span>
    {next && <button className="g-cta ci-prog-go" onClick={() => go(next)}>{p.done === 0 ? 'Start' : 'Continue'}</button>}
  </section>;
}

/** The step list (Check-in tab): numbered, done ones ticked, each opens its screen. */
export function StepList({ st, go }: { st: Step[]; go: (k: StepKey) => void }) {
  const next = nextStep(st);
  return <ol className="card ci-list">
    {st.map((x, i) => <li key={x.key}>
      <button className={`ci-row${x.done ? ' done' : ''}${x.key === next ? ' next' : ''}`} onClick={() => go(x.key)}>
        <span className="ci-n" aria-hidden>{x.done ? <Icon n="check" /> : i + 1}</span>
        <span className="ci-row-main"><b>{x.title}</b><span className="note">{x.sub}</span></span>
        <span className={`ci-tag${x.done ? ' ok' : ''}`}>{x.done ? 'Done' : x.required ? 'Required' : 'Optional'}</span>
      </button>
    </li>)}
  </ol>;
}

type Props = { stay: GuestStay; flow: Flow; set: (f: Flow) => void; p: Protection; back: () => void; go: (k: StepKey | null) => void };

/** One step's screen. Each "continue" saves the step and moves to the next one not done. */
export function StepScreen({ k, ...pr }: Props & { k: StepKey }) {
  const st = steps(pr.flow, pr.stay, pr.p);
  const i = st.findIndex(x => x.key === k);
  const save = (f: Flow) => { pr.set(f); const n = nextStep(steps(f, pr.stay, pr.p)); pr.go(n); };
  return <>
    <div className="ci-top">
      <button className="chip" onClick={pr.back}>‹ Check-in</button>
      <span className="ci-dots" aria-label={`Step ${i + 1} of ${st.length}`}>{st.map((x, j) => <i key={x.key} className={j === i ? 'on' : x.done ? 'ok' : ''} />)}</span>
    </div>
    <header className="ci-head">
      <span className="ci-head-icon" aria-hidden><Icon n={STEP_ICON[k]} /></span>
      <span className="ci-eyebrow">Step {i + 1} · {st[i]?.required ? 'Required' : 'Optional'}</span>
      <h2 className="ci-h">{HEAD[k]}</h2>
    </header>
    {k === 'details' ? <Details {...pr} save={save} />
      : k === 'identity' ? <Identity {...pr} save={save} />
      : k === 'protection' ? <ProtectionStep {...pr} save={save} />
      : k === 'rules' ? <Rules {...pr} save={save} />
      : k === 'extras' ? <Extras {...pr} save={save} />
      : <Pay {...pr} save={save} />}
  </>;
}

const HEAD: Record<StepKey, string> = {
  details: 'Is this right?', identity: 'Verify it’s you', protection: 'Protect your stay',
  rules: 'The house rules', extras: 'Make it better', pay: 'Review and pay',
};

type S = Props & { save: (f: Flow) => void };

function Details({ stay, flow, save }: S) {
  const g = stay.guest;
  const [arr, setArr] = useState<Arrival | null>(flow.arrival);
  const [pet, setPet] = useState<boolean | null>(flow.pet);
  const party = g ? [[g.adults, 'adult'], [g.children, 'child'], [g.infants, 'infant']].filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : w === 'child' ? 'ren' : 's'}`).join(' · ') : `${stay.guests} guests`;
  return <>
    <section className="card ci-card">
      <div className="ci-from"><span className="ci-eyebrow">From your booking</span>
        <Hint>These come from your reservation. If something is wrong, message us and we fix it — no need to type anything.</Hint></div>
      <p className="ci-name">{g?.name ?? stay.guestFirst}</p>
      <dl className="ci-dl">
        {g?.email && <><dt><Icon n="mail" /></dt><dd>{g.email}</dd></>}
        {g?.phone && <><dt><Icon n="phone" /></dt><dd>{g.phone}</dd></>}
        <dt><Icon n="users" /></dt><dd>{party}{stay.maxGuests ? <span className="note"> · up to {stay.maxGuests}</span> : null}</dd>
      </dl>
    </section>
    <section className="card ci-card">
      <span className="ci-q">When do you arrive?</span>
      <div className="ci-seg" role="radiogroup" aria-label="Arrival">
        {([['early', `At ${stay.checkInTime}`], ['mid', 'Evening'], ['late', 'After 9 PM']] as [Arrival, string][]).map(([v, l]) =>
          <button key={v} role="radio" aria-checked={arr === v} className={arr === v ? 'on' : ''} onClick={() => setArr(v)}>{l}</button>)}
      </div>
      <span className="ci-q">Bringing a pet?</span>
      <div className="ci-seg" role="radiogroup" aria-label="Pet">
        {([[false, 'No'], [true, 'Yes']] as [boolean, string][]).map(([v, l]) =>
          <button key={l} role="radio" aria-checked={pet === v} className={pet === v ? 'on' : ''} onClick={() => setPet(v)}>{l}</button>)}
      </div>
      {pet && <p className="note ci-inline"><Icon n="alert" /> A pet fee is added to your stay — we confirm it with you.</p>}
    </section>
    <button className="g-cta" disabled={arr == null || pet == null} onClick={() => save({ ...flow, details: true, arrival: arr, pet })}>Confirm</button>
  </>;
}

/** Placeholder until the provider is chosen (Truvi or Stripe Identity): shows what the guest will do. */
/** Identity: Stripe Identity's own page (ID photo + selfie, camera on the phone). Sandbox; Truvi vs Stripe still open. */
function Identity({ flow }: S) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setErr(null);
    const u = new URL(location.href);
    for (const k of ['step', 'paid', 'verified', 'extra']) u.searchParams.delete(k);
    u.searchParams.set('sec', 'checkin');
    try {
      const r = await fetch('/api/report-link?identity=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ back: u.pathname + u.search }) });
      const j = await r.json() as { url?: string; id?: string; message?: string };
      if (j.url && j.id) {
        try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); sessionStorage.setItem(VS_KEY, j.id); } catch { /* private mode */ }
        location.href = j.url; return;
      }
      setErr(j.message ?? 'Verification could not start.');
    } catch { setErr('Verification could not start — check the connection.'); }
    setBusy(false);
  };
  return <>
    <section className="card ci-card">
      <span className="ci-q">Your ID <Hint>Stripe opens its own page: pick driver’s license, passport or ID card, take a photo of it and a selfie
        (on a computer it offers to continue on the phone). Test mode: Stripe also offers ready-made test results.</Hint></span>
      <div className="ci-shots">
        <span className="ci-shot"><Icon n="idcard" /><span>Photo of your ID</span></span>
        <span className="ci-shot"><Icon n="camera" /><span>A quick selfie</span></span>
      </div>
      <p className="note ci-inline"><Icon n="lock" /> Encrypted by Stripe. Only used to match you to your booking.</p>
    </section>
    {err && <p className="banner warn">▲ {err}</p>}
    <button className="g-cta" onClick={start} disabled={busy}>{busy ? 'Opening verification…' : flow.identity ? 'Verify again' : 'Verify with Stripe'}</button>
    <p className="ci-stripe"><span><Icon n="lock" /> Identity by Stripe</span><span>Test mode</span></p>
  </>;
}

function ProtectionStep({ stay, flow, p, save }: S) {
  const [pick, setPick] = useState<'waiver' | 'deposit'>(flow.protection ?? 'waiver');
  if (channelCovers(stay)) return <>
    <section className="card ci-card ci-covered"><Icon n="shield" /><span><b>Covered by Airbnb</b><span className="note">AirCover protects this stay — nothing to add.</span></span></section>
    <button className="g-cta" onClick={() => save({ ...flow, protection: null })}>Continue</button>
  </>;
  return <>
    <div className="ci-opts" role="radiogroup" aria-label="Damage protection">
      <button role="radio" aria-checked={pick === 'waiver'} className={`card ci-plan${pick === 'waiver' ? ' on' : ''}`} onClick={() => setPick('waiver')}>
        <span className="ci-plan-top"><span className="ci-radio" aria-hidden /><b>Damage waiver</b><span className="ci-badge">Recommended</span></span>
        <span className="ci-price">{usd(p.waiver.price)}<span> once</span></span>
        <ul className="ci-pts"><li>Accidental damage covered up to {usd(p.waiver.cap)}</li><li>No hold on your card</li><li>No surprise bills after you leave</li></ul>
      </button>
      <button role="radio" aria-checked={pick === 'deposit'} className={`card ci-plan${pick === 'deposit' ? ' on' : ''}`} onClick={() => setPick('deposit')}>
        <span className="ci-plan-top"><span className="ci-radio" aria-hidden /><b>Security deposit</b></span>
        <span className="ci-price">{usd(p.deposit.hold)}<span> hold</span></span>
        <ul className="ci-pts"><li>Held on your card, not charged</li><li>Released 5–7 business days after check-out</li><li>Charged only if something is damaged</li></ul>
      </button>
    </div>
    <p className="ci-fine">Not covered: damage on purpose, theft, smoking, unapproved pets, and anything above {usd(p.waiver.cap)}.
      <Hint>The waiver is a one-time fee that covers accidental damage during your stay, up to the limit. The deposit is a temporary hold on your card; we release it after check-out unless damage is reported.</Hint></p>
    <button className="g-cta" onClick={() => save({ ...flow, protection: pick })}>Continue with the {pick === 'waiver' ? 'waiver' : 'deposit'}</button>
  </>;
}

function Rules({ stay, flow, save }: S) {
  const [ok, setOk] = useState(flow.rules);
  const items = rulesList(stay.guide?.rules || SAMPLE_RULES);
  return <>
    <ol className="card ci-rules">{items.map((r, i) => <li key={i}><span className="ci-rule-n">{String(i + 1).padStart(2, '0')}</span>
      <span><b>{r.title}</b>{r.detail && <span className="note">{r.detail}</span>}</span></li>)}</ol>
    <label className="ci-agree"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /><span>I have read the rules and agree to follow them during my stay.</span></label>
    <button className="g-cta" disabled={!ok} onClick={() => save({ ...flow, rules: true })}>Agree</button>
  </>;
}

function Extras({ stay, flow, save }: S) {
  const [ex, setEx] = useState(flow.extras);
  const list = flowExtras(stay);
  const toggle = (k: UpsellKind) => setEx(e => { const n = { ...e }; if (n[k]) delete n[k]; else { const u = UPSELLS.find(x => x.kind === k)!; n[k] = u.pick.type === 'time' ? { time: u.pick.options[1] ?? u.pick.options[0] } : {}; } return n; });
  const any = Object.keys(ex).length > 0;
  return <>
    <div className="ci-extras">{list.map(({ u, turnover }) => {
      const on = !!ex[u.kind];
      const price = (stay.prices?.[u.kind] ?? u.price) as number;
      return <section key={u.kind} className={`card ci-extra${on ? ' on' : ''}`}>
        <span className="g-up-icon" aria-hidden><Icon n={u.icon} /></span>
        <span className="ci-extra-main"><b>{u.title}</b>
          <span className="note">{usd(price)}{u.per === 'hour' ? ' / hour' : ''}{on && u.per === 'hour' && quote(stay, u, ex[u.kind]!) != null ? ` · ${usd(quote(stay, u, ex[u.kind]!)!)}` : ''}</span>
          {u.per === 'hour' && <span className={`ci-mode${onRequest(stay, u.kind, new Date()) ? '' : ' ok'}`}>{modeLine(stay, u.kind, turnover)}</span>}
          {on && u.pick.type === 'time' && <span className="ci-times">{u.pick.options.map(t =>
            <button key={t} className={ex[u.kind]?.time === t ? 'chip active' : 'chip'} onClick={() => setEx(e => ({ ...e, [u.kind]: { time: t } }))}>{t}</button>)}</span>}
        </span>
        <button className={on ? 'chip active ci-add' : 'chip ci-add'} aria-pressed={on} onClick={() => toggle(u.kind)}>{on ? <><Icon n="check" /> Added</> : 'Add'}</button>
      </section>;
    })}</div>
    <p className="ci-fine">Anything that needs our OK is charged only once we confirm it.</p>
    <button className="g-cta" onClick={() => save({ ...flow, extras: ex, extrasSeen: true })}>{any ? 'Continue' : 'No thanks, continue'}</button>
  </>;
}

/** Early / late: confirmed right away when asked by 8 PM (Texas) the day before and nobody else is leaving/arriving. */
function modeLine(stay: GuestStay, k: UpsellKind, turnover: boolean) {
  const m = requestMode(stay, { kind: k }, new Date());
  return m.mode === 'auto' ? '✓ Confirmed right away' : turnover || m.why === 'turnover' ? 'Needs our OK — another guest that day' : 'Needs our OK — asked after 8 PM the day before';
}

/**
 * Review and pay: the bill, then Stripe Checkout (Stripe's own page — Apple Pay, Google Pay, Link and cards show there
 * on their own). The answers so far are kept in the tab so the page picks up where it was when Stripe sends the guest
 * back; the step is done only once the server confirms the session (GuestPortal, `?paid=`). Sandbox only for now.
 */
function Pay({ stay, flow, p }: S) {
  const b = bill(flow, stay, p);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pay = async () => {
    setBusy(true); setErr(null);
    try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); } catch { /* private mode: the page just starts over */ }
    const u = new URL(location.href);
    for (const k of ['step', 'paid', 'verified', 'extra']) u.searchParams.delete(k);
    u.searchParams.set('sec', 'checkin');
    try {
      const r = await fetch('/api/report-link?checkout=1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: b.lines, email: stay.guest?.email ?? null, back: u.pathname + u.search }) });
      const j = await r.json() as { url?: string; message?: string };
      if (j.url) { location.href = j.url; return; }
      setErr(j.message ?? 'Payment could not start.');
    } catch { setErr('Payment could not start — check the connection.'); }
    setBusy(false);
  };
  const label = b.today > 0 ? `Pay ${money2(b.today)}` : `Authorize ${money2(b.hold)} hold`;
  return <>
    <section className="card ci-card ci-bill">
      {b.lines.map((l, i) => <div key={i} className="ci-line">
        <span><b>{l.label}</b>{l.note && <span className="note">{l.note}</span>}</span>
        <span className="ci-amt">{money2(l.amount)}{l.kind !== 'charge' && <span className="ci-kind">{l.kind === 'hold' ? 'Hold' : 'If confirmed'}</span>}</span>
      </div>)}
      <div className="ci-line ci-sum"><span>Today</span><b>{money2(b.today)}</b></div>
      {b.hold > 0 && <div className="ci-line ci-sum ci-sub"><span>Held, released after check-out</span><span>{money2(b.hold)}</span></div>}
    </section>
    {err && <p className="banner warn">▲ {err}</p>}
    <button className="g-cta" onClick={pay} disabled={busy}>{busy ? 'Opening secure payment…' : label}</button>
    <p className="ci-stripe"><span><Icon n="lock" /> Secure payment by Stripe</span>
      <span>Test mode <Hint>Stripe opens its own payment page: Apple Pay (iPhone / Safari), Google Pay (Chrome / Android) or a card.
        Test card 4242 4242 4242 4242, any future date, any CVC. A deposit is only held — captured after check-out if something is owed.</Hint></span></p>
  </>;
}

