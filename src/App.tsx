import { useEffect, useState } from 'react';
import { Revenue } from './screens/Revenue.tsx';
import { Units } from './screens/Units.tsx';
import { Costs } from './screens/Costs.tsx';
import { Settings } from './screens/Settings.tsx';
import { getUnits, type UnitRow } from './api.ts';
import { ThemeToggle } from './components/ThemeToggle.tsx';

type Tab = 'revenue' | 'units' | 'costs' | 'settings';

const TABS: [Tab, string][] = [
  ['revenue', 'Revenue'], ['units', 'Units'], ['costs', 'Costs'], ['settings', 'Settings']
];

export function App() {
  const [tab, setTab] = useState<Tab>('revenue');
  // Fetched once at the top: three screens need the same unit list, and
  // three copies of it drift the moment one of them is stale.
  const [units, setUnits] = useState<UnitRow[]>([]);
  useEffect(() => { getUnits().then(r => setUnits(r.units ?? [])).catch(() => {}); }, []);

  return (
    <main>
      <header>
        {/* No tagline. It restated a framing the owner had already lost an
            argument about, and a slogan nobody reads is pure vertical
            space on a screen whose job is a list. */}
        <h1>Kaizen OS</h1>
        <nav>
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{label}</button>
          ))}
          <ThemeToggle />
        </nav>
      </header>

      {units.length === 0 && tab !== 'settings' && (
        <p className="banner warn">
          No units in the local database yet. Settings → Sync listings, once — costs and price
          decisions attach to these records and cannot be saved without them.
        </p>
      )}

      {tab === 'revenue'  && <Revenue />}
      {tab === 'units'    && <Units />}
      {tab === 'costs'    && <Costs units={units} />}
      {tab === 'settings' && <Settings />}
    </main>
  );
}
