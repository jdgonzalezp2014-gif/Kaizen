/**
 * Repository → "Missing data" (§170): every active unit's gaps, worst first, with what breaks without
 * each one. Two ways to look: by unit, or by field across units. Read-only — it points at the record
 * (or at ⇄ Check against Hostaway for a listing field); it never fills anything itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { getMissingData, type MissingRule } from '../api.ts';
import { SEVERITIES, type Severity, type UnitGaps } from '../lib/missing-data.ts';
import { Hint } from './Hint.tsx';

// Colour never alone: a shape and a word with it.
export const SEV: Record<Severity, { mark: string; word: string }> = {
  critical: { mark: '▲', word: 'Critical' }, high: { mark: '▲', word: 'High' },
  medium: { mark: '■', word: 'Medium' }, low: { mark: '○', word: 'Low' },
};
export const SevTag = ({ s }: { s: Severity }) => <span className={`md-sev md-${s}`}>{SEV[s].mark} {SEV[s].word}</span>;

type Data = { units: UnitGaps[]; counts: Record<Severity, number>; hostawayError: string | null; rules: MissingRule[]; at: string };

export function MissingData({ onOpen, onCheck }: { onOpen: (table: string, id: string) => void; onCheck: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [sev, setSev] = useState<Severity | 'all'>('all');
  const [mode, setMode] = useState<'unit' | 'field'>('unit');
  const load = () => {
    setBusy(true);
    getMissingData().then(r => { if (r.ok) { setData(r); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
      .catch(e => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  useEffect(load, []);

  const units = useMemo(() => (data?.units ?? []).map(u => ({ ...u, gaps: u.gaps.filter(g => sev === 'all' || g.severity === sev) })).filter(u => u.gaps.length), [data, sev]);
  const fields = useMemo(() => {
    const by = new Map<string, { label: string; severity: Severity; why: string; where: string; units: UnitGaps[] }>();
    for (const u of units) for (const g of u.gaps) {
      // "Cleaner access" and "Point of contact" name what is missing per unit; group them by rule.
      const k = g.key;
      const rule = data?.rules.find(r => r.key === k);
      const e = by.get(k) ?? { label: rule?.label ?? g.label, severity: g.severity, why: g.why, where: g.where, units: [] };
      e.units.push(u); by.set(k, e);
    }
    return [...by.entries()].sort((a, b) => SEVERITIES.indexOf(a[1].severity) - SEVERITIES.indexOf(b[1].severity) || b[1].units.length - a[1].units.length);
  }, [units, data]);

  if (busy && !data) return <p className="note loading-dot">Reading every unit and its Hostaway listing</p>;
  if (err && !data) return <p className="banner warn">▲ {err}</p>;
  if (!data) return null;
  const total = data.units.length;
  const clean = data.units.filter(u => !u.gaps.length).length;
  const unitLink = (u: UnitGaps) => u.table && u.recordId
    ? <button className="link md-unit" onClick={() => onOpen(u.table!, u.recordId!)}>{u.unit}</button>
    : <b className="md-unit">{u.unit}</b>;

  return (
    <div className="md">
      <div className="hc-head">
        <div className="hc-tabs" role="tablist" aria-label="Severity">
          <button role="tab" aria-selected={sev === 'all'} className={`chip ${sev === 'all' ? 'active' : ''}`} onClick={() => setSev('all')}>
            All · {SEVERITIES.reduce((a, s) => a + data.counts[s], 0)}</button>
          {SEVERITIES.map(s => (
            <button key={s} role="tab" aria-selected={sev === s} className={`chip ${sev === s ? 'active' : ''}`} onClick={() => setSev(s)}>
              <SevTag s={s} /> · {data.counts[s]}</button>
          ))}
        </div>
        <div className="hc-mode" role="tablist" aria-label="View">
          <button role="tab" aria-selected={mode === 'unit'} className={`chip ${mode === 'unit' ? 'active' : ''}`} onClick={() => setMode('unit')}>By unit</button>
          <button role="tab" aria-selected={mode === 'field'} className={`chip ${mode === 'field' ? 'active' : ''}`} onClick={() => setMode('field')}>By field</button>
        </div>
        <Hint>{'Every active Hostaway listing, its Repository record and its live listing. Severity is what breaks without the field: Critical — a clean or a stay goes wrong; High — money, insurance or a service outage; Medium — slows someone down; Low — paperwork. Nothing here writes: fill a Repository field in the record (click the unit), a Hostaway field in Hostaway or with ⇄ Check against Hostaway.'}</Hint>
        <button className="secondary small" title="Read again" onClick={load} disabled={busy}>↻</button>
      </div>
      {data.hostawayError && <p className="banner warn">▲ Hostaway was not read ({data.hostawayError}) — only the Repository is audited.</p>}
      <p className="note hc-note">{total - clean} of {total} active units have something missing{clean ? ` · ${clean} complete` : ''}.</p>

      {mode === 'unit' ? (
        <div className="hc-list">
          {!units.length && <p className="note">Nothing missing at this severity. ●</p>}
          {units.map(u => (
            <div key={u.unitId} className="hc-row md-row">
              <div className="md-head">{unitLink(u)}{!u.hostaway && !data.hostawayError && <span className="note"> · no Hostaway listing found</span>}</div>
              <ul className="md-gaps">
                {u.gaps.map(g => (
                  <li key={g.key}>
                    <SevTag s={g.severity} /> <b>{g.label}</b> <span className="md-where">{g.where === 'hostaway' ? 'Hostaway' : 'Repository'}</span>
                    {g.where === 'hostaway' || g.key === 'copy' ? <button className="link small" onClick={onCheck}>⇄ Check</button> : null}
                    <span className="md-why">{g.why}{g.fix ? ` ${g.fix}` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="hc-list">
          {!fields.length && <p className="note">Nothing missing at this severity. ●</p>}
          {fields.map(([k, f]) => (
            <div key={k} className="hc-row md-row">
              <div className="md-head"><SevTag s={f.severity} /> <b>{f.label}</b> <span className="md-where">{f.where === 'hostaway' ? 'Hostaway' : 'Repository'}</span>
                <span className="sub-n"> · {f.units.length} unit{f.units.length === 1 ? '' : 's'}</span></div>
              <span className="md-why">{f.why}</span>
              <div className="md-units">{f.units.map(u => <span key={u.unitId}>{unitLink(u)}</span>)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
