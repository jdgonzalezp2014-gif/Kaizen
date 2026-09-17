import { PRESETS } from './lib/ranges.ts';

/**
 * Placeholder shell. It exists so the build produces something real and
 * deploys end to end before any screen is written — a pipeline proven
 * empty is worth more than a dashboard that has never been served.
 */
export function App() {
  return (
    <main>
      <h1>Kaizen OS</h1>
      <p className="sub">Profit per unit. Not occupancy.</p>

      <div className="card">
        <p className="note">
          Scaffold only — no data is being read yet. The analytics core
          (<code>src/lib/</code>) and the Hostaway client are written and tested;
          the screens are not.
        </p>
        <p className="note" style={{ marginTop: 14 }}>
          Ranges wired and shared by every screen:{' '}
          {PRESETS.map(p => p.label).join(' · ')}
        </p>
      </div>
    </main>
  );
}
