import { useEffect, useState } from 'react';
import { Revenue } from './screens/Revenue.tsx';
import { Units } from './screens/Units.tsx';
import { Costs } from './screens/Costs.tsx';
import { Claims } from './screens/Claims.tsx';
import { Settings } from './screens/Settings.tsx';
import { getUnits, getSettings, type UnitRow } from './api.ts';
import { ThemeToggle } from './components/ThemeToggle.tsx';

type Tab = 'units' | 'revenue' | 'costs' | 'claims' | 'settings';

const TABS: [Tab, string][] = [
  ['units', 'Units'], ['revenue', 'Revenue'], ['costs', 'Costs'],
  ['claims', 'Claims'], ['settings', 'Settings']
];

export function App() {
  // Units first: it is where the decisions are made, and the tab that
  // opens is the one people treat as the product.
  const [tab, setTab] = useState<Tab>('units');
  // Fetched once at the top: three screens need the same unit list, and
  // three copies of it drift the moment one of them is stale.
  const [units, setUnits] = useState<UnitRow[]>([]);
  // Which tabs to draw comes from the server, not from a guess here.
  // Null until it answers, so nothing is drawn that might then vanish.
  const [allowed, setAllowed] = useState<string[] | null>(null);

  useEffect(() => { getUnits().then(r => setUnits(r.units ?? [])).catch(() => {}); }, []);
  useEffect(() => {
    getSettings()
      .then(r => {
        const tabs = r.tabs ?? TABS.map(t => t[0]);
        setAllowed(tabs);
        // Land on a tab they can actually open. Defaulting to Units for
        // someone who only records costs shows a permission error as
        // their first impression of the app.
        setTab(prev => tabs.includes(prev) ? prev : (tabs[0] as Tab));
      })
      .catch(() => setAllowed(TABS.map(t => t[0])));
  }, []);

  return (
    <main>
      <header>
        {/* No tagline. It restated a framing the owner had already lost an
            argument about, and a slogan nobody reads is pure vertical
            space on a screen whose job is a list. */}
        <h1>Kaizen OS</h1>
        <nav>
          {TABS.filter(([t]) => allowed == null || allowed.includes(t)).map(([t, label]) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{label}</button>
          ))}
          <ThemeToggle />
        </nav>
      </header>

      {units.length === 0 && tab !== 'settings' && allowed != null && (
        <p className="banner warn">
          No units in the local database yet. Settings → Sync listings, once — costs and price
          decisions attach to these records and cannot be saved without them.
        </p>
      )}

      {tab === 'units'    && <Units />}
      {tab === 'revenue'  && <Revenue />}
      {tab === 'claims'   && <Claims units={units} />}
      {tab === 'costs'    && <Costs units={units} />}
      {tab === 'settings' && <Settings />}
    </main>
  );
}
