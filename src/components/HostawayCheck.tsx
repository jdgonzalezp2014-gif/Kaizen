/**
 * Repository → "⇄ Check against Hostaway" (§149): each active unit, each check in CHECKS
 * (src/lib/repo-checks.ts), the two sides side by side and, for editors, a way to make them agree —
 * copy Hostaway's into the Repository, or send the Repository's to Hostaway (asked first, in place:
 * that changes what guests see).
 */
import { useEffect, useState } from 'react';
import { getRepoCheck, fixRepoCheck, type RepoCheckUnit, type RepoCheckDef } from '../api.ts';
import type { CheckStatus } from '../lib/repo-checks.ts';

const LOOK: Record<CheckStatus, { mark: string; word: string; cls: string }> = {
  match: { mark: '●', word: 'Same', cls: 'hc-ok' },
  case: { mark: '◐', word: 'Capitals differ', cls: 'hc-warn' },
  differ: { mark: '▲', word: 'Different', cls: 'hc-warn' },
  'no-repository': { mark: '○', word: 'Not in the Repository', cls: 'hc-gap' },
  'no-hostaway': { mark: '○', word: 'Not in Hostaway', cls: 'hc-gap' },
  empty: { mark: '○', word: 'Empty on both', cls: 'hc-gap' },
};

export function HostawayCheck({ canEdit, say, onClose }: { canEdit: boolean; say: (m: string) => void; onClose: () => void }) {
  const [defs, setDefs] = useState<RepoCheckDef[] | null>(null);
  const [units, setUnits] = useState<RepoCheckUnit[]>([]);
  const [err, setErr] = useState('');
  const [which, setWhich] = useState('wifi');
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  const load = async () => {
    setErr('');
    const r = await getRepoCheck();
    if (!r.ok) { setErr(r.message ?? 'Could not read Hostaway.'); return; }
    setDefs(r.checks); setUnits(r.units);
  };
  useEffect(() => { void load(); }, []);

  const fix = async (u: RepoCheckUnit, to: 'repository' | 'hostaway') => {
    const id = `${u.unitId}|${to}`;
    setBusy(id); setAsking(null);
    const r = await fixRepoCheck({ unitId: u.unitId, check: which, to });
    setBusy(null);
    if (!r.ok) { say(r.message ?? 'Not changed.'); return; }
    setUnits(us => us.map(x => x.unitId === u.unitId ? r.unit : x));
    say(to === 'repository' ? `${u.unit}: Repository updated from Hostaway` : `${u.unit}: Hostaway updated and read back`);
  };

  const def = defs?.find(d => d.key === which);
  const rows = units.map(u => ({ u, c: u.checks.find(c => c.key === which)! }))
    .filter(({ c }) => !onlyProblems || (c.status !== 'match' && c.status !== 'empty'));
  const problems = (key: string) => units.filter(u => { const s = u.checks.find(c => c.key === key)?.status; return s && s !== 'match' && s !== 'empty'; }).length;

  return (
    <div className="hc">
      <div className="hc-head">
        <div className="hc-tabs">
          {defs?.map(d => (
            <button key={d.key} className={`chip ${which === d.key ? 'active' : ''}`} onClick={() => { setWhich(d.key); setAsking(null); }}>
              {d.label}{units.length > 0 && <> · {problems(d.key) ? `▲ ${problems(d.key)}` : '● all same'}</>}
            </button>
          ))}
        </div>
        <label className="hc-only"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> Only what differs</label>
        <button className="secondary small" onClick={() => void load()}>↻</button>
        <button className="secondary small" onClick={onClose}>Close</button>
      </div>
      {def && <p className="sub-n hc-note">{def.note} Active units only, matched to Repository → Units by name.{!canEdit && ' You can look; changing needs Repository edit.'}</p>}
      {err && <div className="banner error">{err}</div>}
      {!defs && !err && <p className="loading-dot">Reading Hostaway</p>}
      {defs && rows.length === 0 && <p className="banner ok">● {units.length} units: Repository and Hostaway say the same.</p>}

      <div className="hc-list">
        {def && rows.map(({ u, c }) => {
          const look = LOOK[c.status];
          const id = u.unitId;
          return (
            <div key={id} className="hc-row">
              <div className="hc-unit">
                <b>{u.unit}</b>
                <span className="sub-n">{u.record ? `Repository: ${u.record}` : '▲ no Repository record'}</span>
                <span className={look.cls}>{look.mark} {look.word}</span>
              </div>
              <div className="hc-sides">
                {c.fields.map(f => (
                  <div key={f.label} className="hc-field">
                    <span className="sub-n">{f.label}</span>
                    <span className={f.status === 'match' ? '' : 'hc-diff'}>Repository: <code>{f.repo || '—'}</code></span>
                    <span className={f.status === 'match' ? '' : 'hc-diff'}>Hostaway: <code>{f.hostaway || '—'}</code></span>
                  </div>
                ))}
              </div>
              {canEdit && c.status !== 'match' && c.status !== 'empty' && (
                <div className="hc-actions">
                  {u.record && c.fields.every(f => f.hostaway) && (
                    <button className="secondary small" disabled={!!busy} onClick={() => void fix(u, 'repository')}>
                      {busy === `${id}|repository` ? 'Copying…' : '← Use Hostaway\'s'}
                    </button>
                  )}
                  {c.fields.every(f => f.repo) && (asking === id ? (
                    <span className="hc-ask">Guests see this.
                      <button className="small" disabled={!!busy} onClick={() => void fix(u, 'hostaway')}>{busy === `${id}|hostaway` ? 'Sending…' : 'Yes, change Hostaway'}</button>
                      <button className="secondary small" onClick={() => setAsking(null)}>No</button>
                    </span>
                  ) : (
                    <button className="secondary small" disabled={!!busy} onClick={() => setAsking(id)}>Send to Hostaway →</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
