import { useState } from 'react';
import { Money } from './screens/Money.tsx';
import { Settings } from './screens/Settings.tsx';

type Tab = 'money' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('money');

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

      {tab === 'settings' ? <Settings /> : <Money />}
    </main>
  );
}
