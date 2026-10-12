/**
 * The crew page (§122) — one cleaner's cleans, pay, flags, extras and
 * invoice, and (once the team turns it on) what is coming.
 *
 * One view, two audiences. A cleaner opens it signed in (or by their
 * secret link) and sees only their own; the team opens Operations → Crew
 * and sees the same page for any cleaner, with the controls to flag a
 * clean and decide extras. Same data, same totals — what the team checks
 * is what the cleaner sees.
 *
 * Phone first: cleaners read it on a phone, so rows wrap instead of
 * scrolling sideways.
 */
import { Fragment, useEffect, useState } from 'react';
import {
  crewAction, crewAdminAction, crewUpload, getCrew, getCrewAdmin, getCrewAsCleaner,
  type CrewPage, type CrewSchedule, type CrewUpcoming, type PendingExtra, type ToConfirm
} from '../api.ts';
import type { CrewClean, CrewExtra } from '../lib/crew.ts';
import { isBilled, movementText, EXTRA_MAX_AMOUNT, type Movement } from '../lib/crew.ts';
import { money2 } from '../lib/format.ts';
import type { Cleaner } from '../lib/operations.ts';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
/** "2026-10-11 21:40" (New York) → "Sun, Oct 11 at 21:40". */
const stamp = (at: string) => `${day(at.slice(0, 10))} at ${at.slice(11, 16)}`;
const MOVE_ICON: Record<Movement['kind'], string> = { added: '+', moved: '⇢', time: '◷', removed: '✕' };
const Moves = ({ list, who }: { list: (Movement & { cleaner?: string })[]; who?: boolean }) => (
  <ul className="crew-moves">
    {list.map((m, i) => <li key={i} className={m.kind === 'removed' ? 'breach' : undefined}>
      {MOVE_ICON[m.kind]} {who && m.cleaner ? <b>{m.cleaner}: </b> : null}{movementText(m, day, !who)}</li>)}
  </ul>
);
const pay = (n: number | null) => n == null ? 'not priced' : money2(n);
type Act = (body: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
type Upload = (fields: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string }>;
const ACCEPT = 'image/*,application/pdf';

/** Evidence on an extra: links the team opens in Drive. */
const Files = ({ files }: { files?: { id: string; name: string; url: string }[] }) => !files?.length ? null : (
  <span className="crew-files">{files.map(f => <a key={f.id} href={f.url} target="_blank" rel="noreferrer">📎 {f.name}</a>)}</span>
);
const EXTRA_WORD: Record<CrewExtra['status'], string> = { pending: '○ waiting for the team', approved: '✓ approved', denied: '■ denied', cancelled: 'withdrawn' };

/* ── the cleaner's own page ───────────────────────────────────────── */

/**
 * What a cleaner sees, signed in or through their link — or, with
 * `asCleaner`, the team previewing it: the same page from the same server
 * code, with the cleaner's buttons sending nothing.
 */
export function CrewHome({ token, asCleaner }: { token?: string | null; asCleaner?: string }) {
  const [page, setPage] = useState<CrewPage | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () => (asCleaner ? getCrewAsCleaner(asCleaner, period) : getCrew(period, token))
    .then(r => { if (r.ok) { setPage(r); setErr(''); } else setErr(r.message ?? 'Could not load your page.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [period]);

  if (err) return <p className="banner error">{err}</p>;
  if (!page) return <p className="note loading-dot">Loading your cleans…</p>;
  return <CrewView page={page} mode="cleaner" onPeriod={setPeriod} reload={load}
                   act={asCleaner ? inert : body => crewAction(body, token)}
                   upload={asCleaner ? inert : (f, files) => crewUpload(f, files, token)} />;
}

/* ── the team's side, in Operations ───────────────────────────────── */

/** Operations → Crew: extras waiting on the team, and any cleaner's page as they see it. */
export function CrewAdmin({ roster, canEdit }: { roster: Cleaner[]; canEdit: boolean }) {
  const fromHash = decodeURIComponent(/^#crew\/(.+)$/.exec(location.hash)?.[1] ?? '');
  const [name, setName] = useState(roster.some(c => c.name === fromHash) ? fromHash : '');
  const [period, setPeriod] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingExtra[]>([]);
  const [page, setPage] = useState<CrewPage | null>(null);
  const [schedule, setSchedule] = useState<CrewSchedule | null>(null);
  const [toConfirm, setToConfirm] = useState<ToConfirm[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState('');
  const load = () => getCrewAdmin(name || null, period)
    .then(r => { if (r.ok) { setPending(r.pending); setPage(r.page); setSchedule(r.schedule); setToConfirm(r.toConfirm ?? []); setErr(''); }
                 else setErr(r.message ?? 'Could not load.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [name, period]);
  useEffect(() => { if (name) history.replaceState(null, '', `#crew/${encodeURIComponent(name)}`); }, [name]);

  return (
    <>
      {err && <p className="banner error">{err}</p>}
      <div className="row-controls">
        <label>See a cleaner's page as they see it
          <select value={name} onChange={e => { setName(e.target.value); setPeriod(null); }}>
            <option value="">Choose…</option>
            {roster.map(c => <option key={c.name} value={c.name}>{c.name}{c.active ? '' : ' (inactive)'}{c.email ? '' : ' — no sign-in address'}</option>)}
          </select></label>
        {/* A separate tab with only the cleaner's page — nothing of the team's around it. */}
        {name && <a className="chip" href={`/#as-cleaner/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">👁 View as cleaner ↗</a>}
      </div>
      {page && <CrewView page={page} mode="team" canEdit={canEdit} onPeriod={setPeriod} reload={load} act={crewAdminAction} />}
      {toConfirm.length > 0 && (
        <div className="card">
          <h2>Cancelled after arrival — confirm <span className="chan-tag">{toConfirm.length}</span></h2>
          <p className="note">These bookings were cancelled on or after their arrival day, so the guest may have used the unit.
            Each clean waits here — unpaid, unassigned — until someone says who cleaned it, or that no clean was needed.</p>
          <div className="crew-list">
            {toConfirm.map(t => <ConfirmRow key={t.key} t={t} roster={roster} canEdit={canEdit} onDone={load} />)}
          </div>
        </div>
      )}
      {schedule && (
        <div className="card">
          <h2>Schedule shared with cleaners <span className={schedule.enabled ? 'ok-tag' : 'chan-tag'}>{schedule.enabled ? 'on' : 'off'}</span></h2>
          <p className="note">
            {!schedule.enabled && 'Cleaners do not see what is coming yet (Setup → Crew pages). '}
            {schedule.confirmed
              ? <>Last snapshot {stamp(schedule.confirmed.at)} — {schedule.confirmed.by === 'daily update' ? 'the automatic daily update' : `by ${schedule.confirmed.by}`}, through {day(schedule.confirmed.through)}.
                  Cleaners see that date, and every change since.</>
              : 'No snapshot yet — the daily pass takes one each day.'}
          </p>
          {schedule.problem && <p className="banner warn">▲ {schedule.problem}</p>}
          {schedule.confirmed && (schedule.movements.length
            ? <><b>Changes since then ({schedule.movements.length})</b><Moves list={schedule.movements} who /></>
            : <p className="note">✓ Nothing has moved since.</p>)}
          {canEdit && (
            <div className="button-row">
              <button disabled={confirming} onClick={async () => {
                setConfirming(true);
                const r = await crewAdminAction({ action: 'confirmSchedule' }).catch(e => ({ ok: false as const, message: String(e) }));
                setConfirming(false);
                if (!r.ok) { setErr(r.message ?? 'Not confirmed.'); return; }
                void load();
              }}>{confirming ? 'Confirming…' : 'Confirm the schedule as it is now'}</button>
              <span className="note">Check the board first: cleaners plan their days off this.</span>
            </div>
          )}
        </div>
      )}
      <div className="card">
        <h2>Extras waiting on the team <span className="chan-tag">{pending.length}</span></h2>
        {!pending.length ? <p className="note">None waiting.</p> : (
          <div className="crew-list">
            {pending.map(e => (
              <div key={e.id} className="crew-row">
                <div><b>{e.cleaner}</b> · {e.unit} · {day(e.date)}<div className="sub-n">clean paid {pay(e.price)} · asked {e.createdAt}</div></div>
                <div><b>+{money2(e.amount)}</b> — {e.description} <Files files={e.files} /></div>
                {canEdit && <Decide id={e.id} onDone={load} />}
              </div>
            ))}
          </div>
        )}
      </div>

    </>
  );
}

/** The cleaner's buttons, shown to the team but sending nothing. */
const inert = async () => ({ ok: false, message: 'Preview — only the cleaner can do this, from their own page. Nothing was sent.' });

/** One held clean: who cleaned it and when — or no clean. */
function ConfirmRow({ t, roster, canEdit, onDone }: { t: ToConfirm; roster: Cleaner[]; canEdit: boolean; onDone: () => void }) {
  const [cleaner, setCleaner] = useState('');
  const [date, setDate] = useState(t.date);
  const [deep, setDeep] = useState(t.deep);
  const [msg, setMsg] = useState('');
  const go = async (who: string | null) => {
    const r = await crewAdminAction({ action: 'confirmClean', key: t.key, cleaner: who, date, deep })
      .catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    onDone();
  };
  return (
    <div className="crew-row">
      <div><b>{t.unit}</b>{t.beds ? ` · ${t.beds}BR` : ''}<div className="sub-n">{t.guest ?? ''}</div></div>
      <div className="breach">▲ {t.note}</div>
      <div />
      {canEdit && (
        <div className="crew-decide">
          <select value={cleaner} onChange={e => setCleaner(e.target.value)}>
            <option value="">Who cleaned it?</option>
            {roster.filter(c => c.active).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          <label className="check inline"><input type="checkbox" checked={deep} onChange={e => setDeep(e.target.checked)} /> deep</label>
          <button className="small" disabled={!cleaner} onClick={() => void go(cleaner)}>✓ Cleaned</button>
          <button className="small secondary" onClick={() => void go(null)}>No clean needed</button>
        </div>
      )}
      {msg && <div className="breach">{msg}</div>}
    </div>
  );
}

function Decide({ id, onDone }: { id: string; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const go = async (status: 'approved' | 'denied') => {
    const r = await crewAdminAction({ action: 'decideExtra', id, status, note }).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    onDone();
  };
  return (
    <div className="crew-decide">
      <input value={note} maxLength={500} placeholder="Note for the cleaner (needed to deny)" onChange={e => setNote(e.target.value)} />
      <button className="small" onClick={() => void go('approved')}>✓ Approve</button>
      <button className="small secondary" disabled={!note.trim()} onClick={() => void go('denied')}>■ Deny</button>
      {msg && <span className="breach">{msg}</span>}
    </div>
  );
}

/* ── the page itself ──────────────────────────────────────────────── */

function CrewView({ page, mode, canEdit = false, onPeriod, reload, act, upload }: {
  page: CrewPage; mode: 'cleaner' | 'team'; canEdit?: boolean;
  onPeriod: (from: string) => void; reload: () => void;
  act: Act; upload?: Upload;
}) {
  const { invoice: inv, period } = page;
  const shown = page.cleans.filter(c => c.date >= period.from && c.date <= period.to);
  const extrasOf = (key: string) => page.extras.filter(e => e.key === key);
  const flagged = shown.filter(c => c.flagNote).length;
  const excluded = shown.filter(c => c.voidReason).length;
  const team = mode === 'team';

  return (
    <div className="crew">
      <div className="card no-print">
        <h2>{team ? page.cleaner.name : `Hi, ${page.cleaner.name}`}
          {team && page.cleaner.level && <span className="chan-tag" title="Only the team sees this">{page.cleaner.level} level</span>}
          {!page.cleaner.active && <span className="chan-tag">inactive</span>}</h2>
        <label>Invoice period ({page.cleaner.invoicePeriod === 'weekly' ? 'weekly, Saturday to Friday, paid Saturday' : 'monthly, paid in the first days of the next month'})
          <select value={period.from} onChange={e => onPeriod(e.target.value)}>
            {page.periods.map(p => <option key={p.from} value={p.from}>{p.label}</option>)}
          </select></label>
      </div>

      <Upcoming page={page} act={mode === 'cleaner' ? act : undefined} reload={reload} />
      <CrewCalendar page={page} />

      <div className="card no-print">
        <h2>Cleans — {period.label}</h2>
        <p className="note">
          {inv.lines.length} paid · {money2(inv.total)}{inv.open ? ' so far' : ''}
          {excluded > 0 && <> · ○ {excluded} not paid</>}
          {flagged > 0 && <> · <span className="breach">⚑ {flagged} flagged</span></>}
          {inv.pendingExtras > 0 && <> · ○ {inv.pendingExtras} extra{inv.pendingExtras === 1 ? '' : 's'} waiting</>}
        </p>
        {!shown.length ? <p className="note">No cleans in this period.</p> : (
          <div className="crew-list">
            {shown.map(c => (
              <CleanRow key={c.key} c={c} extras={extrasOf(c.key)} today={page.today} extraFrom={page.extraFrom}
                        mode={mode} canEdit={canEdit} act={act} upload={upload} reload={reload} />
            ))}
          </div>
        )}
      </div>

      <InvoiceView page={page} />
    </div>
  );
}

/* ── the calendar ─────────────────────────────────────────────────── */

const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
type CalItem = { date: string; unit: string; mark: string; title: string; tone: 'done' | 'off' | 'flag' | 'ahead' };
/** A unit's name short enough for a phone's calendar cell: "P2-4304" → "4304", "Bobcat House" → "Bobcat". */
const shortUnit = (u: string) => /\d{3,}$/.exec(u.trim())?.[0] ?? u.trim().split(/\s+/)[0]!;

/**
 * A month at a glance: what was done (from the record) and what is coming
 * (only what the page already shows under "Coming up"). The page holds the
 * last two months and the days ahead it shows, so the months it can draw
 * are those.
 */
function CrewCalendar({ page }: { page: CrewPage }) {
  // Each clean once, with the same status as the Cleans list: today and before from the record
  // (✓ paid, ⚑ flagged, ○ not paid), after today as coming up — the server already sent only
  // what this cleaner may see ahead.
  const next = new Map(page.upcoming.rows.map(r => [r.key, r]));
  const detail = (key: string) => {
    const r = next.get(key);
    return r ? `${r.manual ? 'manual clean' : `checkout ${r.time}`}${r.sameDay ? ` · next guest in${r.checkIn ? ` at ${r.checkIn}` : ''}` : ''}` : '';
  };
  const items: CalItem[] = [
    ...page.cleans.map(c => {
      const extra = detail(c.key);
      if (c.date > page.today) {
        return { date: c.date, unit: c.unit, mark: next.get(c.key)?.sameDay ? '⚡' : '•', tone: 'ahead' as const,
                 title: `${extra ? `${extra} · ` : ''}${pay(c.price)}` };
      }
      const base = c.voidReason ? { mark: '○', tone: 'off' as const, title: `not paid — ${c.voidReason}` }
        : c.flagNote ? { mark: '⚑', tone: 'flag' as const, title: `flagged — ${c.flagNote} · ${pay(c.price)}` }
        : c.assignment === 'assigned' ? { mark: '✓', tone: 'done' as const, title: `${pay(c.price)}${c.deep ? ' · deep' : ''}` }
        : { mark: '○', tone: 'off' as const, title: 'not assigned to you any more' };
      return { date: c.date, unit: c.unit, ...base, title: `${extra ? `${extra} · ` : ''}${base.title}` };
    }),
    // Ahead and not in the record yet (beyond the board's window).
    ...page.upcoming.rows.filter(r => !page.cleans.some(c => c.key === r.key))
      .map(r => ({ date: r.date, unit: r.unit, mark: r.sameDay ? '⚡' : '•', tone: 'ahead' as const, title: `${detail(r.key)} · ${pay(r.price)}` }))
  ];
  const months = [...new Set([...items.map(i => i.date.slice(0, 7)), page.today.slice(0, 7)])].sort();
  const [month, setMonth] = useState(page.today.slice(0, 7));
  const [sel, setSel] = useState(page.today);
  const at = months.indexOf(month);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(first.getUTCDay()).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const byDay = new Map<string, CalItem[]>();
  for (const i of items) byDay.set(i.date, [...(byDay.get(i.date) ?? []), i]);

  return (
    <div className="card no-print">
      <div className="crew-cal-head">
        <button className="chip" disabled={at <= 0} onClick={() => setMonth(months[at - 1]!)}>‹</button>
        <h2>{MONTH_NAME[m - 1]} {y}</h2>
        <button className="chip" disabled={at >= months.length - 1} onClick={() => setMonth(months[at + 1]!)}>›</button>
      </div>
      <div className="crew-cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="crew-cal-dow">{d}</div>)}
        {cells.map((d, i) => d === null ? <div key={i} /> : (
          <button key={d} className={`crew-cal-day${d === page.today ? ' today' : ''}${d === sel ? ' sel' : ''}`} onClick={() => setSel(d)}>
            <div className="crew-cal-n">{Number(d.slice(8))}</div>
            {(byDay.get(d) ?? []).map((it, j) => (
              <div key={j} className={`crew-cal-item ${it.tone}`}>{it.mark} {shortUnit(it.unit)}</div>
            ))}
          </button>
        ))}
      </div>
      {/* The day tapped, in full — a cell only has room for a short name. */}
      <div className="crew-cal-detail">
        <b>{day(sel)}</b>
        {(byDay.get(sel) ?? []).length === 0 ? <span className="note"> — nothing</span> : (
          <ul>{(byDay.get(sel) ?? []).map((it, j) => <li key={j} className={`crew-cal-item ${it.tone}`}>{it.mark} {it.unit} — {it.title}</li>)}</ul>
        )}
      </div>
      <p className="note">Tap a day for its cleans. ✓ done and paid · ⚑ flagged · ○ not paid · • coming up · ⚡ next guest the same day.
        {!page.upcoming.enabled && ` Coming up shows your cleans ${page.upcoming.autoDays} days ahead, and any the team assigned to you directly.`}</p>
      {page.upcoming.rows.length > 0 && (
        <div className="button-row">
          <button className="secondary" onClick={() => downloadIcs(page)}>📅 Add my coming cleans to my phone calendar</button>
          <span className="note">A copy of them as they are now — if one changes, check this page and add them again.</span>
        </div>
      )}
    </div>
  );
}

/**
 * The coming cleans as an .ics file the phone's calendar opens. Each at its
 * checkout time, an hour and a half long, in the board's time (New York) —
 * written as local time, which is what a cleaner in Texas reads them as.
 */
function downloadIcs(page: CrewPage) {
  const esc = (t: string) => t.replace(/[\\,;]/g, m => `\\${m}`).replace(/\n/g, '\\n');
  const at = (date: string, time: string) => {
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
    let h = m ? Number(m[1]) % 12 + (/pm/i.test(m[3]!) ? 12 : 0) : 10;
    const min = m ? Number(m[2]) : 0;
    return { start: `${date.replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(min).padStart(2, '0')}00`,
             end: (() => { const e = h * 60 + min + 90; h = Math.floor(e / 60); return `${date.replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(e % 60).padStart(2, '0')}00`; })() };
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const events = page.upcoming.rows.map(r => {
    const t = at(r.date, r.time);
    const what = r.manual ? `manual clean (${r.manual.replace('_', ' ')})` : 'checkout clean';
    return ['BEGIN:VEVENT', `UID:kaizen-${r.key}@kaizen-os`, `DTSTAMP:${stamp}`, `DTSTART:${t.start}`, `DTEND:${t.end}`,
            `SUMMARY:${esc(`Clean ${r.unit}${r.beds ? ` (${r.beds}BR)` : ''}`)}`,
            `DESCRIPTION:${esc(`${what}${r.sameDay ? ` — next guest in${r.checkIn ? ` at ${r.checkIn}` : ' the same day'}` : ''}. Pays ${pay(r.price)}.`)}`,
            'END:VEVENT'].join('\r\n');
  });
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kaizen OS//Crew//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url; a.download = `kaizen-cleans-${page.today}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Upcoming({ page, act, reload }: { page: CrewPage; act?: Act; reload: () => void }) {
  const u = page.upcoming;
  return (
    <div className="card no-print">
      <h2>Coming up</h2>
      {u.problem ? <p className="banner warn">▲ {u.problem}</p> : (
        <>
          {u.confirmed && <p><b>Last update: {stamp(u.confirmed.at)}</b></p>}
          {u.confirmed && u.movements.length > 0 && <><b>Changes since then</b><Moves list={u.movements} /></>}
          {u.confirmed && u.movements.length === 0 && u.rows.length > 0 && <p className="note">✓ No changes since then.</p>}
          <p className="note">{u.enabled
            ? `Through ${u.through ? day(u.through) : '—'}. Check here before you plan the day.`
            : `Your cleans show here ${u.autoDays} days ahead — sooner when the team assigns one to you directly. Check here before you plan the day.`}</p>
          {!u.rows.length ? <p className="note">Nothing for you {u.enabled ? `through ${u.through ? day(u.through) : 'the next days'}` : `in the next ${u.autoDays} days`} yet.</p> : (
            <div className="crew-list">
              {u.rows.map(r => <UpcomingRow key={r.key} r={r} act={act} reload={reload}
                tag={(() => { const m = u.movements.find(x => x.key === r.key);
                              return !m ? null : m.kind === 'added' ? '+ new' : m.kind === 'moved' ? `⇢ moved from ${day(m.from)}` : m.kind === 'time' ? '◷ time changed' : null; })()} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One clean ahead. A cleaner can turn it down: it goes back to the team, unassigned. */
function UpcomingRow({ r, act, reload, tag }: { r: CrewUpcoming; act?: Act; reload: () => void; tag?: string | null }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const decline = async () => {
    if (!act) return;
    setBusy(true); setMsg('');
    const res = await act({ action: 'decline', key: r.key, reason }).catch(e => ({ ok: false, message: String(e) }));
    setBusy(false);
    if (!res.ok) { setMsg(res.message ?? 'Not saved.'); return; }
    reload();
  };
  return (
    <div className="crew-row">
      <div><b>{day(r.date)}</b> · {r.unit}{r.beds ? ` · ${r.beds}BR` : ''}
        {tag && <div className={tag.startsWith('○') ? 'sub-n' : 'breach'}>{tag}</div>}</div>
      <div>
        {r.manual ? `manual clean (${r.manual.replace('_', ' ')})` : `checkout ${r.time}`}
        {r.sameDay && <span className="ops-flag urgent">⚡ next guest in{r.checkIn ? ` at ${r.checkIn}` : ' the same day'}</span>}
        {r.deep && <span className="ops-flag deep">🧽 deep</span>}
      </div>
      <div className="n">{pay(r.price)}
        {act && !declining && <div><button className="link tiny" onClick={() => setDeclining(true)}>Can't do it</button></div>}</div>
      {declining && (
        <div className="crew-decide">
          <input value={reason} maxLength={300} placeholder="Why (optional) — the team reads it" onChange={e => setReason(e.target.value)} />
          <button className="small" disabled={busy} onClick={() => void decline()}>{busy ? 'Sending…' : 'Decline this clean'}</button>
          <button className="small secondary" disabled={busy} onClick={() => setDeclining(false)}>Keep it</button>
          <span className="note">It goes back to the team unassigned, for someone else.</span>
        </div>
      )}
      {msg && <div className="breach">{msg}</div>}
    </div>
  );
}

function CleanRow({ c, extras, today, extraFrom, mode, canEdit, act, upload, reload }: {
  c: CrewClean; extras: CrewExtra[]; today: string; extraFrom: string; mode: 'cleaner' | 'team'; canEdit: boolean;
  act: Act; upload?: Upload; reload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [deep, setDeep] = useState(c.deep);
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const billed = isBilled(c, today);
  const upcoming = c.date > today;
  const done = (r: { ok: boolean; message?: string }) => {
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    setAdding(false); setFlagging(false); setCorrecting(false); setAmount(''); setText(''); setFiles([]); reload();
  };
  const send = async (body: Record<string, unknown>) => {
    setMsg(''); setBusy(true);
    done(await act(body).catch(e => ({ ok: false, message: String(e) })));
  };
  // With files the request is multipart; the receipts go to Drive before the extra is saved.
  const sendExtra = async () => {
    const fields = { action: 'addExtra', key: c.key, amount: String(Number(amount)), description: text };
    if (!files.length || !upload) return send(fields);
    setMsg(''); setBusy(true);
    done(await upload(fields, files).catch(e => ({ ok: false, message: String(e) })));
  };
  const attach = async (id: string, list: FileList | null) => {
    if (!upload || !list?.length) return;
    setMsg(''); setBusy(true);
    done(await upload({ action: 'attachFile', id }, [...list]).catch(e => ({ ok: false, message: String(e) })));
  };

  return (
    <div className="crew-row">
      <div><b>{day(c.date)}</b> · {c.unit}{c.beds ? ` · ${c.beds}BR` : ''}{c.deep ? ' · 🧽 deep' : ''}
        {c.kind !== 'checkout' && <span className="sub-n"> · manual ({c.kind.replace('_', ' ')})</span>}</div>
      <div>
        {c.voidReason ? <span className="note">○ not paid — {c.voidReason}</span>
          : upcoming ? <span className="note">○ coming up</span>
          : billed ? <span>✓ {pay(c.price)}</span>
          : <span className="note">○ not assigned to you any more</span>}
        {c.flagNote && <div className="breach">⚑ Flagged: {c.flagNote}</div>}
        {c.editNote && <div className="sub-n">✎ Corrected by the team: {c.editNote}</div>}
        {extras.map(e => (
          <div key={e.id} className={e.status === 'denied' ? 'breach' : 'sub-n'}>
            Extra +{money2(e.amount)} — {e.description} · {EXTRA_WORD[e.status]}
            {e.decisionNote && <> · “{e.decisionNote}”</>} <Files files={e.files} />
            {mode === 'cleaner' && e.status === 'pending' && <>
              <label className="link tiny crew-attach">+ receipt / photo
                <input type="file" accept={ACCEPT} multiple hidden disabled={busy} onChange={ev => void attach(e.id, ev.target.files)} /></label>
              <button className="link tiny" disabled={busy} onClick={() => void send({ action: 'cancelExtra', id: e.id })}>withdraw</button>
            </>}
            {mode === 'team' && canEdit && e.status === 'pending' && <Decide id={e.id} onDone={reload} />}
          </div>
        ))}
      </div>
      <div className="crew-actions no-print">
        {mode === 'cleaner' && billed && c.date >= extraFrom && !adding &&
          <button className="link tiny" onClick={() => setAdding(true)}>+ Add an extra</button>}
        {mode === 'team' && canEdit && c.date < today && !correcting &&
          <button className="link tiny" onClick={() => { setCorrecting(true); setDeep(c.deep); setAmount(c.price == null ? '' : String(c.price)); }}>✎ Correct</button>}
        {mode === 'team' && canEdit && !flagging && (c.flagNote
          ? <button className="link tiny" onClick={() => void send({ action: 'unflag', key: c.key })}>Remove flag</button>
          : <button className="link tiny" onClick={() => setFlagging(true)}>⚑ Flag</button>)}
      </div>
      {adding && (
        <div className="crew-decide">
          <input className="amt" inputMode="decimal" value={amount} placeholder="$" onChange={e => setAmount(e.target.value)} />
          <input value={text} maxLength={300} placeholder="What for (e.g. extra laundry load)" onChange={e => setText(e.target.value)} />
          <label className="crew-attach">Receipt, invoice or photo (optional)
            <input type="file" accept={ACCEPT} multiple onChange={e => setFiles([...(e.target.files ?? [])])} /></label>
          <button className="small" disabled={busy || !(Number(amount) > 0) || Number(amount) > EXTRA_MAX_AMOUNT || !text.trim()}
                  onClick={() => void sendExtra()}>{busy ? 'Sending…' : 'Send to the team'}</button>
          <button className="small secondary" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
      {correcting && (
        <div className="crew-decide">
          <select value={deep ? 'deep' : 'normal'} onChange={e => setDeep(e.target.value === 'deep')}>
            <option value="normal">normal clean</option><option value="deep">deep clean</option></select>
          <input className="amt" inputMode="decimal" value={amount} placeholder="rate card" onChange={e => setAmount(e.target.value)} />
          <input value={text} maxLength={500} placeholder="Why (the cleaner reads it), e.g. deep was not done" onChange={e => setText(e.target.value)} />
          <button className="small" disabled={busy || !text.trim()}
                  onClick={() => void send({ action: 'editClean', key: c.key, deep, price: amount, note: text })}>Save correction</button>
          <button className="small secondary" onClick={() => setCorrecting(false)}>Cancel</button>
          <span className="note">Blank price = the cleaner's rate for the new type.</span>
        </div>
      )}
      {flagging && (
        <div className="crew-decide">
          <input value={text} maxLength={500} placeholder="What the cleaner should know (they read this)" onChange={e => setText(e.target.value)} />
          <button className="small" disabled={!text.trim()} onClick={() => void send({ action: 'flag', key: c.key, note: text })}>Flag</button>
          <button className="small secondary" onClick={() => setFlagging(false)}>Cancel</button>
        </div>
      )}
      {msg && <div className="breach">{msg}</div>}
    </div>
  );
}

/** The invoice Kaizen builds — printed or saved as PDF from the browser. */
function InvoiceView({ page }: { page: CrewPage }) {
  const inv = page.invoice;
  return (
    <div className="card crew-invoice">
      <div className="crew-invoice-head">
        <div><h2>Invoice {inv.number}</h2>
          <div>From: <b>{page.cleaner.name}</b></div>
          <div>To: <b>Kaizen Guest Properties</b></div>
          <div>Period: {inv.period.label} ({inv.period.from} – {inv.period.to})</div>
          <div>Paid: <b>{inv.period.payNote}</b></div></div>
        <button className="secondary no-print" onClick={() => window.print()}>Print / save as PDF</button>
      </div>
      {inv.open && <p className="note">○ This period is still open — cleans done by {day(inv.period.to)} are added. Paid {inv.period.payNote}.</p>}
      <table className="units compact">
        <thead><tr><th>Date</th><th>Unit</th><th>Work</th><th className="n">Amount</th></tr></thead>
        <tbody>
          {inv.lines.map(l => (
            <Fragment key={l.key}>
              <tr><td>{l.date}</td><td>{l.unit}</td><td>{l.what}{l.flag ? ' ⚑' : ''}</td>
                <td className="n">{l.amount == null ? <span className="note">not priced</span> : money2(l.amount)}</td></tr>
              {inv.extras.filter(e => e.key === l.key).map(e => (
                <tr key={e.id}><td></td><td></td><td>Extra — {e.description}</td><td className="n">{money2(e.amount)}</td></tr>
              ))}
            </Fragment>
          ))}
          {!inv.lines.length && <tr><td colSpan={4} className="note">No paid cleans in this period.</td></tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>Cleans</td><td className="n">{money2(inv.cleansTotal)}</td></tr>
          {inv.extrasTotal > 0 && <tr><td colSpan={3}>Approved extras</td><td className="n">{money2(inv.extrasTotal)}</td></tr>}
          <tr><td colSpan={3}><b>Total</b></td><td className="n"><b>{money2(inv.total)}</b></td></tr>
        </tfoot>
      </table>
      {inv.unpriced > 0 && <p className="breach">▲ {inv.unpriced} clean{inv.unpriced === 1 ? ' has' : 's have'} no rate on the card yet and {inv.unpriced === 1 ? 'is' : 'are'} not in the total — the team sets it.</p>}
      {inv.pendingExtras > 0 && <p className="note">○ {inv.pendingExtras} extra{inv.pendingExtras === 1 ? ' is' : 's are'} waiting for the team and not in the total yet.</p>}
      {inv.excluded.length > 0 && (
        <div className="note">Not paid in this period:
          <ul>{inv.excluded.map(x => <li key={x.key}>{x.date} · {x.unit} — {x.reason}</li>)}</ul></div>
      )}
    </div>
  );
}
