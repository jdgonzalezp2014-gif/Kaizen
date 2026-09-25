import { useEffect, useState } from 'react';
import { Revenue } from './screens/Revenue.tsx';
import { Units } from './screens/Units.tsx';
import { Costs } from './screens/Costs.tsx';
import { Claims } from './screens/Claims.tsx';
import { Settings } from './screens/Settings.tsx';
import { Operations } from './screens/Operations.tsx';
import { Repository } from './screens/Repository.tsx';
import { getUnits, getSettings, can, type UnitRow } from './api.ts';
import { ThemeToggle } from './components/ThemeToggle.tsx';

type Tab = 'units' | 'revenue' | 'operations' | 'repository' | 'costs' | 'claims' | 'settings';

const TABS: [Tab, string][] = [
  ['units', 'Units'], ['revenue', 'Revenue'], ['operations', 'Operations'],
  ['repository', 'Repository'], ['costs', 'Costs'], ['claims', 'Claims'], ['settings', 'Settings']
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
  const [loadError, setLoadError] = useState('');
  // Only decides which controls are DRAWN. The server refuses anything
  // the role does not permit regardless; this just avoids offering it.
  const [permissions, setPermissions] = useState<string[]>([]);

  useEffect(() => { getUnits().then(r => setUnits(r.units ?? [])).catch(() => {}); }, []);
  useEffect(() => {
    getSettings()
      .then(r => {
        const tabs = r.tabs ?? TABS.map(t => t[0]);
        setAllowed(tabs);
        setPermissions(r.permissions ?? []);
        // Land on the first tab they can actually open. For an admin that
        // is Units, where the decisions are; for ops it is Costs.
        setTab(prev => (prev && tabs.includes(prev)) ? prev : (tabs[0] as Tab));
      })
      .catch(e => {
        // Silently falling back to the ops tab set made a transient
        // failure look like a demotion: an admin lost Units, Revenue and
        // Settings with no explanation, which reads as "someone changed
        // my access" rather than "the request failed".
        //
        // Still fails closed — no tabs are drawn — but it says why.
        setAllowed([]);
        setLoadError(e instanceof Error ? e.message : String(e));
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

      {loadError && (
        <p className="banner error">
          Could not read your access level, so nothing is shown. This is a failure to load,
          not a change to your permissions — reload to try again. ({loadError})
        </p>
      )}
      {tab === null && !loadError && <p className="note">Loading…</p>}
      {tab === 'units'    && <Units />}
      {tab === 'revenue'  && <Revenue />}
      {tab === 'operations' && <Operations />}
      {tab === 'repository' && <Repository canReveal={can(permissions, 'repository.reveal')} />}
      {tab === 'claims'   && <Claims units={units} />}
      {tab === 'costs'    && <Costs units={units} />}
      {tab === 'settings' && <Settings />}
    </main>
  );
}
