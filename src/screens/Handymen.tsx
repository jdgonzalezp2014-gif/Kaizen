/**
 * Operations → Handymen (owner, 2026-10-25): a handyman's page for the team,
 * as Operations → Cleaners is a cleaner's. Their work orders in any dates,
 * each job's pay and charges, the invoice of the period, and the team's
 * edits — the ones a clean has: ⚑ flag (with a deduction or a pay typed
 * instead), ✎ correct the pay, ○ not paid, + add a job — then the payment.
 * A job = a work order with their name; its pay = the work order's cost.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { getUnits, getVendorAdmin, vendorAdminAction, vendorPageLink, vendorSlackChannel, type VendorInfo, type VendorPage } from '../api.ts';
import type { VendorJob } from '../lib/vendor-pay.ts';
import { VENDOR_VOID } from '../lib/vendor-pay.ts';
import { addDays } from '../lib/dates.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from '../components/Hint.tsx';
import { Icon, ic } from '../components/Icon.tsx';
import { PayoutCard } from '../components/PayoutCard.tsx';
import { ChargeDecide, WorkPhotos } from '../components/WorkProof.tsx';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const STATUS: Record<string, string> = { pending: 'New', confirmed: 'Accepted', in_progress: 'In progress', completed: 'Done' };
/** Same caps as the server's (functions/_lib/vendor-pay.ts). */
const CUSTOM_MAX_DAYS = 92, CUSTOM_AHEAD = 30;
const RANGE_PRESETS: [string, number][] = [['Last 7 days', 6], ['Last 30 days', 29]];
type Res = { ok: boolean; message?: string };

export function VendorAdmin({ canEdit, canPay }: { canEdit: boolean; canPay: boolean }) {
  const [name, setName] = useState('');
  const [period, setPeriod] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [vendors, setVendors] = useState<(VendorInfo & { open: number; done: number })[]>([]);
  const [page, setPage] = useState<VendorPage | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [slack, setSlack] = useState<Record<string, string>>({});
  const seq = useRef(0);
  // The same bar as Operations → Cleaners: what is on screen stays under it until the answer comes. No Hostaway here
  // (only the database, ~0.5 s), so no fast first answer is needed; a later answer never overwrites a newer one.
  const load = () => {
    const n = ++seq.current;
    setLoading(true);
    return getVendorAdmin(name || null, period, to)
      .then(r => { if (n !== seq.current) return; if (r.ok) { setVendors(r.vendors); setPage(r.page); setSlack(r.slack ?? {}); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
      .catch(e => { if (n === seq.current) setErr(String(e)); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  };
  useEffect(() => { void load(); }, [name, period, to]);
  const pick = (from: string | null, until: string | null = null) => { setPeriod(from); setTo(until); };
  const shown = page && page.vendor.name.toLowerCase() === name.toLowerCase() ? page : null;

  return (
    <>
      {err && <p className="banner error">{ic(err)}</p>}
      {loading && <div className="load-note" role="status"><div className="load-bar" />Loading…</div>}
      <div className="row-controls">
        <label>A handyman's work and pay
          <select value={name} onChange={e => { setName(e.target.value); pick(null); setAdding(false); }}>
            <option value="">Choose…</option>
            {vendors.map(v => <option key={v.name} value={v.name}>{v.name}{v.trade ? ` — ${v.trade}` : ''}
              {v.inDirectory ? (v.active ? '' : ' (off)') : ' (not in the directory)'}{v.open ? ` · ${v.open} open` : ''}</option>)}
          </select></label>
        {shown && <label>Invoice
          <select value={shown.vendor.invoicePeriod} disabled={!canEdit}
                  onChange={e => void vendorAdminAction({ action: 'invoicePeriod', vendor: shown.vendor.name, period: e.target.value })
                    .then(r => { if (r.ok) { if (period === null && to === null) void load(); else pick(null); } else setErr(r.message ?? 'Could not save.'); })
                    .catch(x => setErr(String(x)))}>
            <option value="weekly">weekly (Sat–Fri, paid Saturday)</option>
            <option value="monthly">monthly (paid early the next month)</option>
          </select></label>}
        {shown && canEdit && !adding && <button className="chip" onClick={() => setAdding(true)}>+ Add a job</button>}
        {shown && canEdit && <PageLink vendor={shown.vendor.name} />}
        {shown && canEdit && <SlackChannel vendor={shown.vendor.name} channel={slack[shown.vendor.name] ?? null} onMade={() => void load()} />}
        <Hint label="Handymen">Everyone with work orders: the vendor directory (Setup → Inspections, Vendors & handymen) and names only typed on a work order.
          A job is a work order with their name; it is on the invoice of the period in which it was done, and it pays the work order's cost — the
          charges the handyman sent and the team approved, or what the team typed. Picking an invoice period for a name not in the directory adds it there.</Hint>
      </div>
      {!name && <p className="note">Choose a handyman to see their jobs, invoice and payment.</p>}
      {adding && shown && <AddJob vendor={shown.vendor.name} today={shown.today} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); void load(); }} />}
      {shown && <>
        <PeriodPick page={shown} onPeriod={p => pick(p)} onRange={pick} />
        {shown.openJobs.length > 0 && (
          <div className="card">
            <h2>Open work orders <span className="chan-tag">{shown.openJobs.length}</span> <Hint>Not done yet, whatever their day. They reach the invoice
              of the period in which they are completed. Work them in Operations → To-do.</Hint></h2>
            <div className="crew-list">
              {shown.openJobs.map(j => (
                <div key={j.id} className="crew-row">
                  <div><b>{ic(j.title)}</b> <span className="sub-n">#{j.id}</span><div className="sub-n">{ic(j.unit ?? 'no listing')} · {ic(day(j.date))}</div></div>
                  <div>{ic(STATUS[j.status] ?? j.status)}{j.charges.some(c => c.status === 'pending') && <div className="note">{ic(`${j.charges.filter(c => c.status === 'pending').length} charge(s) waiting`)}</div>}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <Jobs page={shown} canEdit={canEdit} reload={load} />
        <VendorInvoiceView page={shown} />
        {!shown.period.custom && (
          <PayoutCard kind="vendor" payee={shown.vendor.name} today={shown.today} canPay={canPay} onChanged={load} payout={shown.payout}
                      invoice={{ number: shown.invoice.number, period: shown.invoice.period, open: shown.invoice.open, total: shown.invoice.total,
                                 unpriced: shown.invoice.unpriced, pending: shown.invoice.pendingCharges }} />
        )}
      </>}
    </>
  );
}

/** The invoice periods as presets; any other span to review (pay never moves: each job is paid with its period). */
function PeriodPick({ page, onPeriod, onRange }: { page: VendorPage; onPeriod: (from: string) => void; onRange: (from: string, to: string) => void }) {
  const { period, today } = page;
  return (
    <div className="card no-print"><div className="row-controls">
      <label>Period
        <select value={period.custom ? '' : period.from} onChange={e => { if (e.target.value) onPeriod(e.target.value); }}>
          {period.custom && <option value="">{period.label} (dates picked)</option>}
          {page.periods.map(p => <option key={p.from} value={p.from}>{p.label}</option>)}
        </select></label>
      {RANGE_PRESETS.map(([label, days]) => {
        const from = addDays(today, -days);
        return <button key={label} className={period.custom && period.from === from && period.to === today ? 'chip active' : 'chip'}
                       onClick={() => onRange(from, today)}>{label}</button>;
      })}
      <input type="date" className="date-in" title="From" value={period.from} max={period.to}
             onChange={e => { const v = e.target.value; if (v) onRange(v, v > period.to ? v : addDays(v, CUSTOM_MAX_DAYS) < period.to ? addDays(v, CUSTOM_MAX_DAYS) : period.to); }} />
      <span className="note">to</span>
      <input type="date" className="date-in" title={`To — up to ${CUSTOM_MAX_DAYS} days after the first`} value={period.to} min={period.from} max={addDays(today, CUSTOM_AHEAD)}
             onChange={e => { const v = e.target.value && (e.target.value > addDays(today, CUSTOM_AHEAD) ? addDays(today, CUSTOM_AHEAD) : e.target.value);
               if (v) onRange(v < period.from ? v : addDays(v, -CUSTOM_MAX_DAYS) > period.from ? addDays(v, -CUSTOM_MAX_DAYS) : period.from, v); }} />
      <Hint label="Dates">The invoice periods are the presets; any other dates show the jobs in them (up to {CUSTOM_MAX_DAYS} days) — with no payment,
        since each job is paid with the invoice period it falls in.</Hint>
    </div></div>
  );
}

function Jobs({ page, canEdit, reload }: { page: VendorPage; canEdit: boolean; reload: () => void }) {
  const inv = page.invoice;
  const flagged = page.jobs.filter(j => j.flagNote).length;
  return (
    <div className="card no-print">
      <h2>Jobs — {ic(page.period.label)}
        {canEdit && <> <Hint label="Editing jobs">⚑ Flag: a note the handyman reads — on a job done, with a deduction or a pay typed instead.
          ✎ Correct: the job's pay by hand (blank = back to the approved charges). ○ Not paid: takes a job done off the pay and out of Costs (a repair
          charged to the owner also leaves the owner's Hostaway statement), with the reason the handyman reads; it can be put back. Charges waiting are
          approved or denied on the job. + Add a job: work done that has no work order. Everything is a line in the work order's activity.</Hint></>}</h2>
      <p className="note">
        {ic(`${inv.lines.length} paid · ${money2(inv.total)}${inv.open ? ' so far' : ''}`)}
        {inv.excluded.length > 0 && <> · {ic(`${inv.excluded.length} not paid`)}</>}
        {flagged > 0 && <> · <span className="breach">{ic(`${flagged} flagged`)}</span></>}
        {inv.pendingCharges > 0 && <> · {ic(`${inv.pendingCharges} charge(s) waiting`)}</>}
      </p>
      {!page.jobs.length ? <p className="note">No jobs in these dates.</p> : (
        <div className="crew-list">{page.jobs.map(j => <JobRow key={j.id} j={j} canEdit={canEdit} reload={reload} />)}</div>
      )}
    </div>
  );
}

function JobRow({ j, canEdit, reload }: { j: VendorJob; canEdit: boolean; reload: () => void }) {
  const [form, setForm] = useState<'' | 'flag' | 'correct' | 'void'>('');
  const [text, setText] = useState('');
  const [how, setHow] = useState<'none' | 'deduct' | 'pay'>('none');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const done = j.status === 'completed';
  const send = async (body: Record<string, unknown>, act: (b: Record<string, unknown>) => Promise<Res> = vendorAdminAction) => {
    setBusy(true); setMsg('');
    const r = await act(body).catch(e => ({ ok: false, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    setForm(''); setText(''); setAmount(''); setHow('none'); reload();
  };
  const open = (f: typeof form) => { setForm(f); setText(''); setMsg(''); setHow('none'); setAmount(f === 'correct' && j.pay != null ? String(j.pay) : ''); };

  return (
    <div className="crew-row">
      <div><b>{ic(day(j.date))}</b> · {ic(j.unit ?? 'no listing')}<div className="sub-n">{ic(j.title)} · #{j.id}{j.chargeOwner ? ' · charged to the owner' : ''}</div></div>
      <div>
        {j.voidReason ? <span className="note">{ic(`Not paid — ${j.voidReason.replace(VENDOR_VOID, '')}`)}</span>
          : !done ? <span className="note">{ic(`${STATUS[j.status] ?? j.status} — on the pay once done`)}</span>
          : <span><Icon n="done" /> {ic(j.pay == null ? 'not priced' : money2(j.pay))}{j.payFixed && <span className="sub-n"> · set by hand</span>}</span>}
        {j.flagNote && <div className="breach"><Icon n="alert" /> {ic(j.flagNote)}</div>}
        {j.payNote && <div className="sub-n">{ic(`Corrected: ${j.payNote}`)}</div>}
        {/* Owner, 2026-10-28: the photos, to audit the job where its pay is. */}
        {j.photos && j.photos.length > 0 && (
          <details className="crew-extra">
            <summary><Icon n="image" /> {ic(`${j.photos.length} photo${j.photos.length === 1 ? '' : 's'}`)}</summary>
            <WorkPhotos photos={j.photos} />
          </details>
        )}
        {j.charges.map(c => (
          <details key={c.id} className={`crew-extra ${c.status}`}>
            <summary title={c.description}>Charge {ic(money2(c.amount))} · {ic(c.status === 'pending' ? 'waiting' : c.status)}{c.photos.length > 0 && <> <Icon n="clip" /></>}</summary>
            <div className="sub-n">{ic(c.description)}{c.decisionNote && <> · “{ic(c.decisionNote)}”</>}</div>
            {c.photos.map((p, i) => <a key={i} className="link tiny" href={p.url} target="_blank" rel="noreferrer">{ic(p.name)}</a>)}
            {!c.photos.length && <span className="breach"> no receipt</span>}
            {canEdit && c.status === 'pending' && <ChargeDecide id={c.id} onDone={reload} />}
          </details>
        ))}
      </div>
      {canEdit && <div className="crew-actions no-print">
        {done && form !== 'correct' && <button className="link tiny" onClick={() => open('correct')}>✎ Correct</button>}
        {done && form !== 'void' && (j.voidReason
          ? <button className="link tiny" disabled={busy} onClick={() => void send({ action: 'restorePaid', id: j.id })}>Put back on the pay</button>
          : <button className="link tiny" onClick={() => open('void')}>○ Not paid…</button>)}
        {j.flagNote ? <button className="link tiny" disabled={busy} onClick={() => void send({ action: 'unflag', id: j.id })}>Remove flag</button>
          : form !== 'flag' && <button className="link tiny" onClick={() => open('flag')}>⚑ Flag…</button>}
      </div>}
      {form === 'flag' && (
        <div className="crew-decide">
          <input value={text} maxLength={500} placeholder="What the handyman reads" onChange={e => setText(e.target.value)} />
          {done && <select value={how} onChange={e => setHow(e.target.value as typeof how)}>
            <option value="none">pay unchanged</option><option value="deduct">deduct $</option><option value="pay">pay instead $</option></select>}
          {how !== 'none' && <input className="amt" inputMode="decimal" value={amount} placeholder="$" onChange={e => setAmount(e.target.value)} />}
          <button className="small" disabled={busy || !text.trim() || (how !== 'none' && amount === '')}
                  onClick={() => void send({ action: 'flag', id: j.id, note: text, how, value: amount })}>Flag</button>
          <button className="small secondary" onClick={() => setForm('')}>Cancel</button>
        </div>
      )}
      {form === 'correct' && (
        <div className="crew-decide">
          <input className="amt" inputMode="decimal" value={amount} placeholder="charges" onChange={e => setAmount(e.target.value)} />
          <input value={text} maxLength={500} placeholder="Why (the handyman reads it)" onChange={e => setText(e.target.value)} />
          <button className="small" disabled={busy || (amount !== '' && !text.trim())}
                  onClick={() => void send({ action: 'correct', id: j.id, pay: amount, note: text })}>Save pay</button>
          <button className="small secondary" onClick={() => setForm('')}>Cancel</button>
          <span className="note">Blank = the approved charges.</span>
        </div>
      )}
      {form === 'void' && (
        <div className="crew-decide">
          <input value={text} maxLength={480} placeholder="Why it is not paid (the handyman reads it)" onChange={e => setText(e.target.value)} />
          <button className="small" disabled={busy || !text.trim()} onClick={() => void send({ action: 'notPaid', id: j.id, note: text })}>Take off the pay</button>
          <button className="small secondary" onClick={() => setForm('')}>Cancel</button>
        </div>
      )}
      {msg && <div className="breach">{ic(msg)}</div>}
    </div>
  );
}

function AddJob({ vendor, today, onDone, onCancel }: { vendor: string; today: string; onDone: () => void; onCancel: () => void }) {
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [date, setDate] = useState(today);
  const [unitId, setUnitId] = useState('');
  const [title, setTitle] = useState('');
  const [pay, setPay] = useState('');
  const [owner, setOwner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { void getUnits().then(r => setUnits((r.units ?? []).filter(u => u.active).map(u => ({ id: u.id, name: u.name })))).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true); setMsg('');
    const r = await vendorAdminAction({ action: 'addJob', vendor, date, unitId: unitId || null, title, pay, chargeOwner: owner })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    onDone();
  };
  return (
    <div className="card">
      <h2>Add a job for {ic(vendor)} <Hint>Work already done that has no work order: it becomes a completed work order with this vendor and pay
        (in Costs as Repairs, or on the owner's statement when charged to the owner). It is not sent to Hostaway as a task.</Hint></h2>
      <div className="crew-decide">
        <input type="date" value={date} max={today} onChange={e => setDate(e.target.value)} />
        <select value={unitId} onChange={e => { setUnitId(e.target.value); if (!e.target.value) setOwner(false); }}>
          <option value="">No listing (portfolio)</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input value={title} maxLength={300} placeholder="What was done" onChange={e => setTitle(e.target.value)} />
        <input className="amt" inputMode="decimal" value={pay} placeholder="$ pay" onChange={e => setPay(e.target.value)} />
        <label className="check inline"><input type="checkbox" checked={owner} disabled={!unitId} onChange={e => setOwner(e.target.checked)} /> charge to the owner</label>
        <button className="small" disabled={busy || !title.trim() || pay === '' || !date} onClick={() => void save()}>Add the job</button>
        <button className="small secondary" onClick={onCancel}>Cancel</button>
      </div>
      {msg && <p className="breach">{ic(msg)}</p>}
    </div>
  );
}

/** The vendor's invoice — printed or saved as PDF from the browser. */
export function VendorInvoiceView({ page, labels }: { page: VendorPage; labels?: Partial<typeof EN> }) {
  const t = { ...EN, ...labels };
  const inv = page.invoice;
  return (
    <div className="card crew-invoice">
      <div className="crew-invoice-head">
        <div><h2>{ic(t.invoice)} {ic(inv.number)}</h2>
          <div>{ic(t.from)}: <b>{ic(page.vendor.name)}</b></div>
          <div>{ic(t.to)}: <b>Kaizen Guest Properties</b></div>
          <div>{ic(t.period)}: {ic(inv.period.label)} ({ic(inv.period.from)} – {ic(inv.period.to)})</div>
          {!inv.period.custom && <div>{ic(t.paid)}: <b>{ic(page.payout ? `${page.payout.at.slice(0, 10)}` : inv.period.payNote)}</b></div>}</div>
        <button className="secondary no-print" onClick={() => window.print()}>{ic(t.print)}</button>
      </div>
      {inv.period.custom && <p className="note">{ic(t.custom)}</p>}
      {inv.open && <p className="note">{ic(t.open)}</p>}
      <table className="units compact">
        <thead><tr><th>{ic(t.date)}</th><th>{ic(t.unit)}</th><th>{ic(t.work)}</th><th className="n">{ic(t.amount)}</th></tr></thead>
        <tbody>
          {inv.lines.map(l => (
            <Fragment key={l.id}>
              <tr><td>{ic(l.date)}</td><td>{ic(l.unit ?? '—')}</td><td>{ic(l.title)} <span className="sub-n">#{l.id}</span>{l.flag ? <> <Icon n="alert" /></> : null}</td>
                <td className="n">{l.amount == null ? <span className="note">{ic(t.notPriced)}</span> : money2(l.amount)}</td></tr>
            </Fragment>
          ))}
          {!inv.lines.length && <tr><td colSpan={4} className="note">{ic(t.none)}</td></tr>}
        </tbody>
        <tfoot><tr><td colSpan={3}><b>{ic(t.total)}</b></td><td className="n"><b>{ic(money2(inv.total))}</b></td></tr></tfoot>
      </table>
      {inv.unpriced > 0 && <p className="breach">{ic(t.unpriced(inv.unpriced))}</p>}
      {inv.pendingCharges > 0 && <p className="note">{ic(t.pending(inv.pendingCharges))}</p>}
      {inv.excluded.length > 0 && (
        <div className="note">{ic(t.notPaidIn)}
          <ul>{inv.excluded.map(x => <li key={x.id}>{ic(x.date)} · {ic(x.unit ?? '—')} · {ic(x.title)} — {ic(x.reason.replace(VENDOR_VOID, ''))}</li>)}</ul></div>
      )}
    </div>
  );
}

/** The invoice's words; the handyman's own page passes Spanish (Work.tsx). */
export const EN = {
  invoice: 'Invoice', from: 'From', to: 'To', period: 'Period', paid: 'Paid', print: 'Print / PDF', date: 'Date', unit: 'Listing', work: 'Work',
  amount: 'Amount', notPriced: 'not priced', none: 'No paid jobs in this period.', total: 'Total',
  open: 'The period is still open — jobs done before it ends are added.',
  custom: 'Dates picked by the team — each job is paid with the invoice period it falls in.',
  unpriced: (n: number) => `${n} job${n === 1 ? '' : 's'} with no pay yet — not in the total.`,
  pending: (n: number) => `${n} charge${n === 1 ? '' : 's'} waiting for the team's approval.`,
  notPaidIn: 'Not paid in this period:'
};

/**
 * The handyman's Slack channel (owner, 2026-10-27): one line there when new work reaches them, and how many they have
 * each morning — @-mentioning them. A channel that exists (Tim's is #handyman), or a new #handyman-<name>.
 */
function SlackChannel({ vendor, channel, onMade }: { vendor: string; channel: string | null; onMade: () => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => { setMsg(''); setEditing(false); setName(''); }, [vendor]);
  const save = async () => {
    setBusy(true); setMsg('');
    const r = await vendorSlackChannel(vendor, name.trim() || undefined).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not set.'); return; }
    setEditing(false);
    setMsg(r.inSlack ? `#${r.channel} — ${vendor} is in it.` : `#${r.channel} set — ${r.email ? `${r.email} is not in Slack yet: invite them, then set it again` : `no email for ${vendor}: add it in Vendors`}.`);
    onMade();
  };
  if (editing) return <>
    <input className="fr-select" style={{ width: '12em' }} value={name} placeholder={`handyman-${vendor.toLowerCase()} (new)`} onChange={e => setName(e.target.value)}
           aria-label="Slack channel name — empty makes a new one" />
    <button className="chip" disabled={busy} onClick={() => void save()}>{name.trim() ? 'Use it' : 'Make it'}</button>
    <button className="link tiny" onClick={() => setEditing(false)}>Cancel</button>
    {msg && <span className="note" role="status">{ic(msg)}</span>}
  </>;
  return <>
    <button className="chip" onClick={() => { setName(channel ?? ''); setEditing(true); }} title={channel ? `New work and their day are told in #${channel}` : 'Where the bot tells them of new work'}>
      <Icon n="message" /> {channel ? `#${channel}` : 'Slack channel'}</button>
    {msg && <span className="note" role="status">{ic(msg)}</span>}
  </>;
}

/**
 * The handyman's own page, as a link the team pastes into WhatsApp or SMS
 * (owner, 2026-10-25): no sign-in, the same link each time it is copied.
 */
function PageLink({ vendor }: { vendor: string }) {
  const [msg, setMsg] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMsg(''); setMore(false); }, [vendor]);
  const go = async (mode?: 'new' | 'off') => {
    setBusy(true); setMsg('');
    const r = await vendorPageLink(vendor, mode).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not done.'); return; }
    if (!r.link) { setMsg('Link turned off — the old one no longer opens.'); return; }
    await navigator.clipboard.writeText(r.link).then(() => setMsg(mode === 'new' ? 'New link copied — the old one no longer opens.' : 'Link copied.'),
      () => setMsg(r.link!));
  };
  return <>
    <button className="chip" disabled={busy} onClick={() => void go()} title={`Copy ${vendor}'s page link`}><Icon n="clipboard" /> Copy their link</button>
    <a className="chip" href={`/#as-vendor/${encodeURIComponent(vendor)}`} target="_blank" rel="noreferrer"><Icon n="eye" /> View as handyman ↗</a>
    {msg && <span className="note" role="status">{ic(msg)}</span>}
    {msg && !more && <button className="link tiny" onClick={() => setMore(true)}>…</button>}
    {more && <>
      <button className="link tiny" disabled={busy} onClick={() => void go('new')}>New link</button>
      <button className="link tiny" disabled={busy} onClick={() => void go('off')}>Turn off</button>
    </>}
    <Hint label="Their link">Opens {vendor}'s own page — work orders and pay — without signing in. Copy it and paste it in WhatsApp or SMS.
      It is the same link every time; "New link" replaces it (the old one stops working) and "Turn off" closes it.</Hint>
  </>;
}
