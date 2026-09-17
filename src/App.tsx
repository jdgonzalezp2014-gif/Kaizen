import { useState } from 'react';
import { Settings } from './screens/Settings.tsx';

type Tab = 'money' | 'settings';

export function App() {
  // Settings first, deliberately: nothing else works until a host has
  // connected their Hostaway account.
  const [tab, setTab] = useState<Tab>('settings');

  return (
    <main>
      <header>
        <div>
          <h1>Kaizen OS</h1>
          <p className="sub">Profit per unit. Not occupancy.</p>
        </div>
        <nav>
          <button className={tab === 'money' ? 'tab active' : 'tab'} onClick={() => setTab('money')}>Money</button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>Settings</button>
        </nav>
      </header>

      {tab === 'settings' ? <Settings /> : (
        <div className="card">
          <p className="note">
            Not built yet. The analytics core is written and tested; this screen renders it once
            units are synced.
          </p>
        </div>
      )}
    </main>
  );
}
