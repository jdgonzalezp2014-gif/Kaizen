/**
 * Repository → "⇄ Check against Hostaway" (§149, §155): each active unit's record beside its live listing,
 * in the sections of src/lib/repo-checks.ts (House settings · House description · House rules · Fees ·
 * Hostaway settings). Two ways to look: one unit, every field of a section; or one field across every unit.
 * Editors make the sides agree field by field or a whole section at once — always shown before → after
 * and confirmed first, both ways (Hostaway is what guests see; the record is what the team trusts).
 */
import { useEffect, useMemo, useState } from 'react';
import { getRepoCheck, fixRepoCheck, type RepoCheckUnit, type RepoCheckDef } from '../api.ts';
import { firstDiffLine, type CheckStatus, type CheckResult, type SectionKey, type SECTIONS } from '../lib/repo-checks.ts';

const LOOK: Record<CheckStatus, { mark: string; word: string; cls: string }> = {
  match: { mark: '●', word: 'Same', cls: 'hc-ok' },
  case: { mark: '◐', word: 'Capitals differ', cls: 'hc-warn' },
  differ: { mark: '▲', word: 'Different', cls: 'hc-warn' },
  'no-repository': { mark: '○', word: 'Not in the Repository', cls: 'hc-gap' },
  'no-hostaway': { mark: '○', word: 'Not in Hostaway', cls: 'hc-gap' },
  empty: { mark: '○', word: 'Empty on both', cls: 'hc-gap' },
};
const open = (c: CheckResult | undefined) => !!c && c.status !== 'match' && c.status !== 'empty';
const canCopy = (c: CheckResult) => open(c) && c.fields.every(f => f.hostaway);
const canSend = (d: RepoCheckDef, c: CheckResult) => d.send && open(c) && c.fields.every(f => f.repo);

interface Ask { unitId: string; keys: string[]; to: 'repository' | 'hostaway' }

export function HostawayCheck({ canEdit, say, onClose }: { canEdit: boolean; say: (m: string) => void; onClose: () => void }) {
  const [sections, setSections] = useState<typeof SECTIONS | null>(null);
  const [defs, setDefs] = useState<RepoCheckDef[]>([]);
  const [units, setUnits] = useState<RepoCheckUnit[]>([]);
  const [err, setErr] = useState('');
  const [section, setSection] = useState<SectionKey>('settings');
  const [mode, setMode] = useState<'unit' | 'field'>('unit');
  const [unitId, setUnitId] = useState('');
  const [field, setField] = useState('wifi');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);

  const load = async () => {
    setErr('');
    const r = await getRepoCheck();
    if (!r.ok) { setErr(r.message ?? 'Could not read Hostaway.'); return; }
    setSections(r.sections); setDefs(r.checks); setUnits(r.units);
    setUnitId(id => id || r.units[0]?.unitId || '');
  };
  useEffect(() => { void load(); }, []);

  const inSection = useMemo(() => defs.filter(d => d.section === section), [defs, section]);
  const unit = units.find(u => u.unitId === unitId);
  const result = (u: RepoCheckUnit, key: string) => u.checks.find(c => c.key === key)!;
  const problemsIn = (u: RepoCheckUnit, sec?: SectionKey) => defs.filter(d => (!sec || d.section === sec) && open(result(u, d.key))).length;
  const def = (key: string) => defs.find(d => d.key === key)!;

  const run = async (a: Ask | { unitId: string; op: 'draft-adds' }) => {
    setBusy(true);
    const r = await fixRepoCheck('op' in a ? a : { unitId: a.unitId, checks: a.keys, to: a.to });
    setBusy(false); setAsk(null);
    if (!r.ok) { say(r.message ?? 'Not changed.'); return; }
    setUnits(us => us.map(x => x.unitId === r.unit.unitId ? r.unit : x));
    say('op' in a ? `${r.unit.unit}: Adds drafted — read them in the record`
      : a.to === 'repository' ? `${r.unit.unit}: Repository updated from Hostaway` : `${r.unit.unit}: Hostaway updated and read back`);
  };

  const pickSection = (s: SectionKey) => {
    setSection(s); setAsk(null);
    const first = defs.find(d => d.section === s);
    if (first) setField(first.key);
  };

  /** One field's two sides, short or long. Called, not mounted: a remount would fold an opened text. */
  const Sides = ({ c, d }: { c: CheckResult; d: RepoCheckDef }) => (
    <div className="hc-sides">
      {c.fields.map(f => {
        const at = d.long && f.repo && f.hostaway ? firstDiffLine(f.repo, f.hostaway) : 0;
        return (
          <div key={f.label} className={`hc-field ${d.long ? 'hc-long' : ''}`}>
            {c.fields.length > 1 && <span className="sub-n">{f.label}</span>}
            <span className={f.status === 'match' ? '' : 'hc-diff'}>Repository: <Val v={f.repo} long={d.long} /></span>
            <span className={f.status === 'match' ? '' : 'hc-diff'}>Hostaway: <Val v={f.hostaway} long={d.long} /></span>
            {at > 0 && <span className="sub-n">They part at line {at}.</span>}
          </div>
        );
      })}
    </div>
  );

  const Actions = ({ u, d, c }: { u: RepoCheckUnit; d: RepoCheckDef; c: CheckResult }) => !canEdit || !open(c) ? null : (
    <div className="hc-actions">
      {u.record && canCopy(c) && <button className="secondary small" disabled={busy} onClick={() => setAsk({ unitId: u.unitId, keys: [d.key], to: 'repository' })}>← Use Hostaway's</button>}
      {canSend(d, c) && <button className="secondary small" disabled={busy} onClick={() => setAsk({ unitId: u.unitId, keys: [d.key], to: 'hostaway' })}>Send to Hostaway →</button>}
      {!d.send && <span className="sub-n">Changed in Hostaway only</span>}
    </div>
  );

  /** Before → after for everything a write would change, and the one button that does it. */
  const Confirm = ({ a }: { a: Ask }) => {
    const u = units.find(x => x.unitId === a.unitId)!;
    const toHostaway = a.to === 'hostaway';
    return (
      <div className={`hc-confirm ${toHostaway ? 'hc-confirm-out' : ''}`}>
        <b>{toHostaway ? `Change ${u.unit}'s listing in Hostaway — guests see this` : `Copy Hostaway's into ${u.unit}'s record (${u.recordId})`}</b>
        {a.keys.map(k => {
          const d = def(k), c = result(u, k);
          return c.fields.map(f => (
            <div key={`${k}|${f.label}`} className="hc-ba">
              <span className="sub-n">{d.label}{c.fields.length > 1 ? ` · ${f.label}` : ''}</span>
              <span>Now: <Val v={toHostaway ? f.hostaway : f.repo} long={d.long} /></span>
              <span>After: <Val v={toHostaway ? f.repo : f.hostaway} long={d.long} openLong /></span>
              {d.section === 'rules' && !toHostaway && <span className="sub-n">The Adds stay as they are; the original rules take Hostaway's text without them.</span>}
            </div>
          ));
        })}
        <div className="hc-actions">
          <button className="small" disabled={busy} onClick={() => void run(a)}>{busy ? 'Working…' : toHostaway ? 'Yes, change Hostaway' : 'Yes, copy into the Repository'}</button>
          <button className="secondary small" disabled={busy} onClick={() => setAsk(null)}>Cancel</button>
        </div>
      </div>
    );
  };

  const sec = sections?.find(s => s.key === section);
  const sectionCopy = unit ? inSection.filter(d => canCopy(result(unit, d.key))).map(d => d.key) : [];
  const sectionSend = unit ? inSection.filter(d => canSend(d, result(unit, d.key))).map(d => d.key) : [];

  return (
    <div className="hc">
      <div className="hc-head">
        <div className="hc-tabs">
          {sections?.map(s => {
            const n = mode === 'unit' ? (unit ? problemsIn(unit, s.key) : 0) : units.filter(u => problemsIn(u, s.key)).length;
            return (
              <button key={s.key} className={`chip ${section === s.key ? 'active' : ''}`} onClick={() => pickSection(s.key)}>
                {s.label} · {n ? `▲ ${n}` : '● same'}
              </button>
            );
          })}
        </div>
        <button className="secondary small" onClick={() => void load()} title="Read Hostaway again">↻</button>
        <button className="secondary small" onClick={onClose}>Close</button>
      </div>
      <div className="hc-head">
        <div className="hc-mode">
          <button className={`chip ${mode === 'unit' ? 'active' : ''}`} onClick={() => { setMode('unit'); setAsk(null); }}>One unit</button>
          <button className={`chip ${mode === 'field' ? 'active' : ''}`} onClick={() => { setMode('field'); setAsk(null); }}>One field, all units</button>
        </div>
        {mode === 'unit'
          ? <select value={unitId} onChange={e => { setUnitId(e.target.value); setAsk(null); }}>
              {units.map(u => <option key={u.unitId} value={u.unitId}>{u.unit} — {problemsIn(u) ? `▲ ${problemsIn(u)} to look at` : '● all same'}</option>)}
            </select>
          : <select value={field} onChange={e => { setField(e.target.value); setAsk(null); }}>
              {inSection.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>}
        <label className="hc-only"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> Only what differs</label>
      </div>
      {sec && <p className="sub-n hc-note">{sec.note} Active units only, matched to Repository → Units by name.{!canEdit && ' You can look; changing needs Repository edit.'}</p>}
      {err && <div className="banner error">{err}</div>}
      {!sections && !err && <p className="loading-dot">Reading Hostaway</p>}

      {sections && mode === 'unit' && unit && (
        <div className="hc-list">
          {!unit.record && <div className="banner error">▲ {unit.unit} has no record in Repository → Units — nothing to compare with.</div>}
          {canEdit && unit.record && (sectionCopy.length > 0 || sectionSend.length > 0 || section === 'rules') && (
            <div className="hc-actions hc-bulk">
              {sectionCopy.length > 0 && <button className="secondary small" disabled={busy} onClick={() => setAsk({ unitId: unit.unitId, keys: sectionCopy, to: 'repository' })}>← Copy all {sec?.label} from Hostaway ({sectionCopy.length})</button>}
              {sectionSend.length > 0 && <button className="secondary small" disabled={busy} onClick={() => setAsk({ unitId: unit.unitId, keys: sectionSend, to: 'hostaway' })}>Send all {sec?.label} to Hostaway → ({sectionSend.length})</button>}
              {section === 'rules' && <button className="secondary small" disabled={busy} onClick={() => void run({ unitId: unit.unitId, op: 'draft-adds' })}
                title="Writes a first wording for each empty Add (pet fee, lost key / fob, extra guests) from this record's fees — into the Repository only">✎ Draft the Adds from the fees</button>}
            </div>
          )}
          {ask && ask.unitId === unit.unitId && Confirm({ a: ask })}
          {inSection.map(d => ({ d, c: result(unit, d.key) })).filter(({ c }) => !onlyProblems || open(c)).map(({ d, c }) => (
            <div key={d.key} className="hc-row">
              <div className="hc-unit">
                <b>{d.label}</b>
                {d.note && <span className="sub-n">{d.note}</span>}
                <span className={LOOK[c.status].cls}>{LOOK[c.status].mark} {LOOK[c.status].word}</span>
              </div>
              {Sides({ c, d })}
              {Actions({ u: unit, d, c })}
            </div>
          ))}
          {onlyProblems && !inSection.some(d => open(result(unit, d.key))) && <p className="banner ok">● {sec?.label}: Repository and Hostaway say the same.</p>}
        </div>
      )}

      {sections && mode === 'field' && defs.some(d => d.key === field) && (() => {
        const d = def(field);
        const rows = units.map(u => ({ u, c: result(u, field) })).filter(({ c }) => !onlyProblems || open(c));
        return (
          <div className="hc-list">
            {d.note && <p className="sub-n hc-note">{d.note}</p>}
            {ask && Confirm({ a: ask })}
            {rows.length === 0 && <p className="banner ok">● {units.length} units: Repository and Hostaway say the same.</p>}
            {rows.map(({ u, c }) => (
              <div key={u.unitId} className="hc-row">
                <div className="hc-unit">
                  <b>{u.unit}</b>
                  <span className="sub-n">{u.record ? `Repository: ${u.record}` : '▲ no Repository record'}</span>
                  <span className={LOOK[c.status].cls}>{LOOK[c.status].mark} {LOOK[c.status].word}</span>
                </div>
                {Sides({ c, d })}
                {Actions({ u, d, c })}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

/** A value as it reads: a long text folds to its first line, unfolded on demand. */
function Val({ v, long, openLong }: { v: string; long: boolean; openLong?: boolean }) {
  if (!v) return <code>—</code>;
  if (!long) return <code>{v}</code>;
  const first = v.split('\n')[0]!;
  return (
    <details className="hc-text" open={openLong}>
      <summary>{first.length > 70 ? `${first.slice(0, 70)}…` : first} <span className="sub-n">({v.split('\n').length} lines)</span></summary>
      <pre>{v}</pre>
    </details>
  );
}
