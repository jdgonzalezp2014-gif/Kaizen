import { useEffect, useState } from 'react';
import { Revenue } from './screens/Revenue.tsx';
import { Units } from './screens/Units.tsx';
import { Costs } from './screens/Costs.tsx';
import { Claims } from './screens/Claims.tsx';
import { Cleanings } from './screens/Cleanings.tsx';
import { Settings } from './screens/Settings.tsx';
import { getUnits, getSettings, type UnitRow } from './api.ts';
import { ThemeToggle } from './components/ThemeToggle.tsx';

type Tab = 'units' | 'revenue' | 'costs' | 'cleanings' | 'claims' | 'settings';

const TABS: [Tab, string][] = [
  ['units', 'Units'], ['revenue', 'Revenue'], ['costs', 'Costs'],
  ['cleanings', 'Cleanings'], ['claims', 'Claims'], ['settings', 'Settings']
];

export function App() {
  // Null, not 'units'. Rendering a default tab before the role is known
  // mounts that screen for everyone — an ops account briefly saw Units
  // and fired /api/forward, which answers 403 for them. The flash was
  // the visible part; the forbidden request was the rest of it.
  const [tab, setTab] = useState<Tab | null>(null);
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
        // Land on the first tab they can actually open. For an admin that
        // is Units, where the decisions are; for ops it is Costs.
        setTab(prev => (prev && tabs.includes(prev)) ? prev : (tabs[0] as Tab));
      })
      .catch(() => {
        // The role could not be read. Falling back to every tab would
        // show an ops account exactly what this is meant to keep from
        // them, so it falls back to the narrow set instead — a wrong
        // guess then costs an admin one reload, not a leak.
        setAllowed(['costs', 'claims']);
        setTab('costs');
      });
  }, []);

  return (
    <main>
      <header>
        {/* No tagline. It restated a framing the owner had already lost an
            argument about, and a slogan nobody reads is pure vertical
            space on a screen whose job is a list. */}
        <h1>Kaizen OS</h1>
        <nav>
          {/* Nothing until the role is known. A tab that appears and then
              vanishes has already told the reader it exists. */}
          {allowed?.map(t => {
            const label = TABS.find(x => x[0] === t)?.[1];
            return label ? (
              <button key={t} className={tab === t ? 'tab active' : 'tab'}
                      onClick={() => setTab(t as Tab)}>{label}</button>
            ) : null;
          })}
          <ThemeToggle />
        </nav>
      </header>

      {/* Only shown to someone who can act on it. Telling an ops account
          to go to Settings → Sync listings names a screen they cannot
          open. */}
      {units.length === 0 && tab !== 'settings' && allowed?.includes('settings') && (
        <p className="banner warn">
          No units in the local database yet. Settings → Sync listings, once — costs and price
          decisions attach to these records and cannot be saved without them.
        </p>
      )}

      {tab === null    && <p className="note">Loading…</p>}
      {tab === 'units'    && <Units />}
      {tab === 'revenue'  && <Revenue />}
      {tab === 'cleanings' && <Cleanings />}
      {tab === 'claims'   && <Claims units={units} />}
      {tab === 'costs'    && <Costs units={units} />}
      {tab === 'settings' && <Settings />}
    </main>
  );
}
