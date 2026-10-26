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
import { useEffect, useState } from 'react';
import { getVendorWork, getWorkLink, vendorAct, workLinkAct, type VendorPage, type WorkPage } from '../api.ts';
import { EN, VendorInvoiceView } from './Handymen.tsx';
import { money2 } from '../lib/format.ts';
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
    tabWork: 'Work orders', tabPay: 'Pay', payPeriod: 'Period', jobs: (n: number, t: string) => `${n} job${n === 1 ? '' : 's'} paid · ${t}`,
    flag: 'Note from the team', corrected: 'Pay corrected', notPaid: 'Not paid', paidOn: (d: string, how: string) => `Paid ${d} ${how}`,
    byStripe: 'to your bank (Stripe)', byHand: 'by hand', unpaid: 'Not paid yet'
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
    tabWork: 'Órdenes', tabPay: 'Pago', payPeriod: 'Periodo', jobs: (n: number, t: string) => `${n} trabajo${n === 1 ? '' : 's'} pagado${n === 1 ? '' : 's'} · ${t}`,
    flag: 'Nota del equipo', corrected: 'Pago corregido', notPaid: 'No pagado', paidOn: (d: string, how: string) => `Pagado ${d} ${how}`,
    byStripe: 'a tu banco (Stripe)', byHand: 'en mano', unpaid: 'Aún no pagado'
  }
};
type Wx = typeof W.en;
type Send = (fields: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string; page?: WorkPage }>;

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
        : <WorkCard page={page} lang={lang} send={practice?.send ?? ((f, files) => workLinkAct(token, f, files))} onPage={setPage} />}
    </div>
  </>;
}

/** The account door: a handyman signed in sees their work orders. */
export function VendorHome({ practice, token }: { practice?: { vendor: string; works: WorkPage[]; send: (id: string, fields: Record<string, string>, files: File[]) => ReturnType<Send> }; token?: string } = {}) {
  const [lang, setLang] = useLang();
  const [data, setData] = useState<{ vendor: string; works: WorkPage[]; pay?: VendorPage | null } | null>(practice ? { vendor: practice.vendor, works: practice.works } : null);
  const [err, setErr] = useState('');
  const [sec, setSec] = useState<'work' | 'pay'>('work');
  // The phone's back gesture steps back through the sections instead of leaving the page (useUrlState.ts).
  useUrlState('sec', sec, setSec, { def: 'work', valid: v => v === 'work' || v === 'pay' });
  const [period, setPeriod] = useState<string | null>(null);
  const load = () => getVendorWork(period, token).then(r => r.ok ? setData(r) : setErr(r.message ?? 'Could not load.')).catch(e => setErr(String(e)));
  useEffect(() => { if (!practice) void load(); }, [period]);
  const w = W[lang];
  return <>
    <Head title={data ? w.hello(data.vendor) : 'Kaizen'} lang={lang} setLang={setLang} />
    {/* Owner, 2026-10-25: their pay, as a cleaner sees theirs. */}
    {data?.pay && <div className="crew-secs no-print" role="tablist">
      {(['work', 'pay'] as const).map(k => <button key={k} role="tab" aria-selected={sec === k} className={sec === k ? 'on' : ''} onClick={() => setSec(k)}>
        {ic(k === 'work' ? w.tabWork : w.tabPay)}</button>)}
    </div>}
    <div className="report-page">
      {err ? <p className="banner error">{ic(err)}</p> : !data ? <p className="note loading-dot">…</p>
        : sec === 'pay' && data.pay ? <VendorPay pay={data.pay} lang={lang} onPeriod={setPeriod} />
        : !data.works.length ? <div className="card"><p className="note">{ic(w.none)}</p></div>
        : data.works.map(p => <WorkCard key={p.work.id} page={p} lang={lang}
            send={(f, files) => practice ? practice.send(p.work.id, f, files) : vendorAct(p.work.id, f, files, token)}
            onPage={np => setData(d => d && { ...d, works: d.works.map(x => x.work.id === np.work.id ? np : x) })} />)}
    </div>
  </>;
}

function WorkCard({ page, lang, send, onPage }: { page: WorkPage; lang: Lang; send: Send; onPage: (p: WorkPage) => void }) {
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
      {p.description && <details><summary><b>{ic(w.what)}</b></summary><p className="note" style={{ whiteSpace: 'pre-wrap' }}>{ic(p.description)}</p></details>}
      {closed ? <p className="fr-done-line">{ic(p.resolution ? w.done(p.resolution) : w.closed)}</p> : <>
        <Step n={1} title={w.s1} sub={p.accepted ? w.accepted : w.notYet} open={!p.accepted}>
          {p.accepted ? <p className="field-ok">{ic(w.accepted)}</p> : <Accept w={w} busy={busy} go={go} />}
        </Step>
        <Step n={2} title={w.s2} sub={w.photos(page.photos.before)}><Photos w={w} tx={tx} stage="before" go={go} /></Step>
        <Step n={3} title={w.s3} sub={w.photos(page.photos.after)}><Photos w={w} tx={tx} stage="after" go={go} /></Step>
        <Step n={4} title={w.s4} sub={w.charges(page.charges.length, page.charges.filter(c => c.status === 'pending').length)}><Charges w={w} tx={tx} page={page} busy={busy} go={go} /></Step>
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

function Charges({ w, tx, page, busy, go }: { w: Wx; tx: Tx; page: WorkPage; busy: boolean; go: Go }) {
  const [adding, setAdding] = useState(!page.charges.length);
  const [kind, setKind] = useState<'labor' | 'materials'>('labor');
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const missing = !(Number(amount) > 0) ? w.needAmount : !what.trim() ? w.needWhat : '';
  return (
    <div className="fr">
      <p className="fr-tip">{ic(w.s4note)}</p>
      {page.charges.map(c => <p key={c.id} className={c.status === 'denied' ? 'breach' : 'sub-n'}>
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
      <p className="note">{ic(pay.payout ? w.paidOn(pay.payout.at.slice(0, 10), pay.payout.method === 'stripe' ? w.byStripe : w.byHand) : w.unpaid)}</p>
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
