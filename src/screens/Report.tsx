/**
 * /report — the page whoever helps a cleaner opens from the link the cleaner
 * sent for ONE clean (§134). No account: the link's secret is the only
 * credential, and all it can do is report about that clean.
 *
 * Step by step, for people who are not at home on a phone: the clean
 * (unit and day, big) is always on top so nobody wonders where they are;
 * the name is asked once and remembered; then the clean's own steps
 * (photos before, after, done), and below them anything else to tell —
 * one question per screen, and a ✓ when it arrived. The header is one line
 * (language beside day/night) so the clean is what fills the screen.
 */
import { useEffect, useState } from 'react';
import { getReportLink, sendFieldReport, type ReportTeam } from '../api.ts';
import { FieldReport } from '../components/FieldReport.tsx';
import { CleanSteps, type Result } from '../components/CleanSteps.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { LANGS, LANG_NAME, TX, dayLabel, isLang, type Lang } from '../lib/crew-i18n.ts';

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function ReportPage({ token }: { token: string | null }) {
  const [team, setTeam] = useState<ReportTeam | null>(null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState<Lang | null>(() => { const l = get('reportLang'); return isLang(l) ? l : null; });
  const [name, setName] = useState(() => get('reportName') ?? '');
  const [named, setNamed] = useState(() => !!get('reportName'));
  const shown: Lang = lang ?? team?.lang ?? 'es';
  const tx = TX[shown];

  useEffect(() => {
    if (!token) return;
    getReportLink(token).then(r => { if (r.ok) setTeam(r); else setErr(r.message ?? tx.loadFail); }).catch(e => setErr(String(e)));
  }, []);

  const post = (f: Record<string, string>, files: File[]) =>
    sendFieldReport('/api/report-link', { 'X-Report-Token': token! }, { ...f, reporter: name.trim() }, files);
  const head = (
    <header className="mini-head">
      <span className="mini-brand">Kaizen</span>
      <span className="mini-tools">
        <span className="todo-kind" role="group" aria-label="Language / Idioma">
          {LANGS.map(l => <button key={l} className={l === shown ? 'chip active' : 'chip'} aria-label={LANG_NAME[l]}
                                  onClick={() => { setLang(l); put('reportLang', l); }}>{l.toUpperCase()}</button>)}
        </span>
        <ThemeToggle />
      </span>
    </header>
  );

  if (!token) return <>{head}<p className="banner error">{TX.en.repBad} / {TX.es.repBad}</p></>;
  if (err) return <>{head}<p className="banner error report-page">{err}</p></>;
  if (!team) return <>{head}<p className="note loading-dot">…</p></>;
  return (
    <>{head}
    <div className="report-page">
      <div className="card report-clean">
        <p className="report-head">🏠 {team.clean.unit}</p>
        <p className="fr-q">{dayLabel(shown, team.clean.date)}</p>
        <p className="fr-kind">{tx.repFor(team.team)}</p>
      </div>
      {!named ? (
        <div className="card">
          <div className="fr">
            <p className="fr-q">{tx.repName}</p>
            <input className="fr-select" value={name} maxLength={60} autoComplete="given-name"
                   onChange={e => setName(e.target.value)} />
            <p className="fr-tip">{tx.repNameNote}</p>
            <button className="fr-btn fr-go" disabled={!name.trim()}
                    onClick={() => { put('reportName', name.trim()); setNamed(true); }}>{tx.repContinue}</button>
          </div>
        </div>
      ) : <>
        <div className="card">
          <p className="fr-kind">👤 {name} · <button className="link" onClick={() => setNamed(false)}>{tx.repChange}</button></p>
          <CleanSteps tx={tx} items={team.items} state={team.state}
                      sendPhoto={(stage, f) => post({ kind: 'photo', stage }, [f]) as Promise<Result>}
                      taken={lines => post(lines ? { kind: 'taken', lines: JSON.stringify(lines) } : { kind: 'nothing' }, []) as Promise<Result>}
                      mark={kind => post({ kind }, []) as Promise<Result>} />
        </div>
        <div className="card">
          <FieldReport tx={tx} items={team.items} send={post} />
        </div>
      </>}
    </div>
    </>
  );
}
