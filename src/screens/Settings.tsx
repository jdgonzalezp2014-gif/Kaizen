import { useEffect, useState } from 'react';
import {
  getSettings, saveSettings, syncUnits,
  type Account, type Connection
} from '../api.ts';
import { ImportPanel } from './ImportPanel.tsx';

/**
 * Onboarding for a host who is not us.
 *
 * Credentials are entered here rather than in a deployment's environment
 * — that is the difference between one installation and something you
 * can sell. The key is write-only from the browser's side: it travels in,
 * never back out, so the field shows whether one is stored, never what.
 */
export function Settings() {
  const [account, setAccount] = useState<Account | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [user, setUser] = useState('');
  const [hostawayId, setHostawayId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null);

  const load = async () => {
    try {
      const r = await getSettings();
      setAccount(r.account);
      setConnection(r.connection);
      setUser(r.user);
      setHostawayId(r.account.hostawayAccountId ?? '');
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setStatus({ kind: 'busy', text: 'Verifying against Hostaway…' });
    const r = await saveSettings({
      hostawayAccountId: hostawayId || undefined,
      hostawayApiKey: apiKey || undefined,
      targetNetPerUnit: account?.targetNetPerUnit,
      occFloorPct: account?.occFloorPct,
      stayNights: account?.stayNights
    });
    if (r.ok) {
      setApiKey('');                       // never keep it in memory once stored
      setStatus({ kind: 'ok', text: 'Saved.' });
      await load();
    } else {
      setStatus({ kind: 'error', text: r.error ?? 'Could not save.' });
    }
  };

  const runSync = async () => {
    setStatus({ kind: 'busy', text: 'Pulling listings from Hostaway…' });
    const r = await syncUnits();
    setStatus(r.ok
      ? { kind: 'ok', text: `${r.fetched} listing(s): ${r.active} active.` }
      : { kind: 'error', text: r.error ?? 'Sync failed.' });
    await load();
  };

  if (!account) return <div className="card"><p className="note">Loading…</p></div>;

  return (
    <>
      <div className="card">
        <h2>Hostaway connection</h2>
        <p className="note">
          Your own Hostaway credentials. They are encrypted before storage and never sent back to
          this page — the field below shows whether a key is saved, not what it is.
        </p>

        <div className={`banner ${connection?.ok ? 'ok' : 'warn'}`}>
          {connection?.ok ? '● ' : '○ '}{connection?.message}
        </div>

        <label>
          Hostaway account ID
          <input value={hostawayId} onChange={e => setHostawayId(e.target.value)}
                 placeholder="e.g. 12345" />
        </label>

        <label>
          API key
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                 placeholder={account.hasHostawayKey ? 'Stored — type to replace' : 'Not set yet'} />
        </label>

        <div className="row">
          <button onClick={() => void save()}>Save and verify</button>
          <button className="secondary" onClick={() => void runSync()}
                  disabled={!account.hasHostawayKey}>
            Sync listings
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Targets</h2>
        <p className="note">
          The portfolio target is <b>computed</b>, never stored: active units × the per-unit
          figure. Taking a unit offline moves the target rather than making the portfolio look
          like it missed.
        </p>
        <div className="row">
          <label>
            Net per unit / month
            <input type="number" value={account.targetNetPerUnit}
                   onChange={e => setAccount({ ...account, targetNetPerUnit: Number(e.target.value) })} />
          </label>
          <label>
            Occupancy floor %
            <input type="number" value={account.occFloorPct}
                   onChange={e => setAccount({ ...account, occFloorPct: Number(e.target.value) })} />
          </label>
          <label>
            Quoted stay (nights)
            <input type="number" value={account.stayNights}
                   onChange={e => setAccount({ ...account, stayNights: Number(e.target.value) })} />
          </label>
        </div>
        <button onClick={() => void save()}>Save targets</button>
      </div>

      <ImportPanel onDone={() => void load()} />

      {status && (
        <div className={`banner ${status.kind === 'error' ? 'error' : status.kind === 'ok' ? 'ok' : 'warn'}`}>
          {status.text}
        </div>
      )}
      <p className="note">Signed in as {user}</p>
    </>
  );
}
