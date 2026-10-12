/**
 * /report — the page a cleaner's helpers open from the link they were sent
 * (§134). No account: the link's secret is the only credential, and all it
 * can do is report — what they took, bought, did not find, a problem, a need.
 *
 * Light on purpose: one card, the helper's name and language remembered on
 * the phone, nothing of the cleaner's or the team's shown.
 */
import { useEffect, useState } from 'react';
import { getReportLink, sendFieldReport, type ReportTeam } from '../api.ts';
import { FieldReport } from '../components/FieldReport.tsx';
import { LANGS, LANG_NAME, TX, isLang, type Lang } from '../lib/crew-i18n.ts';

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function ReportPage({ token }: { token: string | null }) {
  const [team, setTeam] = useState<ReportTeam | null>(null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState<Lang | null>(() => { const l = get('reportLang'); return isLang(l) ? l : null; });
  const [name, setName] = useState(() => get('reportName') ?? '');
  const shown: Lang = lang ?? team?.lang ?? 'es';
  const tx = TX[shown];

  useEffect(() => {
    if (!token) return;
    getReportLink(token).then(r => { if (r.ok) setTeam(r); else setErr(r.message ?? tx.loadFail); }).catch(e => setErr(String(e)));
  }, []);

  if (!token) return <p className="banner error">{TX.en.repBad} / {TX.es.repBad}</p>;
  if (err) return <p className="banner error">{err}</p>;
  if (!team) return <p className="note loading-dot">…</p>;
  return (
    <div className="report-page">
      <div className="card">
        <h2>{tx.repTitle(team.team)}</h2>
        <div className="todo-kind" role="group" aria-label="Language / Idioma">
          {LANGS.map(l => <button key={l} className={l === shown ? 'chip active' : 'chip'}
                                  onClick={() => { setLang(l); put('reportLang', l); }}>{LANG_NAME[l]}</button>)}
        </div>
        <label>{tx.repName}
          <input value={name} maxLength={60} autoComplete="name"
                 onChange={e => { setName(e.target.value); put('reportName', e.target.value.trim()); }} /></label>
        <p className="note">{tx.repNameNote}</p>
      </div>
      <div className="card">
        <h2>{tx.supTitle}</h2>
        <p className="note">{tx.supNote}</p>
        <FieldReport tx={tx} items={team.items} units={team.units}
                     guard={() => name.trim() ? null : tx.repNeedName}
                     send={(f, files) => sendFieldReport('/api/report-link', { 'X-Report-Token': token }, { ...f, reporter: name.trim() }, files)} />
      </div>
    </div>
  );
}
