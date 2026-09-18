/**
 * Claims — open a case, move it along, see what it cost.
 *
 * The only screen here with real CRUD, and the reason is that a claim is
 * a CASE rather than a fact. An expense happened once; a complaint moves
 * — raised, investigated, refunded, closed — and a table you could only
 * append to would make "update the status" mean "file it twice".
 *
 * Open cases sort first regardless of age. A three-month-old open claim
 * is precisely the one that needs attention, and sorting by date alone
 * buries it under yesterday's resolved ones.
 */
import { useEffect, useMemo, useState } from 'react';
import { getClaims, saveClaim, deleteClaim, type Claim, type UnitRow } from '../api.ts';
import { money2 } from '../lib/format.ts';

const SEVERITY = ['Low', 'Medium', 'High', 'Critical'];
const STATUS = ['Open', 'In progress', 'Resolved', 'Refunded', 'Dismissed'];
const CATEGORIES = ['Cleanliness', 'Maintenance', 'Noise', 'Access', 'Amenity',
                    'Wifi', 'Damage', 'Safety', 'Other'];
const SOURCES = ['Airbnb', 'Booking.com', 'Vrbo', 'Expedia', 'Direct', 'In person'];

/**
 * Weighted 1/2/4/8, the same as the old panel.
 *
 * A plain count ranks five "the wifi was slow" complaints above three
 * midnight lockouts, which is exactly backwards.
 */
const WEIGHT: Record<string, number> = { Low: 1, Medium: 2, High: 4, Critical: 8 };

const OPEN = (c: Claim) => c.status === 'Open' || c.status === 'In progress';

export function Claims({ units }: { units: UnitRow[] }) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [editing, setEditing] = useState<Partial<Claim> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => getClaims()
    .then(r => setClaims(r.claims ?? []))
    .catch(e => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const stats = useMemo(() => {
    const list = claims ?? [];
    const open = list.filter(OPEN);
    const cost = list.reduce((a, c) => a + Number(c.refund) + Number(c.repair_cost), 0);
    const weighted = open.reduce((a, c) => a + (WEIGHT[c.severity] ?? 1), 0);
    // Oldest open case, in days. The number that says whether cases are
    // being worked or just recorded.
    const oldest = open.length
      ? Math.max(...open.map(c => Math.round((Date.now() - Date.parse(c.occurred_on)) / 864e5)))
      : 0;
    return { total: list.length, open: open.length, cost, weighted, oldest };
  }, [claims]);

  const save = async (c: Partial<Claim> & { unitId?: string | null }) => {
    setBusy(true); setErr('');
    const r = await saveClaim({
      id: c.id, unitId: c.unit_id ?? null, occurredOn: c.occurred_on,
      category: c.category, severity: c.severity, status: c.status, source: c.source,
      description: c.description, refund: Number(c.refund) || 0,
      repairCost: Number(c.repair_cost) || 0
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not save.'); return; }
    setEditing(null);
    await load();
  };

  return (
    <section>
      <div className="row-controls">
        <h2 className="screen-title">Claims</h2>
        <button className="small" onClick={() => setEditing({
          occurred_on: new Date().toISOString().slice(0, 10),
          severity: 'Medium', status: 'Open'
        })}>Log a claim</button>
      </div>

      {err && <p className="banner error">{err}</p>}

      {claims && (
        <dl className="strip">
          <div><dt>Open</dt><dd>{stats.open}<small>of {stats.total}</small></dd></div>
          <div><dt>Weighted</dt><dd>{stats.weighted}
            <small>1/2/4/8 by severity</small></dd></div>
          <div><dt>Oldest open</dt><dd>{stats.oldest}<small>days</small></dd></div>
          <div><dt>Cost to date</dt><dd>{money2(stats.cost)}</dd></div>
        </dl>
      )}

      {editing && (
        <ClaimForm claim={editing} units={units} busy={busy}
          onCancel={() => setEditing(null)} onSave={save} />
      )}

      {claims && claims.length > 0 && (
        <div className="ulist">
          <div className="urow-head claim ulist-head" aria-hidden="true">
            <span /><span>Unit</span><span>Raised</span><span>Category</span>
            <span>Severity</span><span>Status</span><span className="n">Cost</span><span />
          </div>
          {claims.map(c => (
            <div key={c.id} className={OPEN(c) ? 'urow' : 'urow muted-row'}>
              <div className="urow-head claim">
                <span className={`light tone-${
                  c.severity === 'Critical' ? 'bad' : c.severity === 'High' ? 'warn'
                  : OPEN(c) ? 'info' : 'ok'}`} aria-hidden="true" />
                <span className="uname">{c.unit_name ?? <span className="muted">Portfolio</span>}</span>
                <span className="note">{c.occurred_on.slice(0, 10)}
                  {OPEN(c) && <> · {Math.round((Date.now() - Date.parse(c.occurred_on)) / 864e5)}d open</>}
                </span>
                <span className="note">{c.category ?? '—'}</span>
                <span className="note">{c.severity}</span>
                <span className="note">{c.status}</span>
                <span className="n">{money2(Number(c.refund) + Number(c.repair_cost))}</span>
                <span>
                  <button className="link" onClick={() => setEditing(c)}>edit</button>
                </span>
              </div>
              {c.description && <p className="claim-desc">{c.description}</p>}
            </div>
          ))}
        </div>
      )}

      {claims && claims.length === 0 && (
        <p className="note">
          Nothing logged yet. Claims feed the month-over-month view and the per-unit cost —
          a unit that looks profitable until you count what it refunds is not profitable.
        </p>
      )}
    </section>
  );
}

function ClaimForm({ claim, units, busy, onCancel, onSave }: {
  claim: Partial<Claim>; units: UnitRow[]; busy: boolean;
  onCancel: () => void; onSave: (c: Partial<Claim>) => void;
}) {
  const [c, setC] = useState<Partial<Claim>>(claim);
  const set = (k: keyof Claim, v: unknown) => setC(prev => ({ ...prev, [k]: v }));
  const closing = c.status === 'Resolved' || c.status === 'Refunded' || c.status === 'Dismissed';

  return (
    <div className="card claim-form">
      <h3>{c.id ? 'Edit claim' : 'Log a claim'}</h3>
      <div className="entry">
        <label>Raised on
          <input type="date" value={c.occurred_on?.slice(0, 10) ?? ''}
                 onChange={e => set('occurred_on', e.target.value)} />
        </label>
        <label>Unit
          <select value={c.unit_id ?? ''} onChange={e => set('unit_id', e.target.value || null)}>
            <option value="">Portfolio-wide</option>
            {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label>Category
          <select value={c.category ?? ''} onChange={e => set('category', e.target.value)}>
            <option value="">—</option>
            {CATEGORIES.map(x => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>Severity
          <select value={c.severity ?? 'Medium'} onChange={e => set('severity', e.target.value)}>
            {SEVERITY.map(x => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>Source
          <select value={c.source ?? ''} onChange={e => set('source', e.target.value)}>
            <option value="">—</option>
            {SOURCES.map(x => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>Status
          <select value={c.status ?? 'Open'} onChange={e => set('status', e.target.value)}>
            {STATUS.map(x => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>Refunded
          <input type="number" value={c.refund ?? ''} onChange={e => set('refund', e.target.value)} />
        </label>
        <label>Repair cost
          <input type="number" value={c.repair_cost ?? ''}
                 onChange={e => set('repair_cost', e.target.value)} />
        </label>
      </div>
      <label>What happened
        <input value={c.description ?? ''} onChange={e => set('description', e.target.value)}
               placeholder="e.g. AC out on arrival, guest moved to CL1339 for one night" />
      </label>
      {closing && (
        <p className="note">
          {/* Filled rather than left to whoever remembers, so a resolved
              claim can always be aged. */}
          Closing this fills the resolution date with today. Re-opening it clears it again.
        </p>
      )}
      <div className="button-row">
        <button className="ghost" onClick={onCancel}>Cancel</button>
        <button onClick={() => onSave(c)} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        {c.id && (
          <button className="link danger"
            onClick={() => { if (confirm('Delete this claim?')) void deleteClaim(c.id!).then(onCancel); }}>
            delete
          </button>
        )}
      </div>
    </div>
  );
}
