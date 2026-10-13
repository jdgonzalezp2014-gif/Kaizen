/**
 * /report — the page whoever helps a cleaner opens from the link the cleaner
 * sent for ONE clean (§134). No account: the link's secret is the only
 * credential, and all it can do is report about that clean.
 *
 * Step by step, for people who are not at home on a phone: the clean
 * (unit and day, big) is always on top so nobody wonders where they are;
 * the name is asked once and remembered; then the clean's own steps
 * (photos before, after, done), and below them anything else to tell —
 * one question per screen, and a ✓ when it arrived. The header IS the clean
 * (the unit, the day small under it), with the language beside day/night;
 * under it two big tabs — "My clean" and "Report or ask" — so both are seen
 * without scrolling (the owner could not find the reports below the steps).
 */
import { useEffect, useState } from 'react';
import { getReportLink, sendFieldReport, type ReportTeam } from '../api.ts';
import { FieldReport, KINDS } from '../components/FieldReport.tsx';
import { CleanSteps, type Result } from '../components/CleanSteps.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { AccessBox } from '../components/AccessBox.tsx';
import { LANGS, LANG_NAME, TX, dayLabel, isLang, type Lang } from '../lib/crew-i18n.ts';

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/**
 * Every clean this phone was sent a link for (§134): a helper can get two
 * cleans from the same cleaner — each link opens its own, and from a home-
 * screen icon the page shows a list to switch. Kept while the link lasts.
 */
interface Saved { t: string; unit: string; date: string; until: string }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const savedLinks = (): Saved[] => {
  try { return (JSON.parse(get('reportLinks') ?? '[]') as Saved[]).filter(s => s.t && s.until >= today()); } catch { return []; }
};
const remember = (s: Saved) => put('reportLinks', JSON.stringify([s, ...savedLinks().filter(x => x.t !== s.t)]
  .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10)));
const forget = (t: string) => put('reportLinks', JSON.stringify(savedLinks().filter(x => x.t !== t)));

/** §139 practice: the helper's page with example data, its steps kept in the browser — and nothing of this phone's saved. */
type Post = (f: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string; state?: ReportTeam['state'] }>;

export function ReportPage({ token: first, practice }: { token: string | null; practice?: { team: ReportTeam; post: Post } }) {
  const [token, setToken] = useState(practice ? 'practice' : first);
  const [links, setLinks] = useState<Saved[]>(practice ? [] : savedLinks);
  const [team, setTeam] = useState<ReportTeam | null>(practice?.team ?? null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState<Lang | null>(() => { const l = get('reportLang'); return isLang(l) ? l : null; });
  const [name, setName] = useState(() => practice ? '' : get('reportName') ?? '');
  const [named, setNamed] = useState(() => !practice && !!get('reportName'));
  const keep = (k: string, v: string) => { if (!practice) put(k, v); };
  const [tab, setTab] = useState<'clean' | 'report'>('clean');
  const shown: Lang = lang ?? team?.lang ?? 'es';
  const tx = TX[shown];

  useEffect(() => {
    if (!token || practice) return;
    setTeam(null); setErr(''); setTab('clean');
    getReportLink(token).then(r => {
      if (r.ok) { setTeam(r); remember({ t: token, unit: r.clean.unit, date: r.clean.date, until: r.clean.until }); put('reportToken', token); }
      else { setErr(r.message ?? tx.loadFail); forget(token); }
      setLinks(savedLinks());
    }).catch(e => setErr(String(e)));
  }, [token]);
  // More than one clean on this phone: a big list on top to switch between them.
  const others = links.length > 1 || (err && links.some(l => l.t !== token)) ? (
    <label className="report-switch">{tx.repSwitch}
      <select className="fr-select" value={token ?? ''} onChange={e => setToken(e.target.value)}>
        {!links.some(l => l.t === token) && <option value={token ?? ''}>—</option>}
        {links.map(l => <option key={l.t} value={l.t}>🏠 {l.unit} — {dayLabel(shown, l.date)}</option>)}
      </select>
    </label>
  ) : null;

  const post = (f: Record<string, string>, files: File[]) => practice ? practice.post({ ...f, reporter: name.trim() }, files)
    : sendFieldReport('/api/report-link', { 'X-Report-Token': token! }, { ...f, reporter: name.trim() }, files);
  const head = (
    <header className="mini-head">
      {team ? <span className="mini-clean"><b>🏠 {team.clean.unit}</b><small>{dayLabel(shown, team.clean.date)}</small></span>
            : <span className="mini-brand">Kaizen</span>}
      <span className="mini-tools">
        <span className="todo-kind" role="group" aria-label="Language / Idioma">
          {LANGS.map(l => <button key={l} className={l === shown ? 'chip active' : 'chip'} aria-label={LANG_NAME[l]}
                                  onClick={() => { setLang(l); keep('reportLang', l); }}>{l.toUpperCase()}</button>)}
        </span>
        <ThemeToggle />
      </span>
    </header>
  );

  if (!token) return <>{head}<p className="banner error">{TX.en.repBad} / {TX.es.repBad}</p></>;
  if (err) return <>{head}{others}<p className="banner error report-page">{err}</p></>;
  if (!team) return <>{head}<p className="note loading-dot">…</p></>;
  return (
    <>{head}
    <div className="report-page">
      {others}
      {!named ? (
        <div className="card">
          <div className="fr">
            <p className="fr-q">{tx.repName}</p>
            <input className="fr-select" value={name} maxLength={60} autoComplete="given-name"
                   onChange={e => setName(e.target.value)} />
            <p className="fr-tip">{tx.repNameNote}</p>
            <button className="fr-btn fr-go" disabled={!name.trim()}
                    onClick={() => { keep('reportName', name.trim()); setNamed(true); }}>{tx.repContinue}</button>
          </div>
        </div>
      ) : <>
        <div className="report-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'clean'} className={tab === 'clean' ? 'on' : ''} onClick={() => setTab('clean')}>{tx.tabClean}</button>
          <button role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>{tx.tabReport}</button>
        </div>
        <p className="fr-kind report-who">👤 {name} · <button className="link" onClick={() => setNamed(false)}>{tx.repChange}</button></p>
        {tab === 'clean' ? <div className="card">
          {team.access && <div style={{ marginBottom: 12 }}><AccessBox tx={tx} a={team.access} /></div>}
          <CleanSteps tx={tx} items={team.items} state={team.state} onState={s => setTeam(t => t && { ...t, state: s })} place={team.access?.supplies ?? null}
                      sendPhoto={(stage, f) => post({ kind: 'photo', stage }, [f]) as Promise<Result>}
                      taken={(lines, out) => post(lines ? { kind: 'taken', lines: JSON.stringify(lines), out: JSON.stringify(out) }
                                                        : { kind: 'nothing', out: JSON.stringify(out) }, []) as Promise<Result>}
                      mark={kind => post({ kind }, []) as Promise<Result>} />
        </div> : <div className="card">
          <FieldReport tx={tx} items={team.items} send={post} kinds={KINDS.filter(k => k !== 'purchase')} />
        </div>}
      </>}
    </div>
    </>
  );
}
