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
  crewAction, crewAdminAction, crewCleanLink, crewPhoto, crewReport, crewUpload, getCrew, getCrewAdmin, getCrewAsCleaner,
  type CleanFieldState, type CleanLink, type CrewPage, type CrewSchedule, type CrewUpcoming, type PendingExtra, type ToConfirm
} from '../api.ts';
import type { CrewClean, CrewExtra } from '../lib/crew.ts';
import { isBilled, movementText, EXTRA_MAX_AMOUNT, type Movement } from '../lib/crew.ts';
import {
  DOW_LETTER, LANGS, LANG_NAME, TX, bedsWord, dayLabel, kindWord, monthTitle, movementFor, payNote, periodLabel,
  stampLabel, voidReasonText, workText, type Lang, type Tx
} from '../lib/crew-i18n.ts';
import { money2 } from '../lib/format.ts';
import { addDays } from '../lib/dates.ts';
import { FieldReport, KINDS, type Kind, type Send } from '../components/FieldReport.tsx';
import { CleanSteps, type Result } from '../components/CleanSteps.tsx';
import { PhotoPicker, shrink } from '../components/PhotoPicker.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { AccessBox } from '../components/AccessBox.tsx';
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
                   act={act} upload={asCleaner ? inert : (f, files) => crewUpload(f, files, token)}
                   report={asCleaner ? inert : (f, files) => crewReport(f, files, token)}
                   shareLink={asCleaner ? inert : key => crewCleanLink(key, token)}
                   photo={id => crewPhoto(id, asCleaner ? { asCleaner } : { token })} />;
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

function CrewView({ page, mode, canEdit = false, onPeriod, reload, act, upload, report, shareLink, photo, lang = 'en', onLang }: {
  page: CrewPage; mode: 'cleaner' | 'team'; canEdit?: boolean;
  onPeriod: (from: string) => void; reload: () => void;
  act: Act; upload?: Upload;
  /** §134: supplies and problems, and the link for the people they hire — the cleaner's page only. */
  report?: Send; shareLink?: ShareLink; photo?: (id: string) => Promise<string>;
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
  // §134: Options on each clean of the cleaner's own (today and ahead in Coming up; the last days in Cleans).
  const ctx: FieldCtx | undefined = report && shareLink && photo && page.supplies && mode === 'cleaner'
    ? { report, shareLink, photo, supplies: page.supplies, today: page.today, extraFrom: page.extraFrom, reload } : undefined;
  const aheadKeys = new Set(page.upcoming.rows.map(r => r.key));
  const [sec, setSec] = useState<'up' | 'today' | 'past' | 'future' | 'pay' | 'help'>('up');

  const cleansList = (noExtraFor: Set<string>, fieldCtx?: FieldCtx) => (
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
                      fs={aheadKeys.has(c.key) ? undefined : page.field?.[c.key]} noExtra={noExtraFor.has(c.key)}
                      quick={fieldCtx ? quickFor(page, c.key, fieldCtx) : undefined}
                      mode={mode} canEdit={canEdit} act={act} upload={upload} reload={reload} lang={lang} />
          ))}
        </div>
      )}
    </div>
  );
  const periodPick = (
    <label>{tx.periodField(kind)}
      <select value={period.from} onChange={e => onPeriod(e.target.value)}>
        {page.periods.map(p => <option key={p.from} value={p.from}>{periodLabel(lang, p, kind)}</option>)}
      </select></label>
  );
  const help = page.help?.filter(h => (h.lang ?? 'en') === lang) ?? [];

  // §134, the owner: no wasted space on top — one line (hello, language, help, day/night) and the
  // sections right under it: Today (a button per clean), Past (open to edit, close each), Future (share
  // or turn down) and Pay (the list and invoice, each recent row with the same small buttons).
  if (mode === 'cleaner' && ctx) {
    const active = activeCleans(page);
    const todays = active.filter(a => a.date === page.today);
    const past = active.filter(a => a.date < page.today);
    const future = page.upcoming.rows.filter(r => r.date > page.today);
    const activeKeys = new Set(active.map(a => a.key));
    const sec2 = sec === 'up' ? (todays.length ? 'today' : future.length ? 'future' : 'today') : sec;
    const secs: [typeof sec2, string][] = [['today', tx.secToday(todays.length)], ['past', tx.secPast(past.length)],
      ['future', tx.secFuture(future.length)], ['pay', tx.secPay]];
    return (
      <div className="crew">
        <div className="crew-top no-print">
          <b className="crew-top-name">{tx.hi(page.cleaner.name)}{!page.cleaner.active && <span className="chan-tag">{tx.inactive}</span>}</b>
          <span className="mini-tools">
            {onLang && <span className="todo-kind" role="group" aria-label="Language / Idioma">
              {LANGS.map(l => <button key={l} className={l === lang ? 'chip active' : 'chip'} aria-label={LANG_NAME[l]} onClick={() => onLang(l)}>{l.toUpperCase()}</button>)}
            </span>}
            {!!help.length && <button className={sec2 === 'help' ? 'chip active' : 'chip'} aria-label={tx.secHelp} onClick={() => setSec(sec2 === 'help' ? 'up' : 'help')}>❓</button>}
            <ThemeToggle />
          </span>
        </div>
        <div className="crew-secs no-print" role="tablist">
          {secs.map(([k, l]) => <button key={k} role="tab" aria-selected={sec2 === k} className={sec2 === k ? 'on' : ''} onClick={() => setSec(k)}>{l}</button>)}
        </div>

        {sec2 === 'today' && <TodayCleans list={todays} page={page} lang={lang} ctx={ctx} act={act} reload={reload} />}
        {sec2 === 'past' && <PastCleans list={past} page={page} lang={lang} ctx={ctx} act={act} reload={reload} />}
        {sec2 === 'future' && <>
          <Upcoming page={page} act={act} reload={reload} lang={lang} ctx={ctx} afterToday />
          <CrewCalendar page={page} lang={lang} />
        </>}
        {sec2 === 'pay' && <>
          <div className="card no-print">{periodPick}</div>
          {cleansList(activeKeys, ctx)}
          <InvoiceView page={page} lang={lang} />
        </>}
        {sec2 === 'help' && (
          <div className="card no-print">
            {help.map(h => (
              <details key={h.title} open={help.length === 1}>
                <summary><b>❓ {h.title}</b></summary>
                {h.purpose && <p className="note">{h.purpose}</p>}
                <ol>{h.steps.map((st, i) => <li key={i}>{st.text}{st.detail && <div className="note crew-help">{st.detail}</div>}</li>)}</ol>
                {h.body && <div className="note crew-help">{h.body}</div>}
              </details>
            ))}
          </div>
        )}
      </div>
    );
  }

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
        {periodPick}
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
      <Upcoming page={page} act={mode === 'cleaner' ? act : undefined} reload={reload} lang={lang} ctx={ctx} />
      {/* §134: right under what is coming — reporting supplies is what they do after each clean. */}
      <CrewCalendar page={page} lang={lang} />

      {cleansList(new Set())}

      <InvoiceView page={page} lang={lang} />
    </div>
  );
}

/* ── reports and the helper's link, per clean (§134) ─────────────── */

type ShareLink = (key: string) => Promise<{ ok: boolean; message?: string } & Partial<CleanLink>>;
/** What a clean row needs to offer its Options — absent on the team's view. */
interface FieldCtx { report: Send; shareLink: ShareLink; supplies: NonNullable<CrewPage['supplies']>; today: string; extraFrom: string; reload: () => void;
  /** A photo of one of their cleans, as an object URL. */ photo: (id: string) => Promise<string> }

/** A clean the cleaner works today or did in the last days (§134). */
interface ActiveClean {
  key: string; date: string; unit: string; beds: number | null; deep: boolean; time: string | null; manual: string | null;
  sameDay: boolean; checkIn: string | null; price: number | null; tasks?: string[];
  /** Still in "Coming up" (today's): it can still be turned down. */
  ahead: boolean;
}

/** Today's cleans (from Coming up, else the record), then the last 3 days' — newest first. */
function activeCleans(page: CrewPage): ActiveClean[] {
  const from = addDays(page.today, -3);
  const out = new Map<string, ActiveClean>();
  for (const r of page.upcoming.rows) if (r.date === page.today) out.set(r.key, {
    key: r.key, date: r.date, unit: r.unit, beds: r.beds, deep: r.deep, time: r.time, manual: r.manual,
    sameDay: r.sameDay, checkIn: r.checkIn, price: r.price, tasks: r.tasks, ahead: true });
  for (const c of page.cleans) if (!out.has(c.key) && c.date <= page.today && c.date >= from && isBilled(c, page.today)) out.set(c.key, {
    key: c.key, date: c.date, unit: c.unit, beds: c.beds, deep: c.deep, time: null, manual: c.kind !== 'checkout' ? c.kind : null,
    sameDay: false, checkIn: null, price: c.price, ahead: false });
  return [...out.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * One of the cleaner's own cleans, worked like a helper works it (the owner:
 * the same for everyone but the extra) — "My clean" (the 4 steps), "Report or
 * ask", and "Extra", the cleaner's alone; the helper's link one tap below.
 * Every option is a tab on top — the owner: the cleaner sees them all and
 * switches with a tap; "Can't do it" sits with the clean's time.
 */
function CleanCard({ a, page, lang, ctx, act, reload, initialTab = 'clean', onClose, head = true }: {
  a: ActiveClean; page: CrewPage; lang: Lang; ctx: FieldCtx; act?: Act; reload: () => void;
  initialTab?: 'clean' | 'report' | 'extra' | 'share'; onClose?: () => void;
  /** False inside a row that already says which clean it is. */ head?: boolean;
}) {
  const tx = TX[lang];
  const [tab, setTab] = useState<'clean' | 'report' | 'extra' | 'share'>(initialTab);
  const [declining, setDeclining] = useState(false);
  const [fs, setFs] = useState<CleanFieldState | undefined>(page.field?.[a.key]);
  const unitId = ctx.supplies.units.find(u => u.name === a.unit)?.id ?? '';
  // An extra only on a clean done (today or before) and recent enough — the server checks the same.
  const extraOk = a.date <= ctx.today && a.date >= ctx.extraFrom;
  const extras = page.extras.filter(e => e.key === a.key && e.status !== 'cancelled');
  const tabs: ['clean' | 'report' | 'extra' | 'share', string][] = [['clean', tx.tabClean], ['report', tx.tabReport],
    ...(extraOk ? [['extra', tx.tabExtra] as ['extra', string]] : []), ['share', tx.tabShare]];
  return (
    <div className={head ? 'clean-card' : 'clean-card bare'}>
      {head && <>
        <div className="clean-card-top">
          <p className="clean-card-title"><b>{dayLabel(lang, a.date)}</b></p>
          {a.ahead && act && !declining && <DeclineButton tx={tx} onClick={() => setDeclining(true)} />}
        </div>
        {declining && act && <DeclineForm cleanKey={a.key} act={act} reload={reload} lang={lang} onCancel={() => setDeclining(false)} />}
        <p className="clean-card-unit">🏠 {a.unit}{a.beds ? <span className="sub-n"> · {bedsWord(lang, a.beds)}</span> : null}
          {a.price != null && <span className="sub-n"> · {money2(a.price)}</span>}</p>
        <p className="note">{a.manual ? tx.manualClean(kindWord(lang, a.manual)) : a.time ? tx.checkout(a.time) : ''}
          {a.sameDay && <span className="ops-flag urgent">{a.checkIn ? tx.nextGuestAt(a.checkIn) : tx.nextGuestSameDay}</span>}
          {a.deep && <span className="ops-flag deep">{tx.deep}</span>}</p>
        {page.access?.[a.key] && <AccessBox tx={tx} a={page.access[a.key]!} />}
        {!!a.tasks?.length && <div className="breach">{tx.fromInspection}<ul className="crew-moves">{a.tasks.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        <FieldLine fs={fs} lang={lang} />
        {extras.map(e => <p key={e.id} className={e.status === 'denied' ? 'breach' : 'sub-n'}>💵 +{money2(e.amount)} — {e.description} · {tx.extraWord[e.status]}</p>)}
      </>}
      <>
        <div className={`report-tabs ${['', '', 'two', 'three', 'four'][tabs.length]}`} role="tablist">
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'clean' && <CleanSteps tx={tx} items={ctx.supplies.items} state={fs} onState={setFs}
          sendPhoto={(stage, f) => ctx.report({ action: 'cleanPhoto', key: a.key, stage }, [f]) as Promise<Result>}
          taken={lines => ctx.report(lines ? { action: 'cleanTaken', key: a.key, lines: JSON.stringify(lines) }
                                           : { action: 'cleanNothing', key: a.key }, []) as Promise<Result>}
          mark={kind => ctx.report({ action: 'cleanMark', key: a.key, kind }, []) as Promise<Result>} />}
        {tab === 'report' && <FieldReport tx={tx} items={ctx.supplies.items}
          send={(f, files) => ctx.report({ ...f, cleaningKey: a.key, unitId }, files)} />}
        {tab === 'extra' && <ExtraPanel tx={tx} send={(f, files) => ctx.report({ action: 'addExtra', key: a.key, ...f }, files)}
          onClose={sent => { setTab('clean'); if (sent) reload(); }} />}
        {tab === 'share' && <SharePanel cleanKey={a.key} lang={lang} get={ctx.shareLink} onClose={() => setTab('clean')} />}
        {onClose && <div className="clean-card-foot"><button className="fr-btn secondary" onClick={onClose}>{tx.supClose}</button></div>}
      </>
    </div>
  );
}

/**
 * Today: one big button per clean when there are several — a row that stays
 * on top while scrolling (the owner: switch without scrolling back up), and
 * slides sideways when there are many; the chosen one open with its tabs.
 */
function TodayCleans({ list, page, lang, ctx, act, reload }: { list: ActiveClean[]; page: CrewPage; lang: Lang; ctx: FieldCtx; act?: Act; reload: () => void }) {
  const tx = TX[lang];
  // The first clean not yet done is the one to work on; after that, the cleaner's choice.
  const [pick, setPick] = useState(() => (list.find(x => !page.field?.[x.key]?.done) ?? list[0])?.key ?? '');
  const a = list.find(x => x.key === pick) ?? list[0];
  const choose = (k: string) => {
    setPick(k);
    // Back to the top of the chosen clean, just under the row that stays on top.
    requestAnimationFrame(() => document.getElementById('today-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  if (!a) return <div className="card no-print"><p className="note">{tx.activeNone}</p></div>;
  return (
    <div className="card no-print">
      {list.length > 1 && (
        <div className="today-picks" role="tablist">
          {list.map(x => <button key={x.key} role="tab" aria-selected={x.key === a.key} className={x.key === a.key ? 'on' : ''} onClick={() => choose(x.key)}>
            🏠 {x.unit}<small>{x.time ?? ''}{page.field?.[x.key]?.done ? ' · ✅' : ''}</small></button>)}
        </div>
      )}
      <div id="today-card" />
      <CleanCard key={a.key} a={a} page={page} lang={lang} ctx={ctx} act={act} reload={reload} />
    </div>
  );
}

/** The last days' cleans: a list; each opens to finish or fix it, and closes again. */
function PastCleans({ list, page, lang, ctx, act, reload }: { list: ActiveClean[]; page: CrewPage; lang: Lang; ctx: FieldCtx; act?: Act; reload: () => void }) {
  const tx = TX[lang];
  const [open, setOpen] = useState<string | null>(null);
  if (!list.length) return <div className="card no-print"><p className="note">{tx.pastNone}</p></div>;
  return (
    <div className="card no-print">
      <p className="note">{tx.pastNote}</p>
      {list.map(a => (
        <div key={a.key} className="past-row">
          <button className="past-head" aria-expanded={open === a.key} onClick={() => setOpen(open === a.key ? null : a.key)}>
            <span><b>{dayLabel(lang, a.date)}</b> · {a.unit}</span>
            <span className="sub-n">{page.field?.[a.key]?.done ? tx.doneShort : tx.notDoneYet} {open === a.key ? '▲' : '▼'}</span>
          </button>
          {open === a.key && <PastCard a={a} page={page} lang={lang} ctx={ctx} reload={reload} onClose={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  );
}

/**
 * A clean of the last days, as it was left (the owner: nothing more to
 * report or photograph on it): its photos before and after, done or not,
 * what was taken from the storage, its extras — and an extra can still go in.
 */
function PastCard({ a, page, lang, ctx, reload, onClose }: { a: ActiveClean; page: CrewPage; lang: Lang; ctx: FieldCtx; reload: () => void; onClose?: () => void }) {
  const tx = TX[lang];
  const [extra, setExtra] = useState(false);
  const fs = page.field?.[a.key];
  const photos = page.fieldPhotos?.[a.key] ?? [];
  const extraOk = a.date <= ctx.today && a.date >= ctx.extraFrom;
  const extras = page.extras.filter(e => e.key === a.key && e.status !== 'cancelled');
  if (extra) return <ExtraPanel tx={tx} send={(f, files) => ctx.report({ action: 'addExtra', key: a.key, ...f }, files)}
                                onClose={sent => { setExtra(false); if (sent) reload(); }} />;
  return (
    <div className="clean-card bare">
      <p className={fs?.done ? 'field-ok' : 'note'}>{fs?.done ? tx.doneBy(fs.done.by.replace(/^.*'s team: /, ''), fs.done.at.slice(11, 16)) : tx.notDoneYet}</p>
      {fs?.supplies && <p className="note">{fs.supplies.none ? tx.takenNone : `🧴 ${tx.takenCount(fs.supplies.lines)}`}</p>}
      {(['before', 'after'] as const).map(st => {
        const list = photos.filter(p => p.stage === st);
        return list.length ? <div key={st}>
          <p className="fr-cat">{st === 'before' ? tx.stepBefore : tx.stepAfter}</p>
          <div className="fr-thumbs">{list.map(p => <CrewImg key={p.id} id={p.id} get={ctx.photo} />)}</div>
        </div> : null;
      })}
      {!photos.length && <p className="note">{tx.noPhotos}</p>}
      {extras.map(e => <p key={e.id} className={e.status === 'denied' ? 'breach' : 'sub-n'}>💵 +{money2(e.amount)} — {e.description} · {tx.extraWord[e.status]}</p>)}
      {extraOk && <button className="fr-btn secondary" onClick={() => setExtra(true)}>{tx.optExtra}</button>}
      {onClose && <button className="fr-btn secondary" onClick={onClose}>{tx.supClose}</button>}
    </div>
  );
}

/** A clean's photo, fetched through Kaizen (the team's Drive is not theirs); tap to see it large, tap again to close. */
function CrewImg({ id, get }: { id: string; get: (id: string) => Promise<string> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let u: string | null = null, live = true;
    get(id).then(x => { u = x; if (live) setUrl(x); else URL.revokeObjectURL(x); }).catch(() => {});
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  if (!url) return <span className="fr-thumb loading-thumb" />;
  return <>
    <button className="fr-thumb" onClick={() => setBig(true)}><img src={url} alt="" /></button>
    {big && <button className="photo-big" onClick={() => setBig(false)}><img src={url} alt="" /></button>}
  </>;
}

/** The small buttons a row of "Cleans & pay" offers: the same as in Today / Past / Future. */
interface Quick { active?: ActiveClean; future?: boolean; ctx: FieldCtx; page: CrewPage }
function quickFor(page: CrewPage, key: string, ctx: FieldCtx): Quick | undefined {
  const active = activeCleans(page).find(a => a.key === key);
  if (active) return { active, ctx, page };
  if (page.upcoming.rows.some(r => r.key === key && r.date > page.today)) return { future: true, ctx, page };
  return undefined;
}

/** A row's small buttons, and what they open in place. */
function QuickActions({ q, cleanKey, lang, act, reload }: { q: Quick; cleanKey: string; lang: Lang; act: Act; reload: () => void }) {
  const tx = TX[lang];
  const [open, setOpen] = useState<null | 'clean' | 'report' | 'extra' | 'share' | 'past'>(null);
  const extraOk = !!q.active && q.active.date <= q.ctx.today && q.active.date >= q.ctx.extraFrom;
  const past = !!q.active && q.active.date < q.ctx.today;
  const btn = (k: NonNullable<typeof open>, label: string) =>
    <button className={open === k ? 'small' : 'small secondary'} onClick={() => setOpen(open === k ? null : k)}>{label}</button>;
  return (
    <div className="quick no-print">
      <div className="quick-row">
        {q.active && past && btn('past', tx.viewClean)}
        {q.active && !past && <>{btn('clean', tx.tabClean)}{btn('report', tx.tabReport)}{extraOk && btn('extra', tx.tabExtra)}</>}
        {!past && btn('share', tx.shareShort)}
        {q.future && <Decline cleanKey={cleanKey} act={act} reload={reload} lang={lang} />}
      </div>
      {open === 'share' && <SharePanel cleanKey={cleanKey} lang={lang} get={q.ctx.shareLink} onClose={() => setOpen(null)} />}
      {open === 'past' && q.active && <PastCard a={q.active} page={q.page} lang={lang} ctx={q.ctx} reload={reload} onClose={() => setOpen(null)} />}
      {open && open !== 'share' && open !== 'past' && q.active &&
        <CleanCard key={open} a={q.active} page={q.page} lang={lang} ctx={q.ctx} act={act} reload={reload} head={false}
                   initialTab={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * "Can't do it" — top right of the clean (the owner: by the tabs it was in
 * the way of everyday taps). The button opens the form below, full width:
 * a reason, then the turn-down confirmed in place.
 */
const DeclineButton = ({ tx, onClick }: { tx: Tx; onClick: () => void }) =>
  <button className="decline-btn" onClick={onClick}>✕ {tx.cantDoIt}</button>;

function DeclineForm({ cleanKey, act, reload, lang, onCancel }: { cleanKey: string; act: Act; reload: () => void; lang: Lang; onCancel: () => void }) {
  const tx = TX[lang];
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const decline = async () => {
    setBusy(true); setMsg('');
    const res = await act({ action: 'decline', key: cleanKey, reason }).catch(e => ({ ok: false, message: String(e) }));
    setBusy(false);
    if (!res.ok) { setMsg(res.message ?? tx.notSaved); return; }
    reload();
  };
  return (
    <div className="crew-decide decline-form">
      <input value={reason} maxLength={300} placeholder={tx.whyOptional} onChange={e => setReason(e.target.value)} />
      <button className="small" disabled={busy} onClick={() => void decline()}>{busy ? tx.sending : tx.declineBtn}</button>
      <button className="small secondary" disabled={busy} onClick={onCancel}>{tx.keepIt}</button>
      <span className="note">{tx.declineNote}</span>
      {msg && <span className="breach">{msg}</span>}
    </div>
  );
}

/** Both together, where there is no header to hold the button (a row's small buttons). */
function Decline({ cleanKey, act, reload, lang }: { cleanKey: string; act: Act; reload: () => void; lang: Lang }) {
  const [open, setOpen] = useState(false);
  return open ? <DeclineForm cleanKey={cleanKey} act={act} reload={reload} lang={lang} onCancel={() => setOpen(false)} />
    : <DeclineButton tx={TX[lang]} onClick={() => setOpen(true)} />;
}

/** Where a clean stands in the field: photos before/after (the Drive folder) and done — for the cleaner and the team. */
function FieldLine({ fs, lang, link = false }: { fs?: CleanFieldState; lang: Lang; /** The team's view: the Drive folder is theirs to open. */ link?: boolean }) {
  if (!fs || (!fs.before && !fs.after && !fs.done)) return null;
  const tx = TX[lang];
  return (
    <div className="sub-n clean-opts">
      {link && fs.folderUrl ? <a href={fs.folderUrl} target="_blank" rel="noreferrer">{tx.stateLine(fs.before, fs.after)}</a> : tx.stateLine(fs.before, fs.after)}
      {fs.done && <> · <b>{tx.stateDone(fs.done.by.replace(/^.*'s team: /, ''))}</b></>}
    </div>
  );
}

/**
 * An extra on this clean, in the same big, one-screen form as the rest: the
 * amount (number keypad), what it was for, the receipt with the same photo
 * buttons. The team approves or denies it; only approved extras are paid.
 */
function ExtraPanel({ tx, send, onClose }: { tx: Tx; send: Send; onClose: (sent: boolean) => void }) {
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const n = Number(amount);
  const missing = !(n > 0) || n > EXTRA_MAX_AMOUNT ? tx.extraNeedAmount(EXTRA_MAX_AMOUNT) : !text.trim() ? tx.extraNeedWhat : '';
  if (sent) return (
    <div className="fr fr-done" role="status">
      <p className="fr-big">{tx.supDone}</p><p>{tx.extraSent}</p>
      <button className="fr-btn" onClick={() => onClose(true)}>{tx.supClose}</button>
    </div>
  );
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await send({ amount: String(Math.round(n * 100) / 100), description: text.trim() }, await Promise.all(files.map(shrink)));
      if (!r.ok) setErr(r.message ?? tx.notSaved); else setSent(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="fr">
      <button className="link fr-back" onClick={() => onClose(false)} disabled={busy}>{tx.supClose}</button>
      <p className="fr-q">{tx.optExtra}</p>
      <p className="fr-tip">{tx.extraNote}</p>
      <p className="fr-q">{tx.extraAmount}</p>
      <input className="fr-select" type="number" inputMode="decimal" min="0" step="0.01" value={amount} aria-label={tx.extraAmount}
             onChange={e => setAmount(e.target.value)} />
      <p className="fr-q">{tx.extraWhat}</p>
      <textarea className="fr-text" rows={3} maxLength={300} value={text} onChange={e => setText(e.target.value)} />
      <p className="fr-tip">{tx.supSpeakTip}</p>
      <p className="fr-q">{tx.receiptOptional}</p>
      <PhotoPicker tx={tx} files={files} onChange={setFiles} max={5} disabled={busy} />
      <div className="fr-send">
        <button className="fr-btn fr-go" disabled={busy || !!missing} onClick={() => void go()}>{busy ? tx.sending : tx.sendTeam}</button>
        {missing && <p className="fr-missing">{missing}</p>}
        {err && <p className="breach" role="alert">{err}</p>}
      </div>
    </div>
  );
}

/** The link for whoever helps on this clean: WhatsApp first, the phone's share sheet, or copy. */
function SharePanel({ cleanKey, lang, get, onClose }: { cleanKey: string; lang: Lang; get: ShareLink; onClose: () => void }) {
  const tx = TX[lang];
  const [l, setL] = useState<CleanLink | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    get(cleanKey).then(r => { if (r.ok && r.link) setL(r as CleanLink); else setMsg(r.message ?? tx.notSaved); }).catch(e => setMsg(String(e)));
  }, [cleanKey]);
  if (!l) return <div className="fr">{msg ? <p className="breach">{msg}</p> : <p>{tx.sending}</p>}
    <button className="fr-btn secondary" onClick={onClose}>{tx.supClose}</button></div>;
  const day = dayLabel(lang, l.date);
  const text = tx.shareMsg(l.unit, day, l.link);
  return (
    <div className="fr">
      <p className="fr-q">{tx.shareFor(l.unit, day)}</p>
      <p>{tx.shareWhat} {tx.shareUntil(dayLabel(lang, l.expires))}</p>
      <div className="share-row">
        <a className="fr-btn share-wa" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">💬 {tx.shareWa}</a>
        {typeof navigator.share === 'function' &&
          <button className="fr-btn secondary" onClick={() => void navigator.share({ text }).catch(() => {})}>📤 {tx.shareMore}</button>}
        <button className="fr-btn secondary" onClick={() => void navigator.clipboard.writeText(text).then(() => setMsg(tx.shareCopied), () => setMsg(l.link))}>
          📋 {tx.shareCopy}</button>
        {msg && <p className="fr-big" style={{ fontSize: 18 }}>{msg}</p>}
        <button className="fr-btn secondary" onClick={onClose}>{tx.supClose}</button>
      </div>
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

function Upcoming({ page, act, reload, lang, ctx, afterToday = false }: { page: CrewPage; act?: Act; reload: () => void; lang: Lang; ctx?: FieldCtx; afterToday?: boolean }) {
  // In the cleaner's layout today's cleans are worked above ("Your cleans"); here only what is ahead.
  const u = afterToday ? { ...page.upcoming, rows: page.upcoming.rows.filter(r => r.date > page.today) } : page.upcoming;
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
              {u.rows.map(r => <UpcomingRow key={r.key} r={r} act={act} reload={reload} lang={lang} ctx={ctx} fs={page.field?.[r.key]} address={page.addresses?.[r.key]}
                tag={(() => { const m = u.movements.find(x => x.key === r.key);
                              return !m ? null : m.kind === 'added' ? tx.tagNew : m.kind === 'moved' ? tx.tagMoved(day(m.from)) : m.kind === 'time' ? tx.tagTime : null; })()} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One clean ahead. Nothing to report on it yet (the owner): the cleaner can
 * send the helper's link now, or turn it down — it goes back to the team.
 */
function UpcomingRow({ r, act, reload, tag, lang, ctx, fs, address }: { r: CrewUpcoming; act?: Act; reload: () => void; tag?: string | null; lang: Lang; ctx?: FieldCtx; fs?: CleanFieldState;
  /** §136: where it is — the codes come on the day. */ address?: string }) {
  const tx = TX[lang];
  const [sharing, setSharing] = useState(false);
  const [declining, setDeclining] = useState(false);
  return (
    <div className="crew-row">
      <div><div className="clean-card-top"><span><b>{dayLabel(lang, r.date)}</b> · {r.unit}{r.beds ? ` · ${bedsWord(lang, r.beds)}` : ''}</span>
          {act && !declining && <DeclineButton tx={tx} onClick={() => setDeclining(true)} />}</div>
        {tag && <div className={tag.startsWith('○') ? 'sub-n' : 'breach'}>{tag}</div>}</div>
      <div>
        {r.manual ? tx.manualClean(kindWord(lang, r.manual)) : tx.checkout(r.time)}
        {r.sameDay && <span className="ops-flag urgent">{r.checkIn ? tx.nextGuestAt(r.checkIn) : tx.nextGuestSameDay}</span>}
        {r.deep && <span className="ops-flag deep">{tx.deep}</span>}
        {!!r.tasks?.length && <div className="breach">{tx.fromInspection}<ul className="crew-moves">{r.tasks.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        {address && <div className="sub-n">📍 <a href={`https://maps.google.com/?q=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">{address}</a></div>}
      </div>
      <div className="n">{r.price == null ? tx.notPriced : money2(r.price)}</div>
      {declining && act && <DeclineForm cleanKey={r.key} act={act} reload={reload} lang={lang} onCancel={() => setDeclining(false)} />}
      <FieldLine fs={fs} lang={lang} link={!act && !ctx} />
      {ctx && (
        <div className="future-actions no-print">
          {!sharing ? <button className="fr-btn secondary" onClick={() => setSharing(true)}>{tx.optShare}</button>
            : <SharePanel cleanKey={r.key} lang={lang} get={ctx.shareLink} onClose={() => setSharing(false)} />}
        </div>
      )}
    </div>
  );
}

function CleanRow({ c, extras, today, extraFrom, mode, canEdit, act, upload, reload, lang, noExtra = false, fs, quick }: {
  c: CrewClean; extras: CrewExtra[]; today: string; extraFrom: string; mode: 'cleaner' | 'team'; canEdit: boolean;
  /** §134: the same small actions as the sections above, on a recent or coming clean of the cleaner's. */ quick?: Quick;
  /** Worked in "Your cleans" above, where its extra is (§134). */ noExtra?: boolean; fs?: CleanFieldState;
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
      <FieldLine fs={fs} lang={lang} link={mode === 'team'} />
      {quick && <QuickActions q={quick} cleanKey={c.key} lang={lang} act={act} reload={reload} />}
      <div className="crew-actions no-print">
        {/* Recent cleans have their "Extra" tab in "Your cleans" (§134); older ones keep this link. */}
        {mode === 'cleaner' && !noExtra && billed && c.date >= extraFrom && !adding &&
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
