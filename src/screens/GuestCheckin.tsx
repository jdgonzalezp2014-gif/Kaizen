/**
 * Online check-in (guests module, 2026-11-15) — the steps before the door code, as the boss's reference
 * (Hostop) runs them, in Kaizen's look: details from the reservation (confirm only), identity (placeholder until
 * the provider is chosen), damage protection (waiver or deposit, values by unit type), house rules, extras,
 * one payment. Demo: nothing is charged and nothing is saved; `onPay` is where Stripe goes.
 */
import { useEffect, useRef, useState } from 'react';
import { loadStripe, type EmbeddedCheckout } from '../components/stripe-js.ts';
import { Icon } from '../components/Icon.tsx';
import { Hint } from '../components/Hint.tsx';
import { money2 } from '../lib/format.ts';
import { UPSELLS, quote, type GuestStay, type UpsellKind } from '../lib/guest-portal.ts';
import { FLOW_KEY, VS_KEY, arrivalTimes, bill, channelCovers, flowExtras, nextStep, progress, rulesList, steps, SAMPLE_RULES,
  type Arrival, type BillLine, type Flow, type Protection, type Step, type StepKey } from '../lib/guest-checkin.ts';

const STEP_ICON: Record<StepKey, string> = { details: 'user', identity: 'idcard', protection: 'shield', rules: 'book', extras: 'sparkles', pay: 'card' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0, minimumFractionDigits: n % 1 ? 2 : 0 })}`;

/** The progress card: a ring with "n of m", and the one button that takes the guest to what is next. */
export function CheckinProgress({ st, go, list = false }: { st: Step[]; go: (k: StepKey) => void; list?: boolean }) {
  const p = progress(st);
  const next = nextStep(st);
  const pct = p.of ? p.done / p.of : 0;
  return <section className="card ci-prog">
    <span className="ci-ring" style={{ ['--p' as string]: pct }} aria-hidden><b>{p.done}</b><span>of {p.of}</span></span>
    <span className="ci-prog-main">
      <span className="ci-eyebrow">Online check-in</span>
      <b className="ci-title">{next ? p.done === 0 ? 'Get ready for your stay' : 'Almost there' : 'You are checked in'}</b>
      <span className="note">{next ? <><Icon n="lock" /> Unlocks door code & Wi-Fi</> : <><Icon n="done" /> Everything is done</>}</span>
    </span>
    {/* The Check-in section (owner, 2026-11-16): ring and steps in one card at the top — done ones open again, the button continues. */}
    {list && <StepRows st={st} go={go} />}
    {next && <button className="g-cta ci-prog-go" onClick={() => go(next)}>{p.done === 0 ? 'Start' : 'Continue'}</button>}
  </section>;
}

/** The step list: numbered, done ones ticked (tap to open again), each opens its screen. Inside the check-in card. */
function StepRows({ st, go }: { st: Step[]; go: (k: StepKey) => void }) {
  const next = nextStep(st);
  return <ol className="ci-list ci-list-in">
    {st.map((x, i) => <li key={x.key}>
      <button className={`ci-row${x.done ? ' done' : ''}${x.key === next ? ' next' : ''}`} onClick={() => go(x.key)}>
        <span className="ci-n" aria-hidden>{x.done ? <Icon n="check" /> : i + 1}</span>
        <span className="ci-row-main"><b>{x.title}</b><span className="note">{x.sub}</span></span>
        <span className={`ci-tag${x.done ? ' ok' : ''}`}>{x.done ? 'Done' : x.key === next ? 'Next' : x.required ? 'Required' : 'Optional'}</span>
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
  if (pr.flow.paid) return <>
    <SecTop><PaidIsland /></SecTop>
    <header className="ci-head"><span className="ci-eyebrow">Check-in</span><h2 className="ci-h">You’re all set</h2></header>
    <Pay {...pr} save={save} />
  </>;
  return <>
    <SecTop back={pr.back}><StepIsland st={st} at={k} go={pr.go} /></SecTop>
    <header className="ci-head">
      <span className="ci-eyebrow">Step {i + 1} of {st.length} · {st[i]?.required ? 'Required' : 'Optional'}</span>
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

/**
 * The island (owner, 2026-11-16) — the one structure every guest section shares: a round "‹" back, then the section's
 * parts as icons in one glass pill. The current part opens into a pill with its name; done ones keep a tick (tap to go
 * back to them); locked ones stay dim. Moving on closes one and opens the next (CSS transition on the label).
 */
export type IslandItem = { key: string; icon: string; label: string; done?: boolean; locked?: boolean };
export function Island({ items, at, pick, label }: { items: IslandItem[]; at: string | null; pick: (k: string) => void; label: string }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('.ci-isl.on')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); }, [at]);
  return <nav ref={box} className={`ci-island${items.length === 1 ? ' one' : ''}`} aria-label={label}>
    {items.map(x => {
      const on = x.key === at;
      return <button key={x.key} className={`ci-isl${on ? ' on' : ''}${x.done ? ' done' : ''}`} disabled={x.locked} onClick={() => pick(x.key)}
        aria-current={on ? 'step' : undefined} aria-label={`${x.label}${x.done ? ' — done' : x.locked ? ' — locked' : ''}`}>
        <span className="ci-isl-icon" aria-hidden><Icon n={x.icon} />{x.done && !on && <i className="ci-isl-tick"><Icon n="check" /></i>}</span>
        <span className="ci-isl-label">{x.label}</span>
      </button>;
    })}
  </nav>;
}
export function SecTop({ back, children }: { back?: () => void; children: React.ReactNode }) {
  return <div className="ci-top">
    {back && <button className="gx-icon-btn ci-back" onClick={back} aria-label="Back"><span aria-hidden>‹</span></button>}
    {children}
  </div>;
}

const SHORT: Record<StepKey, string> = { details: 'Details', identity: 'Your ID', protection: 'Protection', rules: 'House rules', extras: 'Extras', pay: 'Pay' };
/** The check-in steps as an island: the next one open, done ones ticked, the rest locked until reached. */
export function StepIsland({ st, at, go }: { st: Step[]; at: StepKey | null; go: (k: StepKey) => void }) {
  const next = nextStep(st);
  return <Island label="Check-in steps" at={at ?? next} pick={k => go(k as StepKey)}
    items={st.map(x => ({ key: x.key, icon: STEP_ICON[x.key], label: SHORT[x.key], done: x.done, locked: !(x.key === at || x.done || x.key === next) }))} />;
}
/** Paid: one pill across the top and no way back — what was paid stays paid (owner, 2026-11-16). */
export const PaidIsland = ({ label = 'Payment' }: { label?: string }) =>
  <Island label="Check-in" at="paid" pick={() => undefined} items={[{ key: 'paid', icon: 'check', label }]} />;

const HEAD: Record<StepKey, string> = {
  details: 'Is this right?', identity: 'Verify it’s you', protection: 'Protect your stay',
  rules: 'The house rules', extras: 'Make it better', pay: 'Review and pay',
};

type S = Props & { save: (f: Flow) => void };

function Details({ stay, flow, save }: S) {
  const g = stay.guest;
  const times = arrivalTimes(stay.checkInTime);
  const [arr, setArr] = useState<string>(flow.arrival && times.includes(flow.arrival) ? flow.arrival : times[0]!);
  const [fix, setFix] = useState(false);
  const [ask, setAsk] = useState(flow.changeAsk ?? '');
  const [asked, setAsked] = useState(!!flow.changeAsk);
  const party = g ? [[g.adults, 'adult'], [g.children, 'child'], [g.infants, 'infant']].filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : w === 'child' ? 'ren' : 's'}`).join(' · ') : `${stay.guests} guests`;
  return <>
    <section className="card ci-card">
      <div className="ci-from"><span className="ci-eyebrow">From your booking</span>
        <Hint>These come from your reservation. Something wrong? Tap "Request a change" — someone from our team contacts you and fixes it.</Hint></div>
      <p className="ci-name">{g?.name ?? stay.guestFirst}</p>
      <dl className="ci-dl">
        {g?.email && <><dt><Icon n="mail" /></dt><dd>{g.email}</dd></>}
        {g?.phone && <><dt><Icon n="phone" /></dt><dd>{g.phone}</dd></>}
        <dt><Icon n="users" /></dt><dd>{party}{stay.maxGuests ? <span className="note"> · up to {stay.maxGuests}</span> : null}</dd>
      </dl>
      {asked ? <p className="ci-ok"><Icon n="check" /> Sent — our team will contact you.</p>
        : fix ? <div className="ci-fix">
            <textarea value={ask} onChange={e => setAsk(e.target.value)} rows={2} placeholder="What should we fix?" aria-label="What should we fix?" />
            <button className="chip active" disabled={!ask.trim()} onClick={() => setAsked(true)}>Send</button>
          </div>
        : <button className="chip ci-fix-go" onClick={() => setFix(true)}>Request a change</button>}
    </section>
    <section className="card ci-card">
      <span className="ci-q">Arrival time</span>
      <TimeStrip times={times} value={arr} set={setArr} />
    </section>
    {/* The real link turns `changeAsk` into a task for the team (open item); the demo only shows it was sent. */}
    <button className="g-cta" onClick={() => save({ ...flow, details: true, arrival: arr, changeAsk: asked ? ask.trim() : null })}>Confirm</button>
  </>;
}

/** Slide to pick (owner, 2026-11-16: "choose the time by sliding"): a strip of times, the picked one centred. */
function TimeStrip({ times, value, set }: { times: string[]; value: string; set: (t: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [value]);
  return <div ref={box} className="ci-wheel" role="radiogroup" aria-label="Arrival time">
    {times.map(t => <button key={t} role="radio" aria-checked={value === t} className={value === t ? 'on' : ''} onClick={() => set(t)}>{t}</button>)}
  </div>;
}

/** Placeholder until the provider is chosen (Truvi or Stripe Identity): shows what the guest will do. */
/** Identity: Stripe Identity's own page (ID photo + selfie, camera on the phone). Sandbox; Truvi vs Stripe still open. */
function Identity({ flow, save, set }: S) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setErr(null);
    const u = new URL(location.href);
    for (const k of ['step', 'paid', 'verified', 'extra']) u.searchParams.delete(k);
    u.searchParams.set('sec', 'checkin');
    try {
      const r = await fetch('/api/report-link?identity=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ back: u.pathname + u.search, embedded: true }) });
      const j = await r.json() as { url?: string; id?: string; clientSecret?: string; publishableKey?: string; message?: string };
      // Inside the portal: Stripe's ID check opens over the page; then the server says whether it went through.
      if (j.clientSecret && j.publishableKey && j.id) {
        const st = await loadStripe(j.publishableKey);
        const res = await st.verifyIdentity(j.clientSecret);
        if (res.error && res.error.code !== 'session_cancelled') { setErr(res.error.message ?? 'Verification did not finish.'); setBusy(false); return; }
        const v = await fetch(`/api/report-link?identity=${encodeURIComponent(j.id)}`).then(x => x.json() as Promise<{ done?: boolean; message?: string }>);
        if (v.done) { set({ ...flow, identity: true }); setBusy(false); return; }
        setErr(res.error ? 'Verification was closed before the end.' : v.message ?? 'Verification was not finished.'); setBusy(false); return;
      }
      if (j.url && j.id) {
        try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); sessionStorage.setItem(VS_KEY, j.id); } catch { /* private mode */ }
        location.href = j.url; return;
      }
      setErr(j.message ?? 'Verification could not start.');
    } catch { setErr('Verification could not start — check the connection.'); }
    setBusy(false);
  };
  if (flow.identity && !busy) return <>
    <section className="card ci-card ci-confirmed">
      <span className="ci-seal" aria-hidden><Icon n="check" /></span>
      <b className="ci-name">ID verified</b>
      <span className="note">Checked by Stripe · photo and selfie match</span>
    </section>
    <button className="g-cta" onClick={() => save(flow)}>Continue</button>
  </>;
  return <>
    <section className="card ci-card">
      <span className="ci-q">Your ID <Hint>Stripe’s ID check opens over this page: pick driver’s license, passport or ID card, take a photo of it and a selfie
        (on a computer it offers to continue on the phone). Test mode: Stripe also offers ready-made test results.</Hint></span>
      <button className="ci-idgo" onClick={start} disabled={busy}>
        <span className="ci-idgo-icons" aria-hidden><Icon n="idcard" /><span>+</span><Icon n="camera" /></span>
        <span className="ci-idgo-main"><b>Your ID and a selfie</b><span className="note">Takes about a minute</span></span>
        <span className="g-go" aria-hidden>›</span>
      </button>
      <p className="note ci-inline"><Icon n="lock" /> Encrypted by Stripe · only for your booking</p>
    </section>
    {err && <p className="banner warn">▲ {err}</p>}
    <button className="g-cta" onClick={start} disabled={busy}>{busy ? 'Verifying…' : 'Verify my ID'}</button>
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
        <ul className="ci-pts"><li>{usd(p.waiver.perNight)} per night, {usd(p.waiver.min)} minimum</li><li>Accidental damage covered up to {usd(p.waiver.cap)}</li><li>No hold on your card</li><li>No surprise bills after you leave</li></ul>
      </button>
      <button role="radio" aria-checked={pick === 'deposit'} className={`card ci-plan${pick === 'deposit' ? ' on' : ''}`} onClick={() => setPick('deposit')}>
        <span className="ci-plan-top"><span className="ci-radio" aria-hidden /><b>Security deposit</b></span>
        <span className="ci-price">{usd(p.deposit.hold)}<span> hold</span></span>
        <ul className="ci-pts"><li>Held on your card, not charged</li><li>Released 5–7 business days after check-out</li><li>Charged only if something is damaged</li></ul>
      </button>
    </div>
    <p className="ci-fine">Not covered: damage on purpose, theft, smoking, unapproved pets, and anything above {usd(p.waiver.cap)}.
      <Hint>The waiver is a one-time fee ({usd(p.waiver.perNight)} per night or {usd(p.waiver.min)}, whichever is greater) that covers accidental damage during your stay, up to the limit. The deposit is a temporary hold on your card; we release it after check-out unless damage is reported.</Hint></p>
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
    <div className="ci-extras">{list.map(({ u }) => {
      const on = !!ex[u.kind];
      const price = (stay.prices?.[u.kind] ?? u.price) as number;
      return <section key={u.kind} className={`card ci-extra${on ? ' on' : ''}`}>
        <span className="g-up-icon" aria-hidden><Icon n={u.icon} /></span>
        <span className="ci-extra-main"><b>{u.title}</b>
          <span className="note">{usd(price)}{u.per === 'hour' ? ' / hour' : u.per === 'night' ? ' / night' : ''}{on && (u.per === 'hour' || u.per === 'night') && quote(stay, u, ex[u.kind]!) != null ? ` · ${usd(quote(stay, u, ex[u.kind]!)!)}` : ''}</span>
          {on && u.pick.type === 'time' && <span className="ci-times">{u.pick.options.map(t =>
            <button key={t} className={ex[u.kind]?.time === t ? 'chip active' : 'chip'} onClick={() => setEx(e => ({ ...e, [u.kind]: { time: t } }))}>{t}</button>)}</span>}
        </span>
        <button className={on ? 'chip active ci-add' : 'chip ci-add'} aria-pressed={on} onClick={() => toggle(u.kind)}>{on ? <><Icon n="check" /> Added</> : 'Add'}</button>
      </section>;
    })}</div>
    <p className="ci-fine">What you add is paid with your check-in payment and confirmed right away.</p>
    <button className="g-cta" onClick={() => save({ ...flow, extras: ex, extrasSeen: true })}>{any ? 'Continue' : 'No thanks, continue'}</button>
  </>;
}

/**
 * Review and pay: the bill, then Stripe Checkout (Stripe's own page — Apple Pay, Google Pay, Link and cards show there
 * on their own). The answers so far are kept in the tab so the page picks up where it was when Stripe sends the guest
 * back; the step is done only once the server confirms the session (GuestPortal, `?paid=`). Sandbox only for now.
 */
function Pay({ stay, flow, p, save, set }: S) {
  const b = bill(flow, stay, p);
  const label = b.today > 0 ? `Pay ${money2(b.today)}` : `Authorize ${money2(b.hold)} hold`;
  if (flow.paid) return <>
    <PaidCard flow={flow} today={b.today} hold={b.hold} />
    <button className="g-cta" onClick={() => save(flow)}>Continue</button>
  </>;
  return <>
    <section className="card ci-card ci-bill">
      {b.lines.map((l, i) => <div key={i} className="ci-line">
        <span><b>{l.label}</b>{l.note && <span className="note">{l.note}</span>}</span>
        <span className="ci-amt">{money2(l.amount)}{l.kind !== 'charge' && <span className="ci-kind">Hold</span>}</span>
      </div>)}
      <div className="ci-line ci-sum"><span>Today</span><b>{money2(b.today)}</b></div>
      {b.hold > 0 && <div className="ci-line ci-sum ci-sub"><span>Held, released after check-out</span><span>{money2(b.hold)}</span></div>}
    </section>
    <StripePay lines={b.lines} email={stay.guest?.email ?? null} label={label} stay={stay}
      beforeRedirect={() => { try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); } catch { /* private mode: the page just starts over */ } }}
      onPaid={total => set({ ...flow, paid: true, paidTotal: total })} />
  </>;
}

/**
 * Stripe inside the page (boss, 2026-11-16): Embedded Checkout mounts here — card, Apple Pay, Google Pay — no redirect;
 * `onPaid` once the server confirms the session. Without a publishable key the server answers Stripe's hosted page
 * and the guest is sent there (`beforeRedirect` keeps what must survive the trip). Used by check-in and by extensions.
 */
export function StripePay({ lines, email, label, onPaid, beforeRedirect, back = 'checkin', stay }: { lines: BillLine[]; email: string | null; label: string;
  onPaid: (total: number | null) => void; beforeRedirect?: () => void; back?: string; stay?: Pick<GuestStay, 'id' | 'unitName' | 'guest'> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ id: string; clientSecret: string; pk: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!embed) return;
    let ec: EmbeddedCheckout | null = null; let live = true;
    const done = () => void fetch(`/api/report-link?checkout=${encodeURIComponent(embed.id)}`).then(r => r.json() as Promise<{ paid?: boolean; total?: number; message?: string }>)
      .then(j => { if (j.paid) { setEmbed(null); onPaid(j.total ?? null); } else setErr(j.message ?? 'The payment was not completed.'); }, () => setErr('Could not check the payment.'));
    loadStripe(embed.pk).then(st => st.initEmbeddedCheckout({ fetchClientSecret: async () => embed.clientSecret, onComplete: done }))
      .then(c => { if (!live) { c.destroy(); return; } ec = c; if (box.current) c.mount(box.current); setBusy(false); },
        e => { setErr(e instanceof Error ? e.message : String(e)); setEmbed(null); setBusy(false); });
    return () => { live = false; ec?.destroy(); };
  }, [embed]);
  const pay = async () => {
    setBusy(true); setErr(null);
    beforeRedirect?.();
    const u = new URL(location.href);
    for (const k of ['step', 'paid', 'verified', 'extra']) u.searchParams.delete(k);
    u.searchParams.set('sec', back);
    try {
      const r = await fetch('/api/report-link?checkout=1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Which stay, for the books (guest_payments): the reservation and the house the guest paid from.
        body: JSON.stringify({ lines, email, back: u.pathname + u.search, embedded: true,
          stay: stay && { id: stay.id, unitName: stay.unitName, guest: stay.guest?.name ?? null } }) });
      const j = await r.json() as { url?: string; id?: string; clientSecret?: string; publishableKey?: string; message?: string };
      if (j.clientSecret && j.publishableKey && j.id) { setEmbed({ id: j.id, clientSecret: j.clientSecret, pk: j.publishableKey }); return; }
      if (j.url && beforeRedirect) { location.href = j.url; return; }
      setErr(j.message ?? 'Payment could not start.');
    } catch { setErr('Payment could not start — check the connection.'); }
    setBusy(false);
  };
  return <>
    {err && <p className="banner warn">▲ {err}</p>}
    {embed ? <>
      <div ref={box} className="ci-embed" aria-label="Secure payment by Stripe" />
      <button className="chip ci-embed-back" onClick={() => { setEmbed(null); setErr(null); }}>‹ Back to the summary</button>
    </> : <button className="g-cta" onClick={pay} disabled={busy}>{busy ? 'Opening secure payment…' : label}</button>}
    <p className="ci-stripe"><span><Icon n="lock" /> Secure payment by Stripe</span>
      <span>Test mode <Hint>Pay right here: Apple Pay (iPhone / Safari), Google Pay (Chrome / Android) or a card.
        Test card 4242 4242 4242 4242, any future date, any CVC. A deposit is only held — captured after check-out if something is owed.</Hint></span></p>
  </>;
}

/** The payment, confirmed (owner, 2026-11-16: "confirm it was paid — it does not show"): Stripe's total, and the hold. */
export function PaidCard({ flow, today, hold }: { flow: Flow; today: number; hold: number }) {
  // Stripe's total covers the hold too (one manual-capture payment); the bill splits it back.
  const now = hold > 0 ? today : flow.paidTotal ?? today;
  return <section className="card ci-card ci-confirmed">
    <span className="ci-seal" aria-hidden><Icon n="check" /></span>
    <b className="ci-name">Payment confirmed</b>
    <span className="ci-paid">{money2(now)} <span className="note">today</span>{hold > 0 && <> · {money2(hold)} <span className="note">held</span></>}</span>
    {hold > 0 && <span className="note">The hold is released after check-out</span>}
  </section>;
}
