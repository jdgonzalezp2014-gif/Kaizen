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
import {
  DOW_LETTER, LANGS, LANG_NAME, TX, bedsWord, dayLabel, kindWord, monthTitle, movementFor, payNote, periodLabel,
  stampLabel, voidReasonText, workText, type Lang, type Tx
} from '../lib/crew-i18n.ts';
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
  // §129: the cleaner's language — theirs from the server; a switch here is saved for every device.
  const [lang, setLang] = useState<Lang | null>(null);
  const shown: Lang = lang ?? page?.cleaner.lang ?? 'en';
  const load = () => (asCleaner ? getCrewAsCleaner(asCleaner, period) : getCrew(period, token))
    .then(r => { if (r.ok) { setPage(r); setErr(''); } else setErr(r.message ?? TX[shown].loadFail); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [period]);
  const act: Act = asCleaner ? inert : body => crewAction(body, token);
  const choose = (l: Lang) => { setLang(l); void act({ action: 'setLang', lang: l }).catch(() => {}); };

  if (err) return <p className="banner error">{err}</p>;
  if (!page) return <p className="note loading-dot">{TX[shown].loading}</p>;
  return <CrewView page={page} mode="cleaner" lang={shown} onLang={choose} onPeriod={setPeriod} reload={load}
                   act={act} upload={asCleaner ? inert : (f, files) => crewUpload(f, files, token)} />;
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
          <h2>What cleaners see ahead</h2>
          <p className="note">
            {schedule.enabled ? 'The whole schedule is published: cleaners see everything ahead.'
              : `What a person assigned, and the rule's picks ${schedule.autoDays} days ahead — marked 👁 on the board. Nothing to confirm.`}
            {' '}{schedule.confirmed
              ? <>Last daily update {stamp(schedule.confirmed.at)}{schedule.confirmed.by === 'daily update' ? '' : ` (by ${schedule.confirmed.by})`}.</>
              : 'The first daily update comes with the next daily pass.'}
            {' '}Change it in Setup → Crew pages.
          </p>
          {schedule.problem && <p className="banner warn">▲ {schedule.problem}</p>}
          {schedule.confirmed && schedule.movements.length > 0 && (
            <><b>Changes since that update — what cleaners are told ({schedule.movements.length})</b><Moves list={schedule.movements} who /></>
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

function CrewView({ page, mode, canEdit = false, onPeriod, reload, act, upload, lang = 'en', onLang }: {
  page: CrewPage; mode: 'cleaner' | 'team'; canEdit?: boolean;
  onPeriod: (from: string) => void; reload: () => void;
  act: Act; upload?: Upload;
  /** The cleaner's language (§129); the team's view is English. */
  lang?: Lang; onLang?: (l: Lang) => void;
}) {
  const { invoice: inv, period } = page;
  const tx = TX[lang];
  const kind = page.cleaner.invoicePeriod;
  const shown = page.cleans.filter(c => c.date >= period.from && c.date <= period.to);
  const extrasOf = (key: string) => page.extras.filter(e => e.key === key);
  const flagged = shown.filter(c => c.flagNote).length;
  const excluded = shown.filter(c => c.voidReason).length;
  const team = mode === 'team';

  return (
    <div className="crew">
      <div className="card no-print">
        <h2>{team ? page.cleaner.name : tx.hi(page.cleaner.name)}
          {team && page.cleaner.level && <span className="chan-tag" title="Only the team sees this">{page.cleaner.level} level</span>}
          {!page.cleaner.active && <span className="chan-tag">{tx.inactive}</span>}</h2>
        {onLang && (
          <div className="todo-kind" role="group" aria-label="Language / Idioma">
            {LANGS.map(l => <button key={l} className={l === lang ? 'chip active' : 'chip'} onClick={() => onLang(l)}>{LANG_NAME[l]}</button>)}
          </div>
        )}
        <label>{tx.periodField(kind)}
          <select value={period.from} onChange={e => onPeriod(e.target.value)}>
            {page.periods.map(p => <option key={p.from} value={p.from}>{periodLabel(lang, p, kind)}</option>)}
          </select></label>
      </div>

      {mode === 'cleaner' && !!page.help?.filter(h => (h.lang ?? 'en') === lang).length && (
        <div className="card no-print">
          {page.help.filter(h => (h.lang ?? 'en') === lang).map(h => (
            <details key={h.title}>
              <summary><b>❓ {h.title}</b></summary>
              {h.purpose && <p className="note">{h.purpose}</p>}
              <ol>{h.steps.map((st, i) => <li key={i}>{st.text}{st.detail && <div className="note crew-help">{st.detail}</div>}</li>)}</ol>
              {h.body && <div className="note crew-help">{h.body}</div>}
            </details>
          ))}
        </div>
      )}
      <Upcoming page={page} act={mode === 'cleaner' ? act : undefined} reload={reload} lang={lang} />
      <CrewCalendar page={page} lang={lang} />

      <div className="card no-print">
        <h2>{tx.cleansTitle(periodLabel(lang, period, kind))}</h2>
        <p className="note">
          {tx.paidCount(inv.lines.length)} · {money2(inv.total)}{inv.open ? tx.soFar : ''}
          {excluded > 0 && <> · {tx.notPaidCount(excluded)}</>}
          {flagged > 0 && <> · <span className="breach">{tx.flaggedCount(flagged)}</span></>}
          {inv.pendingExtras > 0 && <> · {tx.extrasWaiting(inv.pendingExtras)}</>}
        </p>
        {!shown.length ? <p className="note">{tx.noCleans}</p> : (
          <div className="crew-list">
            {shown.map(c => (
              <CleanRow key={c.key} c={c} extras={extrasOf(c.key)} today={page.today} extraFrom={page.extraFrom}
                        mode={mode} canEdit={canEdit} act={act} upload={upload} reload={reload} lang={lang} />
            ))}
          </div>
        )}
      </div>

      <InvoiceView page={page} lang={lang} />
    </div>
  );
}

/* ── the calendar ─────────────────────────────────────────────────── */

type CalItem = { date: string; unit: string; mark: string; title: string; tone: 'done' | 'off' | 'flag' | 'ahead' };
/** A unit's name short enough for a phone's calendar cell: "P2-4304" → "4304", "Bobcat House" → "Bobcat". */
const shortUnit = (u: string) => /\d{3,}$/.exec(u.trim())?.[0] ?? u.trim().split(/\s+/)[0]!;

/**
 * A month at a glance: what was done (from the record) and what is coming
 * (only what the page already shows under "Coming up"). The page holds the
 * last two months and the days ahead it shows, so the months it can draw
 * are those.
 */
function CrewCalendar({ page, lang }: { page: CrewPage; lang: Lang }) {
  const tx = TX[lang];
  const pay = (v: number | null) => v == null ? tx.notPriced : money2(v);
  const day = (d: string) => dayLabel(lang, d);
  // Each clean once, with the same status as the Cleans list: today and before from the record
  // (✓ paid, ⚑ flagged, ○ not paid), after today as coming up — the server already sent only
  // what this cleaner may see ahead.
  const next = new Map(page.upcoming.rows.map(r => [r.key, r]));
  const detail = (key: string) => {
    const r = next.get(key);
    return r ? `${r.manual ? tx.manualClean(kindWord(lang, r.manual)) : tx.checkout(r.time)}${r.sameDay ? tx.calNextGuest(r.checkIn) : ''}` : '';
  };
  const items: CalItem[] = [
    ...page.cleans.map(c => {
      const extra = detail(c.key);
      if (c.date > page.today) {
        return { date: c.date, unit: c.unit, mark: next.get(c.key)?.sameDay ? '⚡' : '•', tone: 'ahead' as const,
                 title: `${extra ? `${extra} · ` : ''}${pay(c.price)}` };
      }
      const base = c.voidReason ? { mark: '○', tone: 'off' as const, title: tx.calNotPaid(voidReasonText(lang, c.voidReason)) }
        : c.flagNote ? { mark: '⚑', tone: 'flag' as const, title: `${tx.calFlagged(c.flagNote)} · ${pay(c.price)}` }
        : c.assignment === 'assigned' ? { mark: '✓', tone: 'done' as const, title: `${pay(c.price)}${c.deep ? tx.calDeep : ''}` }
        : { mark: '○', tone: 'off' as const, title: tx.calNotYours };
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
        <h2>{monthTitle(lang, y, m)}</h2>
        <button className="chip" disabled={at >= months.length - 1} onClick={() => setMonth(months[at + 1]!)}>›</button>
      </div>
      <div className="crew-cal">
        {DOW_LETTER[lang].map((d, i) => <div key={i} className="crew-cal-dow">{d}</div>)}
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
        {(byDay.get(sel) ?? []).length === 0 ? <span className="note">{tx.nothing}</span> : (
          <ul>{(byDay.get(sel) ?? []).map((it, j) => <li key={j} className={`crew-cal-item ${it.tone}`}>{it.mark} {it.unit} — {it.title}</li>)}</ul>
        )}
      </div>
      <p className="note">{tx.calLegend}
        {!page.upcoming.enabled && tx.calAuto(page.upcoming.autoDays)}</p>
      {page.upcoming.rows.length > 0 && (
        <div className="button-row">
          <button className="secondary" onClick={() => downloadIcs(page, lang)}>{tx.icsBtn}</button>
          <span className="note">{tx.icsNote}</span>
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
function downloadIcs(page: CrewPage, lang: Lang) {
  const tx = TX[lang];
  const pay = (v: number | null) => v == null ? tx.notPriced : money2(v);
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
    const what = r.manual ? tx.manualClean(kindWord(lang, r.manual)) : tx.icsCheckout;
    return ['BEGIN:VEVENT', `UID:kaizen-${r.key}@kaizen-os`, `DTSTAMP:${stamp}`, `DTSTART:${t.start}`, `DTEND:${t.end}`,
            `SUMMARY:${esc(tx.icsSummary(r.unit, bedsWord(lang, r.beds)))}`,
            `DESCRIPTION:${esc(`${what}${r.sameDay ? tx.icsNextGuest(r.checkIn) : ''}.${tx.icsPays(pay(r.price))}`)}`,
            'END:VEVENT'].join('\r\n');
  });
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kaizen OS//Crew//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url; a.download = `kaizen-cleans-${page.today}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Upcoming({ page, act, reload, lang }: { page: CrewPage; act?: Act; reload: () => void; lang: Lang }) {
  const u = page.upcoming;
  const tx = TX[lang];
  const day = (d: string) => dayLabel(lang, d);
  return (
    <div className="card no-print">
      <h2>{tx.comingUp}</h2>
      {u.problem ? <p className="banner warn">▲ {u.problem}</p> : (
        <>
          {u.confirmed && <p><b>{tx.lastUpdate(stampLabel(lang, u.confirmed.at))}</b></p>}
          {u.confirmed && u.movements.length > 0 && <><b>{tx.changesSince}</b>
            <ul className="crew-moves">{u.movements.map((m, i) => <li key={i} className={m.kind === 'removed' ? 'breach' : undefined}>
              {MOVE_ICON[m.kind]} {movementFor(lang, m)}</li>)}</ul></>}
          {u.confirmed && u.movements.length === 0 && u.rows.length > 0 && <p className="note">{tx.noChanges}</p>}
          <p className="note">{u.enabled ? tx.through(u.through ? day(u.through) : '—') : tx.autoNote(u.autoDays)}</p>
          {!u.rows.length ? <p className="note">{u.enabled ? tx.nothingThrough(u.through ? day(u.through) : tx.theNextDays) : tx.nothingNext(u.autoDays)}</p> : (
            <div className="crew-list">
              {u.rows.map(r => <UpcomingRow key={r.key} r={r} act={act} reload={reload} lang={lang}
                tag={(() => { const m = u.movements.find(x => x.key === r.key);
                              return !m ? null : m.kind === 'added' ? tx.tagNew : m.kind === 'moved' ? tx.tagMoved(day(m.from)) : m.kind === 'time' ? tx.tagTime : null; })()} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One clean ahead. A cleaner can turn it down: it goes back to the team, unassigned. */
function UpcomingRow({ r, act, reload, tag, lang }: { r: CrewUpcoming; act?: Act; reload: () => void; tag?: string | null; lang: Lang }) {
  const tx = TX[lang];
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const decline = async () => {
    if (!act) return;
    setBusy(true); setMsg('');
    const res = await act({ action: 'decline', key: r.key, reason }).catch(e => ({ ok: false, message: String(e) }));
    setBusy(false);
    if (!res.ok) { setMsg(res.message ?? tx.notSaved); return; }
    reload();
  };
  return (
    <div className="crew-row">
      <div><b>{dayLabel(lang, r.date)}</b> · {r.unit}{r.beds ? ` · ${bedsWord(lang, r.beds)}` : ''}
        {tag && <div className={tag.startsWith('○') ? 'sub-n' : 'breach'}>{tag}</div>}</div>
      <div>
        {r.manual ? tx.manualClean(kindWord(lang, r.manual)) : tx.checkout(r.time)}
        {r.sameDay && <span className="ops-flag urgent">{r.checkIn ? tx.nextGuestAt(r.checkIn) : tx.nextGuestSameDay}</span>}
        {r.deep && <span className="ops-flag deep">{tx.deep}</span>}
      </div>
      <div className="n">{r.price == null ? tx.notPriced : money2(r.price)}
        {act && !declining && <div><button className="link tiny" onClick={() => setDeclining(true)}>{tx.cantDoIt}</button></div>}</div>
      {declining && (
        <div className="crew-decide">
          <input value={reason} maxLength={300} placeholder={tx.whyOptional} onChange={e => setReason(e.target.value)} />
          <button className="small" disabled={busy} onClick={() => void decline()}>{busy ? tx.sending : tx.declineBtn}</button>
          <button className="small secondary" disabled={busy} onClick={() => setDeclining(false)}>{tx.keepIt}</button>
          <span className="note">{tx.declineNote}</span>
        </div>
      )}
      {msg && <div className="breach">{msg}</div>}
    </div>
  );
}

function CleanRow({ c, extras, today, extraFrom, mode, canEdit, act, upload, reload, lang }: {
  c: CrewClean; extras: CrewExtra[]; today: string; extraFrom: string; mode: 'cleaner' | 'team'; canEdit: boolean;
  act: Act; upload?: Upload; reload: () => void; lang: Lang;
}) {
  const tx: Tx = TX[lang];
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
    if (!r.ok) { setMsg(r.message ?? tx.notSaved); return; }
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
      <div><b>{dayLabel(lang, c.date)}</b> · {c.unit}{c.beds ? ` · ${bedsWord(lang, c.beds)}` : ''}{c.deep ? ` · ${tx.deep}` : ''}
        {c.kind !== 'checkout' && <span className="sub-n">{tx.manualTag(kindWord(lang, c.kind))}</span>}</div>
      <div>
        {c.voidReason ? <span className="note">{tx.notPaidReason(voidReasonText(lang, c.voidReason))}</span>
          : upcoming ? <span className="note">{tx.comingUpTag}</span>
          : billed ? <span>✓ {c.price == null ? tx.notPriced : money2(c.price)}</span>
          : <span className="note">{tx.notYours}</span>}
        {c.flagNote && <div className="breach">{tx.flaggedNote(c.flagNote)}</div>}
        {c.editNote && <div className="sub-n">{tx.corrected(c.editNote)}</div>}
        {extras.map(e => (
          <div key={e.id} className={e.status === 'denied' ? 'breach' : 'sub-n'}>
            Extra +{money2(e.amount)} — {e.description} · {tx.extraWord[e.status]}
            {e.decisionNote && <> · “{e.decisionNote}”</>} <Files files={e.files} />
            {mode === 'cleaner' && e.status === 'pending' && <>
              <label className="link tiny crew-attach">{tx.attach}
                <input type="file" accept={ACCEPT} multiple hidden disabled={busy} onChange={ev => void attach(e.id, ev.target.files)} /></label>
              <button className="link tiny" disabled={busy} onClick={() => void send({ action: 'cancelExtra', id: e.id })}>{tx.withdraw}</button>
            </>}
            {mode === 'team' && canEdit && e.status === 'pending' && <Decide id={e.id} onDone={reload} />}
          </div>
        ))}
      </div>
      <div className="crew-actions no-print">
        {mode === 'cleaner' && billed && c.date >= extraFrom && !adding &&
          <button className="link tiny" onClick={() => setAdding(true)}>{tx.addExtra}</button>}
        {mode === 'team' && canEdit && c.date < today && !correcting &&
          <button className="link tiny" onClick={() => { setCorrecting(true); setDeep(c.deep); setAmount(c.price == null ? '' : String(c.price)); }}>✎ Correct</button>}
        {mode === 'team' && canEdit && !flagging && (c.flagNote
          ? <button className="link tiny" onClick={() => void send({ action: 'unflag', key: c.key })}>Remove flag</button>
          : <button className="link tiny" onClick={() => { setFlagging(true); setAmount(''); }}>⚑ Flag</button>)}
      </div>
      {adding && (
        <div className="crew-decide">
          <input className="amt" inputMode="decimal" value={amount} placeholder="$" onChange={e => setAmount(e.target.value)} />
          <input value={text} maxLength={300} placeholder={tx.whatFor} onChange={e => setText(e.target.value)} />
          <label className="crew-attach">{tx.receiptOptional}
            <input type="file" accept={ACCEPT} multiple onChange={e => setFiles([...(e.target.files ?? [])])} /></label>
          <button className="small" disabled={busy || !(Number(amount) > 0) || Number(amount) > EXTRA_MAX_AMOUNT || !text.trim()}
                  onClick={() => void sendExtra()}>{busy ? tx.sending : tx.sendTeam}</button>
          <button className="small secondary" onClick={() => setAdding(false)}>{tx.cancel}</button>
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
          {/* §128: a clean already due can have its pay corrected in the same step; blank keeps it. */}
          {billed && <input className="amt" inputMode="decimal" value={amount} placeholder={c.price != null ? `pays ${c.price}` : 'pay'}
                            title="Leave blank to keep the pay as it is" onChange={e => setAmount(e.target.value)} />}
          <button className="small" disabled={!text.trim() || busy || (amount !== '' && !(Number(amount) >= 0))}
                  onClick={() => void send({ action: 'flag', key: c.key, note: text, ...(billed && amount !== '' ? { price: Number(amount) } : {}) })}>
            {billed && amount !== '' ? 'Flag and correct pay' : 'Flag'}</button>
          <button className="small secondary" onClick={() => setFlagging(false)}>Cancel</button>
        </div>
      )}
      {msg && <div className="breach">{msg}</div>}
    </div>
  );
}

/** The invoice Kaizen builds — printed or saved as PDF from the browser. */
function InvoiceView({ page, lang }: { page: CrewPage; lang: Lang }) {
  const inv = page.invoice;
  const tx = TX[lang];
  const kind = page.cleaner.invoicePeriod;
  const paid = payNote(lang, inv.period, kind);
  // The work, said in the cleaner's language from the clean itself.
  const work = (key: string, fallback: string) => {
    const c = page.cleans.find(x => x.key === key);
    return c ? workText(lang, c) : fallback;
  };
  return (
    <div className="card crew-invoice">
      <div className="crew-invoice-head">
        <div><h2>Invoice {inv.number}</h2>
          <div>{tx.from}: <b>{page.cleaner.name}</b></div>
          <div>{tx.to}: <b>Kaizen Guest Properties</b></div>
          <div>{tx.period}: {periodLabel(lang, inv.period, kind)} ({inv.period.from} – {inv.period.to})</div>
          <div>{tx.paid}: <b>{paid}</b></div></div>
        <button className="secondary no-print" onClick={() => window.print()}>{tx.print}</button>
      </div>
      {inv.open && <p className="note">{tx.open(dayLabel(lang, inv.period.to), paid)}</p>}
      <table className="units compact">
        <thead><tr><th>{tx.colDate}</th><th>{tx.colUnit}</th><th>{tx.colWork}</th><th className="n">{tx.colAmount}</th></tr></thead>
        <tbody>
          {inv.lines.map(l => (
            <Fragment key={l.key}>
              <tr><td>{l.date}</td><td>{l.unit}</td><td>{work(l.key, l.what)}{l.flag ? ' ⚑' : ''}</td>
                <td className="n">{l.amount == null ? <span className="note">{tx.notPriced}</span> : money2(l.amount)}</td></tr>
              {inv.extras.filter(e => e.key === l.key).map(e => (
                <tr key={e.id}><td></td><td></td><td>{tx.extraLine(e.description)}</td><td className="n">{money2(e.amount)}</td></tr>
              ))}
            </Fragment>
          ))}
          {!inv.lines.length && <tr><td colSpan={4} className="note">{tx.noPaid}</td></tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>{tx.cleans}</td><td className="n">{money2(inv.cleansTotal)}</td></tr>
          {inv.extrasTotal > 0 && <tr><td colSpan={3}>{tx.approvedExtras}</td><td className="n">{money2(inv.extrasTotal)}</td></tr>}
          <tr><td colSpan={3}><b>{tx.total}</b></td><td className="n"><b>{money2(inv.total)}</b></td></tr>
        </tfoot>
      </table>
      {inv.unpriced > 0 && <p className="breach">{tx.unpriced(inv.unpriced)}</p>}
      {inv.pendingExtras > 0 && <p className="note">{tx.pendingExtras(inv.pendingExtras)}</p>}
      {inv.excluded.length > 0 && (
        <div className="note">{tx.notPaidIn}
          <ul>{inv.excluded.map(x => <li key={x.key}>{x.date} · {x.unit} — {voidReasonText(lang, x.reason)}</li>)}</ul></div>
      )}
    </div>
  );
}
