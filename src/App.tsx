import { useEffect, useState } from 'react';
import { Money } from './screens/Money.tsx';
import { Units } from './screens/Units.tsx';
import { Costs } from './screens/Costs.tsx';
import { Settings } from './screens/Settings.tsx';
import { getUnits, type UnitRow } from './api.ts';

type Tab = 'money' | 'units' | 'costs' | 'settings';

const TABS: [Tab, string][] = [
  ['money', 'Money'], ['units', 'Units'], ['costs', 'Costs'], ['settings', 'Settings']
];

export function App() {
  const [tab, setTab] = useState<Tab>('money');
  // Fetched once at the top: three screens need the same unit list, and
  // three copies of it drift the moment one of them is stale.
  const [units, setUnits] = useState<UnitRow[]>([]);
  useEffect(() => { getUnits().then(r => setUnits(r.units ?? [])).catch(() => {}); }, []);

  return (
    <main>
      <header>
        <div>
          <h1>Kaizen OS</h1>
          <p className="sub">Profit per unit — and the occupancy that has to hold it up.</p>
        </div>
        <nav>
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{label}</button>
          ))}
        </nav>
      </header>

      {units.length === 0 && tab !== 'settings' && (
        <p className="banner warn">
          No units in the local database yet. Settings → Sync listings, once — costs and price
          decisions attach to these records and cannot be saved without them.
        </p>
      )}

      {tab === 'money'    && <Money />}
      {tab === 'units'    && <Units />}
      {tab === 'costs'    && <Costs units={units} />}
      {tab === 'settings' && <Settings />}
    </main>
  );
}
