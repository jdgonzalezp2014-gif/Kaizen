/**
 * A handyman on a repair (§137) — the cleaner's idea for repairs: one work
 * order, its steps in order, every step saved and told to the team. The same
 * card behind both doors: the link the team sends (`/report#w=`, no account)
 * and the handyman signed in (`VendorHome`: their work orders).
 *
 *   1 ✅ the day the team set — accept, or "can't" (the team gets a
 *     "Reschedule" task)
 *   2 📷 photos BEFORE · 3 📷 photos AFTER
 *   4 💵 charges and materials, each with its receipt — waiting for the
 *     team's approval (no preset prices)
 *   5 ✅ done — what was done
 *   and 💬 a note or question to the team, any time.
 * The access (code, lockbox, Wi-Fi) shows on the day set only.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getVendorAs, getVendorWork, getWorkLink, vendorAct, vendorRequest, workLinkAct, workPhoto, type PastJob, type VendorHomeData, type VendorPage, type WorkDoor, type WorkPage, type WorkRequest } from '../api.ts';
import { EN, VendorInvoiceView } from './Handymen.tsx';
import { money2 } from '../lib/format.ts';
import { addDays } from '../lib/dates.ts';
import { AccessBox } from '../components/AccessBox.tsx';
import { PhotoPicker, shrink } from '../components/PhotoPicker.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { TX as CREW_TX, dayLabel, isLang, type Lang, type Tx } from '../lib/crew-i18n.ts';
import { Icon, ic } from '../components/Icon.tsx';
import { useUrlState } from '../components/useUrlState.ts';

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
/** "14:30:00" → "2:30 PM". */
const clock = (t: string) => { const [h = 0, m = 0] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

const W = {
  en: {
    day: 'Day set', at: 'at', noDay: 'No day set yet', what: 'What to fix',
    s1: 'Accept the day', accepted: '✓ Accepted', notYet: 'Not yet', accept: '✅ Yes, I can that day', cant: "✕ I can't that day", why: 'Why (optional)',
    cantSend: "Send — the team will set another day", cantNote: 'The team gets a task to reschedule.',
    s2: '📷 Photos BEFORE', s3: '📷 Photos AFTER', photos: (n: number) => n ? `✓ ${n} photo${n === 1 ? '' : 's'}` : 'Not yet',
    send: 'Send', sending: 'Sending…', sendPhotos: (n: number) => `Send ${n} photo${n === 1 ? '' : 's'}`,
    s4: '💵 Charges & materials', s4note: 'Each one with its receipt or invoice. The team approves it — then it is paid.',
    labor: '🔧 Labor', materials: '🧱 Materials', amount: 'Amount ($)', forWhat: 'What for', receipt: 'Receipt or invoice',
    addCharge: '+ Add a charge', charges: (n: number, waiting: number) => n ? `${n} charge${n === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting for approval` : ''}` : 'None yet', chargeState: { pending: '○ waiting for approval', approved: '✓ approved', denied: '■ denied' } as Record<string, string>,
    s5: '✅ Done', doneQ: 'What did you do?', markDone: 'Mark the repair done', done: (t: string) => `✅ Done — ${t}`,
    note: '💬 A note or a question for the team', noteSend: 'Send the note', sent: '✓ Sent',
    closed: 'This work order is closed.', none: 'No open work orders for you right now.', hello: (n: string) => `Hi, ${n}`,
    needAmount: 'Write the amount.', needWhat: 'Say what it is for.', needDone: 'Say what was done.',
    tabWork: 'Jobs', tabPay: 'Pay', payPeriod: 'Period', jobs: (n: number, t: string) => `${n} job${n === 1 ? '' : 's'} paid · ${t}`,
    flag: 'Note from the team', corrected: 'Pay corrected', notPaid: 'Not paid', paidOn: (d: string, how: string) => `Paid ${d} ${how}`,
    byBank: 'to your bank', byHand: 'by hand', unpaid: 'Not paid yet',
    houses: 'Houses', back: '‹ Houses', open: 'Open', of: (i: number, n: number) => `${i} of ${n}`,
    jobsN: (n: number) => `${n} job${n === 1 ? '' : 's'}`, toAccept: (n: number) => `${n} to accept`,
    ask: '＋ Ask to approve other work', askTip: 'Something else that needs fixing, or that you did: the team approves it — then it is one of your jobs.',
    house: 'House', whatWork: 'What is the work?', estimate: 'Estimate $ (optional)', askSend: 'Send for approval', cancel: 'Cancel',
    needHouse: 'Pick the house.', asked: '✓ Sent — the team will approve it or tell you.', waiting: 'Waiting for approval',
    pending: 'waiting', declined: 'not approved',
    tabCal: 'Upcoming', tabPast: 'Past', today: 'Today', tomorrow: 'Tomorrow', late: 'late', acceptedShort: '✓ accepted', toAcceptShort: 'to accept',
    signIn: 'Sign in with your email', noPast: 'No finished jobs in the last 90 days.', noPay: 'No pay set yet', addExtra: '＋ Add an extra', extraSent: '✓ Sent — waiting for the team’s approval.'
  },
  es: {
    day: 'Día acordado', at: 'a las', noDay: 'Aún no hay día', what: 'Qué hay que arreglar',
    s1: 'Aceptar el día', accepted: '✓ Aceptado', notYet: 'Todavía no', accept: '✅ Sí, puedo ese día', cant: '✕ No puedo ese día', why: '¿Por qué? (opcional)',
    cantSend: 'Enviar — el equipo pondrá otro día', cantNote: 'El equipo recibe una tarea para reagendar.',
    s2: '📷 Fotos ANTES', s3: '📷 Fotos DESPUÉS', photos: (n: number) => n ? `✓ ${n} foto${n === 1 ? '' : 's'}` : 'Todavía no',
    send: 'Enviar', sending: 'Enviando…', sendPhotos: (n: number) => `Enviar ${n} foto${n === 1 ? '' : 's'}`,
    s4: '💵 Cobros y materiales', s4note: 'Cada uno con su recibo o factura. El equipo lo aprueba — y luego se paga.',
    labor: '🔧 Mano de obra', materials: '🧱 Materiales', amount: 'Monto ($)', forWhat: 'Para qué', receipt: 'Recibo o factura',
    addCharge: '+ Agregar un cobro', charges: (n: number, waiting: number) => n ? `${n} cobro${n === 1 ? '' : 's'}${waiting ? ` · ${waiting} esperando aprobación` : ''}` : 'Ninguno aún', chargeState: { pending: '○ esperando aprobación', approved: '✓ aprobado', denied: '■ rechazado' } as Record<string, string>,
    s5: '✅ Terminado', doneQ: '¿Qué hiciste?', markDone: 'Marcar la reparación como terminada', done: (t: string) => `✅ Terminado — ${t}`,
    note: '💬 Una nota o pregunta para el equipo', noteSend: 'Enviar la nota', sent: '✓ Enviado',
    closed: 'Esta orden está cerrada.', none: 'No tienes órdenes abiertas por ahora.', hello: (n: string) => `Hola, ${n}`,
    needAmount: 'Escribe el monto.', needWhat: 'Di para qué es.', needDone: 'Di qué se hizo.',
    tabWork: 'Trabajos', tabPay: 'Pago', payPeriod: 'Periodo', jobs: (n: number, t: string) => `${n} trabajo${n === 1 ? '' : 's'} pagado${n === 1 ? '' : 's'} · ${t}`,
    flag: 'Nota del equipo', corrected: 'Pago corregido', notPaid: 'No pagado', paidOn: (d: string, how: string) => `Pagado ${d} ${how}`,
    byBank: 'a tu banco', byHand: 'en mano', unpaid: 'Aún no pagado',
    houses: 'Casas', back: '‹ Casas', open: 'Abrir', of: (i: number, n: number) => `${i} de ${n}`,
    jobsN: (n: number) => `${n} trabajo${n === 1 ? '' : 's'}`, toAccept: (n: number) => `${n} por aceptar`,
    ask: '＋ Pedir aprobar otro trabajo', askTip: 'Algo más que hay que arreglar, o que hiciste: el equipo lo aprueba — y pasa a ser uno de tus trabajos.',
    house: 'Casa', whatWork: '¿Qué trabajo es?', estimate: 'Estimado $ (opcional)', askSend: 'Enviar para aprobar', cancel: 'Cancelar',
    needHouse: 'Elige la casa.', asked: '✓ Enviado — el equipo lo aprobará o te dirá.', waiting: 'Esperando aprobación',
    pending: 'esperando', declined: 'no aprobado',
    tabCal: 'Próximos', tabPast: 'Pasados', today: 'Hoy', tomorrow: 'Mañana', late: 'atrasado', acceptedShort: '✓ aceptado', toAcceptShort: 'por aceptar',
    signIn: 'Entra con tu correo', noPast: 'Sin trabajos terminados en los últimos 90 días.', noPay: 'Aún sin pago', addExtra: '＋ Añadir un extra', extraSent: '✓ Enviado — espera la aprobación del equipo.'
  }
};
type Wx = typeof W.en;
type Send = (fields: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string; page?: WorkPage }>;
/** A photo named in a work order's description, loaded through the page's own door (Drive is the team's). */
type Photo = (todoId: string, driveId: string) => Promise<string>;
const driveIdOf = (url: string) => /(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{10,200})/.exec(url)?.[1] ?? null;

/**
 * What to fix, in reading size (owner, 2026-10-27): the finding's lines, and its "Photo:" lines as the photos themselves —
 * big, one under the other, tap for full size. Without a door to load them (practice), the links as they are.
 */
function WhatToFix({ id, text, photo }: { id: string; text: string; photo?: Photo }) {
  const lines = text.split('\n');
  const urls = lines.map(l => /^\s*Photo:\s*(\S+)/.exec(l)?.[1]).filter((u): u is string => !!u);
  const ids = photo ? urls.map(driveIdOf).filter((x): x is string => !!x) : [];
  return (
    <div className="work-what">
      {lines.filter(l => !(ids.length && /^\s*Photo:/.test(l)) && l.trim()).map((l, i) => <p key={i}>{ic(l.trim())}</p>)}
      {ids.length > 0 && <div className="work-photos">{ids.map(d => <Thumb key={d} load={() => photo!(id, d)} />)}</div>}
    </div>
  );
}
function Thumb({ load }: { load: () => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => { let u: string | null = null; load().then(x => { u = x; setSrc(x); }, () => setBad(true)); return () => { if (u) URL.revokeObjectURL(u); }; }, []);
  if (bad) return <p className="note"><Icon n="camera" /> {ic('Photo not available')}</p>;
  return <a href={src ?? undefined} target="_blank" rel="noreferrer">{src ? <img src={src} alt="" loading="lazy" /> : <p className="note loading-dot">…</p>}</a>;
}

/** The language switch and day/night, in one line on top. */
function Head({ title, lang, setLang }: { title: string; lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <header className="mini-head">
      <span className="mini-brand">{ic(title)}</span>
      <span className="mini-tools">
        <span className="todo-kind" role="group" aria-label="Language / Idioma">
          {(['en', 'es'] as const).map(l => <button key={l} className={l === lang ? 'chip active' : 'chip'} onClick={() => setLang(l)}>{ic(l.toUpperCase())}</button>)}
        </span>
        <ThemeToggle />
      </span>
    </header>
  );
}
const useLang = (): [Lang, (l: Lang) => void] => {
  const [lang, set] = useState<Lang>(() => { const l = get('workLang'); return isLang(l) ? l : 'en'; });
  return [lang, (l: Lang) => { set(l); put('workLang', l); }];
};

/** The link door: one work order. */
export function WorkLinkPage({ token, practice }: { token: string; practice?: { page: WorkPage; send: Send } }) {
  const [lang, setLang] = useLang();
  const [page, setPage] = useState<WorkPage | null>(practice?.page ?? null);
  const [err, setErr] = useState('');
  useEffect(() => { if (!practice) getWorkLink(token).then(r => r.ok ? setPage(r.page) : setErr(r.message ?? 'Not valid.')).catch(e => setErr(String(e))); }, [token]);
  return <>
    <Head title={page?.work.unit ? `${page.work.unit}` : 'Kaizen'} lang={lang} setLang={setLang} />
    <div className="report-page">
      {err ? <p className="banner error">{ic(err)}</p> : !page ? <p className="note loading-dot">…</p>
        : <WorkCard page={page} lang={lang} send={practice?.send ?? ((f, files) => workLinkAct(token, f, files))} onPage={setPage}
                    photo={practice ? undefined : (id, d) => workPhoto({ workToken: token }, id, d)} />}
    </div>
  </>;
}

/** The account door: a handyman signed in sees their work orders. */
export function VendorHome({ practice, token, asVendor }: { practice?: { vendor: string; works: WorkPage[]; send: (id: string, fields: Record<string, string>, files: File[]) => ReturnType<Send> }; token?: string;
  /** The team's "View as handyman" (owner, 2026-10-27): their page, buttons that save nothing. */
  asVendor?: string } = {}) {
  const [lang, setLang] = useLang();
  const [data, setData] = useState<(Omit<VendorHomeData, 'pay'> & { pay?: VendorPage | null }) | null>(practice ? { vendor: practice.vendor, works: practice.works } : null);
  const [err, setErr] = useState('');
  // Owner, 2026-10-27: their jobs by house, what is coming by day (to organise themselves), what is done (extras, pay).
  type Sec = 'work' | 'cal' | 'past' | 'pay';
  const [sec, setSec] = useState<Sec>('work');
  const [focus, setFocus] = useState<string | null>(null);
  // Owner, 2026-10-27: by house — a carousel of houses, and inside one, a carousel of its jobs. The phone's back
  // gesture steps back from a house to the houses, and through the sections (useUrlState.ts).
  const [house, setHouse] = useState<string | null>(null);
  useUrlState('sec', sec, setSec, { def: 'work', valid: v => ['work', 'cal', 'past', 'pay'].includes(v) });
  useUrlState('house', house ?? '', v => setHouse(v || null), { def: '' });
  const [period, setPeriod] = useState<string | null>(null);
  const door: WorkDoor = asVendor ? { asVendor } : { token };
  const load = () => (asVendor ? getVendorAs(asVendor, period) : getVendorWork(period, token)).then(r => r.ok ? setData(r) : setErr(r.message ?? 'Could not load.')).catch(e => setErr(String(e)));
  useEffect(() => { if (!practice) void load(); }, [period]);
  const w = W[lang];
  const houses = data ? byHouse(data.works) : [];
  const open = houses.find(h => h.key === house) ?? null;
  const card = (p: WorkPage) => <WorkCard page={p} lang={lang}
    send={(f, files) => practice ? practice.send(p.work.id, f, files)
      : asVendor ? Promise.resolve({ ok: false, message: 'Preview — nothing is saved here.' }) : vendorAct(p.work.id, f, files, token)}
    photo={practice ? undefined : (id, d) => workPhoto(door, id, d)}
    onPage={np => setData(d => d && { ...d, works: d.works.map(x => x.work.id === np.work.id ? np : x) })} />;
  return <>
    {/* The island: who, work or pay, language and night — always in reach. */}
    <header className="v-island">
      <span className="v-island-name">{ic(data ? w.hello(data.vendor) : 'Kaizen')}</span>
      {data && !practice && <span className="v-seg" role="tablist">
        {([['work', 'wrench', w.tabWork], ['cal', 'calendar', w.tabCal], ['past', 'done', w.tabPast], ...(data.pay ? [['pay', 'dollar', w.tabPay]] : [])] as [Sec, string, string][])
          .map(([k, icon, label]) => <button key={k} role="tab" aria-selected={sec === k} className={sec === k ? 'on' : ''} onClick={() => { setSec(k); if (k !== 'work') setHouse(null); }}>
            <Icon n={icon} /> {ic(label)}</button>)}
      </span>}
      <span className="mini-tools">
        <span className="todo-kind" role="group" aria-label="Language / Idioma">
          {(['en', 'es'] as const).map(l => <button key={l} className={l === lang ? 'chip active' : 'chip'} onClick={() => setLang(l)}>{ic(l.toUpperCase())}</button>)}
        </span>
        <ThemeToggle />
      </span>
    </header>
    <div className="report-page v-page">
      {err ? <>
        <p className="banner error">{ic(err)}</p>
        {/* Owner, 2026-10-27: a handyman whose link the team turned off signs in with the email the team has for them. */}
        {token && <a className="fr-btn" href="/"><Icon n="user" /> {ic(w.signIn)}</a>}
      </> : !data ? <p className="note loading-dot">…</p>
        : sec === 'pay' && data.pay ? <VendorPay pay={data.pay} lang={lang} onPeriod={setPeriod} />
        : sec === 'cal' ? <Upcoming w={w} lang={lang} works={data.works} open={p => { setSec('work'); setFocus(p.work.id); setHouse(p.work.unit ?? '—'); }} />
        : sec === 'past' ? <Past w={w} lang={lang} jobs={data.past ?? []}
            add={(id, f, files) => asVendor ? Promise.resolve({ ok: false, message: 'Preview — nothing is saved here.' }) : vendorAct(id, f, files, token)}
            onAdded={() => void load()} />
        : open ? <>
            <div className="v-house-head">
              <button className="chip" onClick={() => setHouse(null)}>{ic(w.back)}</button>
              <span><b>{ic(open.name)}</b>{open.address && <> · <a href={`https://maps.google.com/?q=${encodeURIComponent(open.address)}`} target="_blank" rel="noreferrer"><Icon n="pin" /> {ic(open.address)}</a></>}</span>
            </div>
            <Carousel label={open.name} of={w.of} wide start={Math.max(0, open.works.findIndex(p => p.work.id === focus))}>{open.works.map(p => <div key={p.work.id}>{card(p)}</div>)}</Carousel>
          </>
        : <>
            <h2 className="v-h">{ic(w.houses)}</h2>
            {!houses.length && <div className="card"><p className="note">{ic(w.none)}</p></div>}
            {houses.length > 0 && <Carousel label={w.houses} of={w.of}>{houses.map(h => (
              <button key={h.key} className="card v-house" onClick={() => setHouse(h.key)}>
                <span className="v-house-name"><Icon n="home" /> {ic(h.name)}</span>
                {h.address && <span className="note">{ic(h.address)}</span>}
                <span className="v-house-n">{ic(w.jobsN(h.works.length))}</span>
                <span>{ic(h.day ? `${w.day}: ${dayLabel(lang, h.day)}` : w.noDay)}</span>
                {h.toAccept > 0 && <span className="v-house-flag">{ic(w.toAccept(h.toAccept))}</span>}
                <ul className="v-house-list">{h.works.slice(0, 4).map(p => <li key={p.work.id}>{ic(p.work.title)}</li>)}{h.works.length > 4 && <li>…</li>}</ul>
                <span className="v-house-go">{ic(w.open)} ›</span>
              </button>))}
            </Carousel>}
            {!practice && <AskApproval w={w} lang={lang} houses={data.houses ?? []} requests={data.requests ?? []}
              send={(f, files) => asVendor ? Promise.resolve({ ok: false, message: 'Preview — nothing is saved here.' }) : vendorRequest(f, files, token)}
              onSent={rs => setData(d => d && { ...d, requests: rs })} />}
          </>}
    </div>
  </>;
}

/**
 * Owner, 2026-10-27: other work they did or found, sent to the team to approve — the house, what, an estimate, photos.
 * Approved, it becomes one of their jobs (and their Slack channel says so); declined, it shows here for two weeks.
 */
function AskApproval({ w, lang, houses, requests, send, onSent }: { w: Wx; lang: Lang; houses: { id: string; name: string }[]; requests: WorkRequest[];
  send: (f: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string; requests?: WorkRequest[] }>; onSent: (r: WorkRequest[]) => void }) {
  const tx = CREW_TX[lang];
  const [adding, setAdding] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [what, setWhat] = useState('');
  const [estimate, setEstimate] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const missing = !unitId ? w.needHouse : !what.trim() ? w.needWhat : '';
  const go = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await send({ unitId, what: what.trim(), estimate }, await Promise.all(files.map(shrink)));
      if (!r.ok) { setMsg(r.message ?? 'Not sent.'); return; }
      onSent(r.requests ?? []); setAdding(false); setUnitId(''); setWhat(''); setEstimate(''); setFiles([]); setMsg(w.asked);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card v-ask">
      {requests.length > 0 && <>
        <p className="fr-q"><Icon n="clock" /> {ic(w.waiting)}</p>
        {requests.map(r => <p key={r.id} className={r.status === 'cancelled' ? 'breach' : 'sub-n'}>
          {ic(`${r.unit ?? ''} — ${r.title.replace(/ \([^)]*'s request\)$/, '')}${r.estimate != null ? ` · $${r.estimate.toFixed(2)}` : ''} · ${r.status === 'cancelled' ? w.declined : w.pending}`)}</p>)}
      </>}
      {!adding ? <button className="fr-btn secondary" onClick={() => { setAdding(true); setMsg(''); }}>{ic(w.ask)}</button> : <div className="fr">
        <p className="fr-tip">{ic(w.askTip)}</p>
        <p className="fr-q">{ic(w.house)}</p>
        <select className="fr-select" value={unitId} onChange={e => setUnitId(e.target.value)}>
          <option value="">—</option>{houses.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
        <p className="fr-q">{ic(w.whatWork)}</p>
        <textarea className="fr-text" rows={3} maxLength={1500} value={what} onChange={e => setWhat(e.target.value)} />
        <p className="fr-q">{ic(w.estimate)}</p>
        <input className="fr-select" type="number" inputMode="decimal" min="0" step="0.01" value={estimate} onChange={e => setEstimate(e.target.value)} />
        <PhotoPicker tx={tx} files={files} onChange={setFiles} max={5} disabled={busy} />
        <button className="fr-btn fr-go" disabled={busy || !!missing} onClick={() => void go()}>{ic(busy ? w.sending : w.askSend)}</button>
        <button className="link tiny" onClick={() => setAdding(false)}>{ic(w.cancel)}</button>
        {missing && <p className="fr-missing">{ic(missing)}</p>}
      </div>}
      {msg && <p className="note" role="status">{ic(msg)}</p>}
    </div>
  );
}

/** What is coming, by day — to organise the week. A job opens in its house. No day yet: last, the team still sets it. */
function Upcoming({ w, lang, works, open }: { w: Wx; lang: Lang; works: WorkPage[]; open: (p: WorkPage) => void }) {
  const live = works.filter(p => p.work.status !== 'completed' && p.work.status !== 'cancelled');
  if (!live.length) return <div className="card"><p className="note">{ic(w.none)}</p></div>;
  const today = works[0]?.today ?? '';
  const days = new Map<string, WorkPage[]>();
  for (const p of live) days.set(p.work.scheduledOn ?? '', [...(days.get(p.work.scheduledOn ?? '') ?? []), p]);
  const order = [...days.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
  const head = (d: string) => !d ? w.noDay : d === today ? `${w.today} · ${dayLabel(lang, d)}` : d === addDays(today, 1) ? `${w.tomorrow} · ${dayLabel(lang, d)}`
    : d < today ? `${dayLabel(lang, d)} · ${w.late}` : dayLabel(lang, d);
  return <div className="v-agenda">{order.map(d => (
    <section key={d || 'none'} className="card v-day">
      <h3 className={d && d < today ? 'breach' : ''}><Icon n="calendar" /> {ic(head(d))}</h3>
      {days.get(d)!.map(p => (
        <button key={p.work.id} className="v-day-row" onClick={() => open(p)}>
          <span><b>{ic(p.work.unit ?? '—')}</b>{p.work.startTime ? ic(` · ${clock(p.work.startTime)}`) : ''}<br />{ic(p.work.title)}</span>
          <span className={p.work.accepted ? 'v-ok' : 'v-house-flag'}>{ic(p.work.accepted ? w.acceptedShort : w.toAcceptShort)}</span>
        </button>))}
    </section>))}</div>;
}

/**
 * What is done (last 90 days): what was done, the pay as on their invoice, the charges and the team's notes, and
 * whether that invoice was paid. An extra can still be added — it waits for approval like any charge; on a job whose
 * invoice is already paid it goes with the next one (the server makes it a job of its own).
 */
function Past({ w, lang, jobs, add, onAdded }: { w: Wx; lang: Lang; jobs: PastJob[];
  add: (id: string, f: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string }>; onAdded: () => void }) {
  if (!jobs.length) return <div className="card"><p className="note">{ic(w.noPast)}</p></div>;
  return <div className="v-agenda">{jobs.map(j => <PastCard key={j.id} w={w} lang={lang} j={j} add={add} onAdded={onAdded} />)}</div>;
}
function PastCard({ w, lang, j, add, onAdded }: { w: Wx; lang: Lang; j: PastJob;
  add: (id: string, f: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string }>; onAdded: () => void }) {
  const [extra, setExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const go: Go = async (f, files = []) => {
    setBusy(true); setMsg('');
    try {
      const r = await add(j.id, f, await Promise.all(files.map(shrink)));
      if (!r.ok) { setMsg(r.message ?? 'Not sent.'); return false; }
      setExtra(false); setMsg(w.extraSent); onAdded(); return true;
    } catch (e) { setMsg(String(e)); return false; } finally { setBusy(false); }
  };
  const pay = j.voidReason ? `${w.notPaid}: ${j.voidReason}` : j.pay == null ? w.noPay
    : `$${j.pay.toFixed(2)}${j.payFixed ? ` · ${w.corrected}` : ''} · ${j.paid ? w.paidOn(j.paid.at, j.paid.method === 'wise' ? w.byBank : w.byHand) : w.unpaid}`;
  return (
    <div className="card v-past">
      <p className="sub-n"><Icon n="calendar" /> {ic(dayLabel(lang, j.date))} · <Icon n="home" /> {ic(j.unit ?? '—')}</p>
      <p><b>{ic(j.title)}</b></p>
      {j.resolution && <p>{ic(`✓ ${j.resolution}`)}</p>}
      <p className={j.voidReason ? 'breach' : j.paid ? 'v-ok' : ''}><Icon n="dollar" /> {ic(pay)}</p>
      {j.flagNote && <p className="note">{ic(`${w.flag}: ${j.flagNote}`)}</p>}
      {j.charges.map(c => <p key={c.id} className={c.status === 'denied' ? 'breach' : 'sub-n'}>
        {ic(`$${c.amount.toFixed(2)} — ${c.description.replace(/ — repair #\d+.*$/, '')} · ${w.chargeState[c.status as keyof Wx['chargeState']] ?? c.status}${c.decisionNote ? ` · “${c.decisionNote}”` : ''}`)}</p>)}
      {extra ? <Charges w={w} tx={CREW_TX[lang]} charges={[]} busy={busy} go={go} start />
        : <button className="fr-btn secondary" onClick={() => { setExtra(true); setMsg(''); }}>{ic(w.addExtra)}</button>}
      {msg && <p className="note" role="status">{ic(msg)}</p>}
    </div>
  );
}

/** Their work orders by house: soonest day first; no listing last. */
function byHouse(works: WorkPage[]) {
  const m = new Map<string, { key: string; name: string; address: string | null; works: WorkPage[] }>();
  for (const p of works) {
    const key = p.work.unit ?? '—';
    const h = m.get(key) ?? { key, name: p.work.unit ?? 'No listing', address: p.address ?? null, works: [] };
    h.works.push(p); m.set(key, h);
  }
  const open = (p: WorkPage) => p.work.status !== 'completed' && p.work.status !== 'cancelled';
  return [...m.values()].map(h => {
    const days = h.works.filter(open).map(p => p.work.scheduledOn).filter((d): d is string => !!d).sort();
    return { ...h, day: days[0] ?? null, toAccept: h.works.filter(p => open(p) && !p.work.accepted).length };
  }).sort((a, b) => (a.key === '—' ? 1 : 0) - (b.key === '—' ? 1 : 0) || (a.day ?? '9999').localeCompare(b.day ?? '9999') || a.name.localeCompare(b.name));
}

/** Swipe sideways, one at a time; arrows and "2 of 5" for a mouse and for knowing where you are. */
function Carousel({ children, label, of, wide = false, start = 0 }: { children: ReactNode[]; label: string; of: (i: number, n: number) => string; wide?: boolean; start?: number }) {
  const rail = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const n = children.length;
  const go = (i: number, behavior: ScrollBehavior = 'smooth') => { const r = rail.current; const el = r?.children[Math.max(0, Math.min(n - 1, i))] as HTMLElement | undefined; if (r && el) r.scrollTo({ left: el.offsetLeft - r.offsetLeft - (r.clientWidth - el.clientWidth) / 2, behavior }); };
  // Opened on one job (from Upcoming): that one in sight.
  useEffect(() => { if (start > 0) go(start, 'auto'); }, []);
  const onScroll = () => { const r = rail.current; if (!r) return; const kids = [...r.children] as HTMLElement[];
    const mid = r.scrollLeft + r.clientWidth / 2 + r.offsetLeft;
    setAt(kids.reduce((best, k, i) => Math.abs(k.offsetLeft + k.clientWidth / 2 - mid) < Math.abs(kids[best]!.offsetLeft + kids[best]!.clientWidth / 2 - mid) ? i : best, 0)); };
  const pager = n > 1 && <div className="v-pager">
    <button className="chip" disabled={at === 0} onClick={() => go(at - 1)} aria-label="Previous">‹</button>
    <span className="v-dots" aria-live="polite">{ic(of(at + 1, n))}</span>
    <button className="chip" disabled={at >= n - 1} onClick={() => go(at + 1)} aria-label="Next">›</button>
  </div>;
  // Jobs are long and of different heights: their pager goes on top, where it stays in sight.
  return (
    <section className={`v-carousel ${wide ? 'wide' : ''}`} aria-roledescription="carousel" aria-label={label}>
      {wide && pager}
      <div className="v-rail" ref={rail} onScroll={onScroll}>{children.map((c, i) => <div key={i} className="v-slide" aria-label={of(i + 1, n)}>{c}</div>)}</div>
      {!wide && pager}
    </section>
  );
}

function WorkCard({ page, lang, send, onPage, photo }: { page: WorkPage; lang: Lang; send: Send; onPage: (p: WorkPage) => void; photo?: Photo }) {
  const w = W[lang];
  const tx = CREW_TX[lang];
  const p = page.work;
  const closed = p.status === 'completed' || p.status === 'cancelled';
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const go = async (fields: Record<string, string>, files: File[] = []) => {
    setBusy(true); setMsg('');
    try {
      const r = await send(fields, await Promise.all(files.map(shrink)));
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
      if (r.page) onPage(r.page);
      return true;
    } catch (e) { setMsg(String(e)); return false; } finally { setBusy(false); }
  };
  return (
    <div className="card work-card">
      <p className="clean-card-unit"><Icon n="wrench" /> {ic(p.title)}</p>
      {p.unit && <p><Icon n="home" /> <b>{ic(p.unit)}</b>{page.address && <> · <a href={`https://maps.google.com/?q=${encodeURIComponent(page.address)}`} target="_blank" rel="noreferrer"><Icon n="pin" /> {ic(page.address)}</a></>}</p>}
      <p className="fr-q"><Icon n="calendar" /> {ic(p.scheduledOn ? `${w.day}: ${dayLabel(lang, p.scheduledOn)}${p.startTime ? ` ${w.at} ${clock(p.startTime)}` : ''}` : w.noDay)}</p>
      {page.access && <AccessBox tx={tx} a={page.access} />}
      {p.description && <details open><summary><b>{ic(w.what)}</b></summary><WhatToFix id={p.id} text={p.description} photo={photo} /></details>}
      {closed ? <p className="fr-done-line">{ic(p.resolution ? w.done(p.resolution) : w.closed)}</p> : <>
        <Step n={1} title={w.s1} sub={p.accepted ? w.accepted : w.notYet} open={!p.accepted}>
          {p.accepted ? <p className="field-ok">{ic(w.accepted)}</p> : <Accept w={w} busy={busy} go={go} />}
        </Step>
        <Step n={2} title={w.s2} sub={w.photos(page.photos.before)}><Photos w={w} tx={tx} stage="before" go={go} /></Step>
        <Step n={3} title={w.s3} sub={w.photos(page.photos.after)}><Photos w={w} tx={tx} stage="after" go={go} /></Step>
        <Step n={4} title={w.s4} sub={w.charges(page.charges.length, page.charges.filter(c => c.status === 'pending').length)}><Charges w={w} tx={tx} charges={page.charges} busy={busy} go={go} /></Step>
        <Step n={5} title={w.s5}><Done w={w} busy={busy} go={go} /></Step>
        <Note w={w} busy={busy} go={go} />
      </>}
      {msg && <p className="breach" role="alert">{ic(msg)}</p>}
    </div>
  );
}

/** A numbered step, folded until tapped — the first one open until the day is accepted. */
function Step({ n, title, sub, open: first = false, children }: { n: number; title: string; sub?: string; open?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(first);
  return (
    <div className="work-step">
      <button className="fr-btn fr-choice fr-stepbtn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="fr-num">{n}</span><span>{ic(title)}{sub && <small>{ic(sub)}</small>}</span></button>
      {open && <div className="work-step-body">{children}</div>}
    </div>
  );
}

type Go = (fields: Record<string, string>, files?: File[]) => Promise<boolean>;

function Accept({ w, busy, go }: { w: Wx; busy: boolean; go: Go }) {
  const [cant, setCant] = useState(false);
  const [why, setWhy] = useState('');
  if (cant) return (
    <div className="fr">
      <textarea className="fr-text" rows={2} maxLength={300} placeholder={w.why} value={why} onChange={e => setWhy(e.target.value)} />
      <p className="fr-tip">{ic(w.cantNote)}</p>
      <button className="fr-btn" disabled={busy} onClick={() => void go({ action: 'cant', reason: why })}>{ic(busy ? w.sending : w.cantSend)}</button>
      <button className="fr-btn secondary" onClick={() => setCant(false)}>←</button>
    </div>
  );
  return (
    <div className="fr">
      <button className="fr-btn fr-go" disabled={busy} onClick={() => void go({ action: 'accept' })}>{ic(busy ? w.sending : w.accept)}</button>
      <button className="fr-btn secondary" disabled={busy} onClick={() => setCant(true)}>{ic(w.cant)}</button>
    </div>
  );
}

function Photos({ w, tx, stage, go }: { w: Wx; tx: Tx; stage: 'before' | 'after'; go: Go }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const upload = async () => {
    setBusy(true);
    const left = [...files];
    while (left.length) {
      setSent(files.length - left.length + 1);
      if (!(await go({ action: 'photo', stage }, [left[0]!]))) break;
      left.shift();
    }
    setFiles(left); setBusy(false); setSent(0);
  };
  return (
    <div className="fr">
      <PhotoPicker tx={tx} files={files} onChange={setFiles} disabled={busy} />
      <button className="fr-btn fr-go" disabled={busy || !files.length} onClick={() => void upload()}>
        {ic(busy ? `${w.sending} ${sent}/${files.length}` : w.sendPhotos(files.length))}</button>
    </div>
  );
}

function Charges({ w, tx, charges, busy, go, start }: { w: Wx; tx: Tx; charges: WorkPage['charges']; busy: boolean; go: Go; start?: boolean }) {
  const [adding, setAdding] = useState(start ?? !charges.length);
  const [kind, setKind] = useState<'labor' | 'materials'>('labor');
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const missing = !(Number(amount) > 0) ? w.needAmount : !what.trim() ? w.needWhat : '';
  return (
    <div className="fr">
      <p className="fr-tip">{ic(w.s4note)}</p>
      {charges.map(c => <p key={c.id} className={c.status === 'denied' ? 'breach' : 'sub-n'}>
        ${ic(c.amount.toFixed(2))} — {ic(c.description.replace(/ — repair #\d+.*$/, ''))} · {ic(w.chargeState[c.status])}{ic(c.decisionNote ? ` · “${c.decisionNote}”` : '')}</p>)}
      {!adding ? <button className="fr-btn secondary" onClick={() => setAdding(true)}>{ic(w.addCharge)}</button> : <>
        <div className="report-tabs">
          <button className={kind === 'labor' ? 'on' : ''} onClick={() => setKind('labor')}>{ic(w.labor)}</button>
          <button className={kind === 'materials' ? 'on' : ''} onClick={() => setKind('materials')}>{ic(w.materials)}</button>
        </div>
        <p className="fr-q">{ic(w.amount)}</p>
        <input className="fr-select" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
        <p className="fr-q">{ic(w.forWhat)}</p>
        <input className="fr-select" value={what} maxLength={200} onChange={e => setWhat(e.target.value)} />
        <p className="fr-q">{ic(w.receipt)}</p>
        <PhotoPicker tx={tx} files={files} onChange={setFiles} max={5} disabled={busy} />
        <button className="fr-btn fr-go" disabled={busy || !!missing} onClick={async () => {
          if (await go({ action: 'charge', kind, amount, description: what.trim() }, files)) { setAmount(''); setWhat(''); setFiles([]); setAdding(false); }
        }}>{ic(busy ? w.sending : w.send)}</button>
        {missing && <p className="fr-missing">{ic(missing)}</p>}
      </>}
    </div>
  );
}

function Done({ w, busy, go }: { w: Wx; busy: boolean; go: Go }) {
  const [text, setText] = useState('');
  return (
    <div className="fr">
      <p className="fr-q">{ic(w.doneQ)}</p>
      <textarea className="fr-text" rows={3} maxLength={1500} value={text} onChange={e => setText(e.target.value)} />
      <button className="fr-btn fr-go" disabled={busy || !text.trim()} onClick={() => void go({ action: 'done', text: text.trim() })}>{ic(busy ? w.sending : w.markDone)}</button>
      {!text.trim() && <p className="fr-missing">{ic(w.needDone)}</p>}
    </div>
  );
}

function Note({ w, busy, go }: { w: Wx; busy: boolean; go: Go }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <details className="work-note">
      <summary><b>{ic(w.note)}</b></summary>
      <div className="fr">
        <textarea className="fr-text" rows={3} maxLength={1500} value={text} onChange={e => { setText(e.target.value); setSent(false); }} />
        <button className="fr-btn" disabled={busy || !text.trim()} onClick={async () => { if (await go({ action: 'note', text: text.trim() })) { setText(''); setSent(true); } }}>
          {ic(busy ? w.sending : w.noteSend)}</button>
        {sent && <p className="field-ok">{ic(w.sent)}</p>}
      </div>
    </details>
  );
}

/** The handyman's pay (owner, 2026-10-25): the invoice periods, each job's pay and the team's notes, and whether it was paid. */
function VendorPay({ pay, lang, onPeriod }: { pay: VendorPage; lang: Lang; onPeriod: (from: string) => void }) {
  const w = W[lang];
  const inv = pay.invoice;
  const notes = pay.jobs.filter(j => j.flagNote || j.payNote);
  return <>
    <div className="card">
      <label>{ic(w.payPeriod)}
        <select value={pay.period.from} onChange={e => onPeriod(e.target.value)}>
          {pay.periods.map(p => <option key={p.from} value={p.from}>{lang === 'es' ? `${p.from} – ${p.to}` : p.label}</option>)}
        </select></label>
      <p><b>{ic(w.jobs(inv.lines.length, money2(inv.total)))}</b></p>
      <p className="note">{ic(pay.payout ? w.paidOn(pay.payout.at.slice(0, 10), pay.payout.method === 'wise' ? w.byBank : w.byHand) : w.unpaid)}</p>
      {notes.map(j => (
        <div key={j.id} className="sub-n">
          {ic(j.title)}: {j.flagNote && <span className="breach">{ic(`${w.flag}: ${j.flagNote}`)}</span>}
          {j.payNote && j.payNote !== j.flagNote && <> {ic(`${w.corrected}: ${j.payNote}`)}</>}
        </div>
      ))}
    </div>
    <VendorInvoiceView page={pay} labels={lang === 'es' ? ES_INVOICE : undefined} />
  </>;
}

const ES_INVOICE: Partial<typeof EN> = {
  invoice: 'Factura', from: 'De', to: 'Para', period: 'Periodo', paid: 'Pago', print: 'Imprimir / PDF', date: 'Fecha', unit: 'Propiedad',
  work: 'Trabajo', amount: 'Monto', notPriced: 'sin precio', none: 'No hay trabajos pagados en este periodo.', total: 'Total',
  open: 'El periodo sigue abierto — se suman los trabajos terminados antes de que cierre.',
  unpriced: (n: number) => `${n} trabajo${n === 1 ? '' : 's'} aún sin precio — fuera del total.`,
  pending: (n: number) => `${n} cobro${n === 1 ? '' : 's'} esperando aprobación del equipo.`,
  notPaidIn: 'No pagado en este periodo:'
};
