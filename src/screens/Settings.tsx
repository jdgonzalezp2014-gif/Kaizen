import { useEffect, useState } from 'react';
import {
  getSettings, saveSettings, syncUnits, pullCleanings,
  type Account, type Connection, type CleaningMatch
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
      stayNights: account?.stayNights,
      fwdStudyDays: account?.fwdStudyDays,
      cleaningsCsvUrl: account?.cleaningsCsvUrl ?? ''
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
          <label>
            Study window (days)
            <input type="number" value={account.fwdStudyDays}
                   onChange={e => setAccount({ ...account, fwdStudyDays: Number(e.target.value) })} />
          </label>
        </div>
        <p className="note">
          The study window is how far ahead the Units screen looks by default — the nights a price
          change can still affect.
        </p>
        <button onClick={() => void save()}>Save targets</button>
      </div>

      <CleaningsPanel account={account} onAccount={setAccount} />

      <GeminiPanel account={account} onSaved={() => void load()} />

      <AccessPanel account={account} user={user} onSaved={() => void load()} />

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

/**
 * The cleanings sheet.
 *
 * What a cleaner is PAID, which Hostaway does not know — its
 * `cleaningFee` is what the guest is charged. Both are needed and they
 * are not the same number.
 *
 * Always previewed before it writes. A name in the sheet that matches no
 * unit is shown, never guessed at: "CL 1446" and "CL1446" are the same
 * apartment, but "Cabin 2" and "Cabin 3" are not.
 */
function CleaningsPanel({ account, onAccount }: {
  account: Account; onAccount: (a: Account) => void;
}) {
  const [url, setUrl] = useState(account.cleaningsCsvUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ matched: CleaningMatch[]; unmatched: string[] } | null>(null);
  const [msg, setMsg] = useState('');

  const run = async (commit: boolean) => {
    setBusy(true); setMsg('');
    const r = await pullCleanings(url.trim(), commit);
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? r.error ?? 'Failed.'); setPreview(null); return; }
    if (r.dryRun) { setPreview({ matched: r.matched ?? [], unmatched: r.unmatched ?? [] }); setMsg(r.message ?? ''); }
    else {
      setPreview(null);
      setMsg(`${r.updated} unit(s) updated.`);
      onAccount({ ...account, cleaningsCsvUrl: url.trim() });
    }
  };

  return (
    <div className="card">
      <h2>Cleaning cost</h2>
      <p className="note">
        What the cleaner is paid, from your sheet. This is a cost — separate from the cleaning fee
        Hostaway charges the guest, which is revenue and comes across automatically.
        In the sheet: File → Share → Publish to web → the Cleanings log tab, CSV.
      </p>
      <label>
        Published CSV URL
        <input value={url} onChange={e => setUrl(e.target.value)}
               placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv" />
      </label>
      <div className="button-row">
        <button className="ghost" disabled={busy || !url.trim()} onClick={() => void run(false)}>
          {busy ? 'Reading…' : 'Preview'}
        </button>
        {preview && preview.matched.length > 0 && (
          <button disabled={busy} onClick={() => void run(true)}>
            Apply to {preview.matched.length} unit(s)
          </button>
        )}
      </div>
      {msg && <p className="note">{msg}</p>}
      {preview && (
        <>
          {preview.matched.length > 0 && (
            <table className="units">
              <thead><tr><th>Unit</th><th className="n">Cleaner paid</th></tr></thead>
              <tbody>
                {preview.matched.map(m => (
                  <tr key={m.id}><td>{m.name}</td><td className="n">${m.amount}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.unmatched.length > 0 && (
            <p className="banner warn">
              No unit matches these names in the sheet: {preview.unmatched.join(', ')}. They were
              skipped rather than guessed at.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Gemini key.
 *
 * Stored encrypted and never returned to the browser — the form can say
 * a key EXISTS, never what it is, which is the same rule the Hostaway
 * credential follows.
 */
function GeminiPanel({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(account.geminiModel ?? 'gemini-3.6-flash');
  const [jina, setJina] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async () => {
    setBusy(true); setMsg('');
    const r = await saveSettings({
      geminiApiKey: key || undefined, geminiModel: model, jinaApiKey: jina || undefined });
    setBusy(false);
    setKey(''); setJina('');
    setMsg(r.ok ? 'Saved.' : (r.error ?? 'Failed.'));
    if (r.ok) onSaved();
  };

  return (
    <div className="card">
      <h2>AI suggestions &amp; market reading</h2>
      <p className="note">
        Gemini reviews one unit at a time and recommends what to do with its price. It is given
        only figures measured from your own account and is told it has no market data, so it
        cannot quote comparable listings it has not seen. It never writes to Hostaway — every
        change still goes through the same confirmation you would use by hand.
        A free key comes from <code>aistudio.google.com/apikey</code>.
      </p>
      <div className="row">
        <label>
          API key {account.hasGeminiKey && <span className="ok-tag">one is stored</span>}
          <input type="password" value={key} onChange={e => setKey(e.target.value)}
                 placeholder={account.hasGeminiKey ? 'stored — type to replace' : 'AIza…'} />
        </label>
        <label>
          Model
          <input value={model} onChange={e => setModel(e.target.value)} />
        </label>
      </div>
      <label>
        Jina reader key <span className="note">— optional</span>
        {account.hasJinaKey && <span className="ok-tag">one is stored</span>}
        <input type="password" value={jina} onChange={e => setJina(e.target.value)}
               placeholder={account.hasJinaKey ? 'stored — type to replace' : 'jina_…'} />
      </label>
      <p className="note">
        Only a fallback. The public Airbnb rating and the guest-facing price are read straight
        from the listing page first, with no key and no proxy — which is how the previous
        system did it. Whether that works depends on where the request leaves from, so open a
        unit and look: if it reports that Airbnb refused the address, a free key from
        <code>jina.ai</code> gives the fetch a different route. If it already shows a rating,
        leave this empty.
      </p>
      <button onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}

/**
 * Who may use this account.
 *
 * Cloudflare Access decides whether someone reaches the app at all; this
 * decides whether they are one of ours once they have. With a public
 * identity provider such as Google those are very different questions,
 * and one policy edit should not answer both.
 */
function AccessPanel({ account, user, onSaved }: {
  account: Account; user: string; onSaved: () => void;
}) {
  const [text, setText] = useState((account.allowedEmails ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const list = text.split(/[\n,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
  // Saving a list you are not on ends your own session at the next
  // request, so it is refused rather than explained afterwards.
  const wouldLockMeOut = list.length > 0 && !list.includes(user.trim().toLowerCase());

  const save = async () => {
    setBusy(true); setMsg('');
    const r = await saveSettings({ allowedEmails: list });
    setBusy(false);
    setMsg(r.ok ? (list.length ? `${list.length} address(es) allowed.` : 'Allow-list cleared.')
                : (r.error ?? 'Failed.'));
    if (r.ok) onSaved();
  };

  return (
    <div className="card">
      <h2>Who can sign in</h2>
      <p className="note">
        One email per line. Leave it empty to allow anyone Cloudflare Access lets through —
        which is the right setting only while your Access policy itself names the people.
        If you point Access at Google, fill this in: a policy like “any gmail.com address”
        is one edit away from letting in anyone with a Google account.
      </p>
      <label>
        Allowed addresses
        <textarea rows={4} value={text} onChange={e => setText(e.target.value)}
                  placeholder={'you@example.com\nteammate@example.com'} />
      </label>
      {wouldLockMeOut && (
        <p className="banner error">
          You are signed in as {user}, which is not on this list. Saving it would lock you out
          of your own account on the next request. Add yourself first.
        </p>
      )}
      <button onClick={() => void save()} disabled={busy || wouldLockMeOut}>
        {busy ? 'Saving…' : 'Save allow-list'}
      </button>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}
