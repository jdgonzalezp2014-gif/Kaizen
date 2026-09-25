import { useEffect, useState } from 'react';
import {
  getSettings, saveSettings, syncUnits, pullCleanings,
  type Account, type Connection, type CleaningMatch, type Member, type MemberAudit,
  type RoleDef, type PermissionDef, saveRole, deleteRole
} from '../api.ts';
import { ImportPanel } from './ImportPanel.tsx';
import { newIngestToken, pullFeed, runCron, type FeedResult, type CronResult } from '../api.ts';
import { sanitize, segments } from '../lib/sms.ts';

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
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<MemberAudit[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [catalog, setCatalog] = useState<PermissionDef[]>([]);
  const [hostawayId, setHostawayId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null);

  const load = async () => {
    try {
      const r = await getSettings();
      setAccount(r.account);
      setConnection(r.connection);
      setUser(r.user);
      setHostawayId(r.account?.hostawayAccountId ?? '');
      setMembers(r.members ?? []);
      setAudit(r.audit ?? []);
      setRoles(r.roles ?? []);
      setCatalog(r.catalog ?? []);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  useEffect(() => { void load(); }, []);

  // An ops member never reaches this screen — the tab is not drawn and
  // the route refuses POST — but if they arrive by URL they should see a
  // sentence, not a blank page or a crash on a null account.
  if (account === null && user) {
    return (
      <div className="card">
        <h2>Settings</h2>
        <p className="note">
          Signed in as {user}. Your role does not include settings, so there is nothing to
          configure here. Ask an admin if you need more.
        </p>
      </div>
    );
  }

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

      <DailyFilePanel account={account} onSaved={() => void load()} />

      <RepositoryPanel account={account} onSaved={() => void load()} />

      <GeminiPanel account={account} onSaved={() => void load()} />

      <MembersPanel members={members} audit={audit} user={user} roles={roles} onSaved={() => void load()} />

      <RolesPanel roles={roles} catalog={catalog} onSaved={() => void load()} />

      <AlertsPanel account={account} onSaved={() => void load()} />

      <FeedPanel account={account} onSaved={() => void load()} />

      <IngestPanel account={account} onSaved={() => void load()} />

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
        What the cleaner is paid, from your sheet — a cost, separate from the cleaning fee
        Hostaway charges the guest, which is revenue. In the sheet: File → Share →
        Publish to web → the Cleanings log tab, CSV. Once the URL is saved it re-reads itself
        whenever the Cleanings tab is opened and the last read is more than three hours old;
        this button is for the first pull and for “it should have updated by now”.
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
 * Roles: which permissions each one holds.
 *
 * A grid, one row per permission and one column per role, because the
 * question asked of it is always a comparison — "does a manager see
 * revenue, and does ops?" — and a list of roles each with its own
 * checkboxes hides the other column. Admin's column is shown, filled and
 * locked, so it is plain what "everything" means.
 */
function RolesPanel({ roles, catalog, onSaved }: {
  roles: RoleDef[]; catalog: PermissionDef[]; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RoleDef[]>(roles);
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setDraft(roles), [roles]);

  const flip = (key: string, perm: string) => setDraft(d => d.map(r => r.key !== key ? r : {
    ...r, permissions: r.permissions.includes(perm) ? r.permissions.filter(p => p !== perm) : [...r.permissions, perm]
  }));
  const changed = (r: RoleDef) => {
    const o = roles.find(x => x.key === r.key);
    return !o || o.name !== r.name || [...o.permissions].sort().join() !== [...r.permissions].sort().join();
  };
  const saveOne = async (r: RoleDef) => {
    const res = await saveRole({ key: r.key, name: r.name, permissions: r.permissions })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setMsg(res.ok ? { ok: true, text: `${r.name} saved.` } : { ok: false, text: res.message ?? 'Could not save.' });
    if (res.ok) onSaved();
  };
  const add = async () => {
    if (!newName.trim()) return;
    const res = await saveRole({ name: newName.trim(), permissions: [] }).catch(e => ({ ok: false as const, message: String(e) }));
    setMsg(res.ok ? { ok: true, text: `${newName.trim()} created — tick what it may do, then save it.` }
                  : { ok: false, text: res.message ?? 'Could not create.' });
    if (res.ok) { setNewName(''); onSaved(); }
  };
  const remove = async (r: RoleDef) => {
    const res = await deleteRole(r.key).catch(e => ({ ok: false as const, message: String(e) }));
    setMsg(res.ok ? { ok: true, text: `${r.name} removed.` } : { ok: false, text: res.message ?? 'Could not remove.' });
    if (res.ok) onSaved();
  };

  return (
    <div className="card">
      <h2>Roles</h2>
      <p className="note">
        What each role may see and do. Changing a role changes it for everyone who holds it, and is
        recorded in the access log below. Revealing a password is logged every time, whoever does it.
      </p>
      <div className="grid-scroll">
        <table className="units compact roles-grid">
          <thead>
            <tr><th>Permission</th>
              {draft.map(r => (
                <th key={r.key}>
                  {r.builtin ? r.name : <input value={r.name}
                    onChange={e => setDraft(d => d.map(x => x.key === r.key ? { ...x, name: e.target.value } : x))} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.map(p => (
              <tr key={p.key}>
                <td>{p.label}</td>
                {draft.map(r => (
                  <td key={r.key} className="n">
                    <input type="checkbox" disabled={r.builtin}
                           checked={r.builtin || r.permissions.includes(p.key)}
                           onChange={() => flip(r.key, p.key)}
                           aria-label={`${r.name}: ${p.label}`} />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="note">Members with this role</td>
              {draft.map(r => <td key={r.key} className="n sub-n">{r.members ?? '—'}</td>)}
            </tr>
            <tr>
              <td></td>
              {draft.map(r => (
                <td key={r.key} className="n">
                  {r.builtin ? <span className="note">fixed</span> : <>
                    <button className="link tiny" disabled={!changed(r)} onClick={() => void saveOne(r)}>save</button>{' '}
                    <button className="link tiny danger" onClick={() => void remove(r)}>remove</button>
                  </>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="row">
        <label>New role<input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Accounting" /></label>
        <button className="secondary" disabled={!newName.trim()} onClick={() => void add()}>Create</button>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
    </div>
  );
}

/**
 * The daily file — the operations sheet — for the Operations tab.
 *
 * Its logs, not its Main tab: Main is redrawn on every refresh and keeps
 * the reservation id in cell notes, which a CSV cannot carry. The
 * Cleanings Log is the link above; these are the rest.
 */
function DailyFilePanel({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [sheetUrl, setSheetUrl] = useState(account.cleaningsSheetUrl ?? '');
  const [notes, setNotes] = useState(account.dailyNotesCsvUrl ?? '');
  const [insp, setInsp] = useState(account.dailyInspectionsCsvUrl ?? '');
  const [settings, setSettings] = useState(account.dailySettingsCsvUrl ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await saveSettings({
      cleaningsSheetUrl: sheetUrl, dailyNotesCsvUrl: notes,
      dailyInspectionsCsvUrl: insp, dailySettingsCsvUrl: settings
    }).catch(e => ({ ok: false, error: String(e) }));
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Saved. The Operations tab reads them on its next load.' }
                : { ok: false, text: r.error ?? 'Could not save.' });
    if (r.ok) onSaved();
  };

  return (
    <div className="card">
      <h2>Daily file</h2>
      <p className="note">
        The operations sheet. Kaizen now runs operations itself; these links are for the{' '}
        <b>one-time import</b> in Operations → Setup (roster, rates, rules, inspection and notes
        history) and for comparing against the sheet while in shadow mode. In the sheet: File →
        Share → Publish to web, pick the tab, choose CSV, and paste each link here. Guest-portal links are
        written as HYPERLINK formulas, so a published CSV carries the 🌐 label and never the
        link's access token. The Cleanings Log link is the one under <b>Cleaning cost</b>.
      </p>
      <label>
        Link to open the sheet (the normal editing link)
        <input value={sheetUrl} onChange={e => setSheetUrl(e.target.value)}
               placeholder="https://docs.google.com/spreadsheets/d/…/edit" />
      </label>
      <label>
        Notes Log — published CSV
        <input value={notes} onChange={e => setNotes(e.target.value)}
               placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv" />
      </label>
      <label>
        Inspection Log — published CSV
        <input value={insp} onChange={e => setInsp(e.target.value)}
               placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv" />
      </label>
      <label>
        _Settings tab — published CSV <span className="sub-n">(optional: thresholds, roster and rate cards)</span>
        <input value={settings} onChange={e => setSettings(e.target.value)}
               placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv" />
      </label>
      <p className="note">
        Without the _Settings tab the board judges inspections against the sheet's built-in
        defaults and says so on screen — the live values are edited in the sheet and may differ.
      </p>
      <div className="button-row">
        <button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save links'}</button>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
    </div>
  );
}

/**
 * The Data Repository's JSON API, for the Repository tab.
 *
 * The API deployment runs as the repository's owner and checks a key, so
 * the key is a credential like Hostaway's: verified with the link before
 * it is stored, encrypted, and never sent back to this page.
 */
function RepositoryPanel({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [apiUrl, setApiUrl] = useState(account.repoApiUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setMsg({ ok: true, text: 'Checking the link and key against the repository…' });
    const body: Record<string, unknown> = {};
    if (apiUrl.trim() !== (account.repoApiUrl ?? '') || apiKey.trim()) body.repoApiUrl = apiUrl;
    if (apiKey.trim()) body.repoApiKey = apiKey;
    const r = await saveSettings(body).catch(e => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) { setApiKey(''); onSaved(); }
    setMsg(r.ok ? { ok: true, text: 'Saved — the repository answered.' }
                : { ok: false, text: r.error ?? 'Could not save.' });
  };

  return (
    <div className="card">
      <h2>Data Repository</h2>
      <p className="note">
        Units, logins and buildings, with their documents — read and edited in the <b>Repository</b>
        tab. The repository's Sheet stays the database and its Drive folders keep the files; Kaizen is
        the screen and decides who may do what (Roles). Use
        the repository's <b>API</b> deployment (Execute as: Me, access: Anyone). The key is in its
        Apps Script editor → ⚙️ Project Settings → Script properties → <code>API_KEY</code>.
        Passwords stay encrypted in the repository: they reach this app masked, and only roles with
        “reveal passwords” can show one — each reveal is logged here under their name.
      </p>
      <div className={`banner ${account.repoApiUrl && account.hasRepoKey ? 'ok' : 'warn'}`}>
        {account.repoApiUrl && account.hasRepoKey ? '● Connected' : '○ Not connected yet'}
      </div>
      <label>
        API link
        <input value={apiUrl} onChange={e => setApiUrl(e.target.value)}
               placeholder="https://script.google.com/macros/s/…/exec" />
      </label>
      <label>
        API key
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
               placeholder={account.hasRepoKey ? 'Stored — type to replace' : 'Not set yet'} />
      </label>
      <div className="button-row">
        <button disabled={busy} onClick={() => void save()}>{busy ? 'Checking…' : 'Save and verify'}</button>
      </div>
      {msg && <p className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
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
        Only a fallback, and currently not a working one. The public rating and the
        guest-facing price are read straight from the listing page first, with no key and no
        proxy — which is how the previous system did it. As last tested, Airbnb serves neither
        this deployment nor the reader anything but a shell, with or without a key. The code
        tries on every load and will start working the moment that changes; nothing else on a
        unit card depends on it.
      </p>
      <button onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}

/**
 * Who may use this account, and for what.
 *
 * Two levels. An **owner** sees everything. **Ops** records costs and
 * claims and nothing else — no revenue, no units, no settings, no
 * credentials.
 *
 * The list here is a convenience. The control is in the API middleware,
 * because every one of those screens is an endpoint reachable with a URL
 * and a valid session, and an access level that lives in a browser is
 * not an access level.
 */
function MembersPanel({ members, audit, user, roles, onSaved }: {
  members: Member[]; audit: MemberAudit[]; user: string; roles: RoleDef[]; onSaved: () => void;
}) {
  const [rows, setRows] = useState<Member[]>(members);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('ops');
  const options = roles.length ? roles : [{ key: 'admin', name: 'Admin', permissions: ['*'], builtin: true }];
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => setRows(members), [members]);

  const me = user.trim().toLowerCase();
  const admins = rows.filter(r => r.role === 'admin').length;
  // Saving a list with no admin leaves an account nobody can administer,
  // and no screen left that could fix it.
  const noAdmin = rows.length > 0 && admins === 0;
  const wouldLockMeOut = rows.length > 0 &&
    !rows.some(r => r.email.toLowerCase() === me && r.role === 'admin');

  const save = async (next: Member[]) => {
    setBusy(true); setMsg('');
    const r = await saveSettings({ members: next });
    setBusy(false);
    setMsg(r.ok ? 'Saved.' : (r.error ?? 'Failed.'));
    if (r.ok) onSaved();
  };

  const add = () => {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setMsg('That is not an email address.'); return; }
    setRows(prev => [...prev.filter(r => r.email !== e), { email: e, role }]);
    setEmail('');
  };

  return (
    <div className="card">
      <h2>Who can sign in</h2>
      <p className="note">
        Each person has one role, and each role is a set of permissions — defined in
        <strong> Roles</strong> below. <strong>Admin</strong> is fixed and sees everything. Hiding
        a tab is only the visible half: the API refuses every route the role does not include,
        because a tab that is merely not drawn is still an address anyone can type.
      </p>

      <table className="units compact">
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.email}>
              <td>
                {r.email}
                {r.email.toLowerCase() === me && <span className="note"> · you</span>}
                {/* Marked in plain sight. A protection nobody can see is
                    not a protection, it is a back door — and the person
                    it is kept from is exactly the one who needs to know. */}
                {r.is_primary && <span className="ok-tag">primary</span>}
              </td>
              <td>
                <select value={r.role} disabled={r.is_primary && r.email.toLowerCase() !== me}
                  onChange={e => setRows(prev => prev.map(x =>
                    x.email === r.email ? { ...x, role: e.target.value } : x))}>
                  {options.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}
                </select>
              </td>
              <td>
                {r.is_primary && r.email.toLowerCase() !== me
                  ? <span className="note">cannot be removed</span>
                  : <button className="link danger"
                      onClick={() => setRows(prev => prev.filter(x => x.email !== r.email))}>remove</button>}
              </td>
            </tr>
          ))}
          <tr className="new-row">
            <td><input value={email} onChange={e => setEmail(e.target.value)}
                       placeholder="someone@example.com" /></td>
            <td>
              <select value={role} onChange={e => setRole(e.target.value)}>
                {options.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}
              </select>
            </td>
            <td><button className="link" onClick={add} disabled={!email.trim()}>add</button></td>
          </tr>
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="note">
          Empty means anyone Cloudflare Access lets through gets full access. That is the right
          setting only while your Access policy itself names the people.
        </p>
      )}
      {noAdmin && <p className="banner error">An account needs at least one admin.</p>}
      {wouldLockMeOut && (
        <p className="banner error">
          You are {user}, and this list does not make you an admin. Saving it would take away
          your access to this screen, with nothing left to undo it from.
        </p>
      )}

      <button onClick={() => void save(rows)} disabled={busy || noAdmin || wouldLockMeOut}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {msg && <p className="note">{msg}</p>}

      {audit.length > 0 && (
        <details className="events">
          <summary>Recent access changes ({audit.length})</summary>
          <table className="units compact">
            <tbody>
              {audit.map((a, i) => (
                <tr key={i}>
                  <td className="note">{a.at.slice(0, 10)}</td>
                  <td>{a.actor.split('@')[0]}</td>
                  <td>{a.action.replace('_', ' ')}</td>
                  <td>{a.email}</td>
                  <td className="note">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Grants and removals alike. A trail that only recorded removals would be a weapon
            rather than a log.
          </p>
        </details>
      )}
    </div>
  );
}

/**
 * The bridge back to Apps Script.
 *
 * Airbnb serves Google's address space and refuses Cloudflare's — so the
 * scraper stays in Apps Script, where it already works, and posts what
 * it read to this app. It is not that Apps Script is more capable; it is
 * that the request leaves from somewhere Airbnb is willing to answer.
 */
function IngestPanel({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const gen = async () => {
    setBusy(true);
    const r = await newIngestToken();
    setBusy(false);
    if (r.ok && r.ingestToken) { setToken(r.ingestToken); onSaved(); }
  };

  const origin = window.location.origin;

  return (
    <div className="card">
      <h2>Ratings from Apps Script</h2>
      <p className="note">
        Airbnb answers Google's addresses and refuses Cloudflare's, so the scraper stays in the
        Apps Script project where it already works and posts its readings here. Rows are matched
        by unit name, the way the sheet already names them.
      </p>

      <div className="button-row">
        <button onClick={() => void gen()} disabled={busy}>
          {busy ? 'Generating…' : account.hasIngestToken ? 'Generate a new token' : 'Generate a token'}
        </button>
        {account.hasIngestToken && !token && (
          <span className="note">
            A token exists. It is stored encrypted and cannot be shown again — generating a new
            one replaces it, and the old one stops working immediately.
          </span>
        )}
      </div>

      {token && (
        <>
          <p className="banner warn">
            Copy the token now. It is shown once and never again — what is stored is encrypted,
            so there is nothing to reveal later.
          </p>
          <label>
            Token
            <input readOnly value={token} onFocus={e => e.currentTarget.select()} />
          </label>
          <ol className="steps">
            <li>
              In the Apps Script project, add the file <code>Kaizen.gs</code> — it is in the
              price-monitor repository and reads the dashboard columns directly.
            </li>
            <li>
              Project Settings → <strong>Script properties</strong> → add two:
              <br /><code>KAIZEN_URL</code> = <code>{origin}/api/observations</code>
              <br /><code>KAIZEN_TOKEN</code> = the token above
              <br />
              <span className="note">
                Properties rather than constants in the file, so the token never lands in source
                control.
              </span>
            </li>
            <li>
              In Cloudflare: Access → Applications → add one for the path
              {' '}<code>/api/observations</code> with a <strong>Bypass</strong> policy. Access
              would otherwise answer a script with a login page. The endpoint checks the token
              itself, which is the stronger control for a machine client.
            </li>
            <li>
              Run <code>pushRatingsToKaizen</code> once by hand to authorise it and see the log,
              then <code>installKaizenTrigger</code> for a daily push.
            </li>
          </ol>
        </>
      )}
    </div>
  );
}

/**
 * The ratings feed.
 *
 * Apps Script scrapes where scraping works, writes a tab twice a day and
 * publishes it as CSV. This reads it. Nothing inbound means no Access
 * bypass and no token — and unlike a POST body, the sheet is something a
 * person can open when a number looks wrong.
 */
function FeedPanel({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [url, setUrl] = useState(account.feedCsvUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<FeedResult | null>(null);

  const pull = async () => {
    setBusy(true); setRes(null);
    const r = await pullFeed(url.trim()).catch(e => ({
      ok: false, rows: 0, written: 0, duplicates: 0, unmatched: [], problem: String(e)
    } as FeedResult));
    setBusy(false); setRes(r);
    if (r.ok) onSaved();
  };

  return (
    <div className="card">
      <h2>Ratings feed</h2>
      <p className="note">
        In the Apps Script project run <code>installKaizenTriggers()</code> once: it writes a
        <code>🔁 Kaizen Feed</code> tab and schedules it for 6am and 6pm. Publish that tab —
        File → Share → Publish to web → CSV — and paste the URL here. After that it refreshes
        itself; this button is for the first pull and for “it should have updated by now”.
      </p>
      <label>
        Published CSV URL
        <input value={url} onChange={e => setUrl(e.target.value)}
               placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv" />
      </label>
      <div className="button-row">
        <button onClick={() => void pull()} disabled={busy || !url.trim()}>
          {busy ? 'Reading…' : 'Pull now'}
        </button>
      </div>

      {res && !res.ok && <p className="banner error">{res.problem}</p>}
      {res?.ok && (
        <p className="note">
          {res.rows} row(s) read · <strong>{res.written} new</strong>
          {/* Re-reading an unchanged sheet is meant to write nothing. Saying
              so stops "0 new" looking like a failure. */}
          {res.duplicates > 0 && ` · ${res.duplicates} already had (re-reading the same sheet writes nothing)`}
          {res.unmatched.length > 0 && ` · no unit matches: ${res.unmatched.join(', ')}`}
        </p>
      )}
    </div>
  );
}

/**
 * Alerts, staged until somebody says otherwise.
 *
 * The whole path runs with sending switched off — recipients resolved,
 * message folded to GSM-7, segments counted, a row written saying what
 * WOULD have gone out. That is the only way to find a three-segment
 * message or an unparseable number without a phone proving it.
 */
function AlertsPanel({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [from, setFrom] = useState(account.quoFrom ?? '');
  const [to, setTo] = useState((account.quoRecipients ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [cron, setCron] = useState<CronResult | null>(null);

  // A live preview of the real thing: the same sanitiser and the same
  // segment counter the sender uses, so what is shown is what is billed.
  const sample = sanitize('CL1339: 12% booked, asking $237 vs $178 achieved, $5,451 open. Open Kaizen OS to price it.');
  const seg = segments(sample);

  const save = async (over: Record<string, unknown> = {}) => {
    setBusy(true); setMsg('');
    const r = await saveSettings({
      quoApiKey: key || undefined,
      quoFrom: from,
      quoRecipients: to.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean),
      ...over
    });
    setBusy(false); setKey('');
    setMsg(r.ok ? 'Saved.' : (r.error ?? 'Failed.'));
    if (r.ok) onSaved();
  };

  const run = async () => {
    setBusy(true); setCron(null);
    const r = await runCron().catch(e => ({ ok: false, error: String(e) } as CronResult));
    setBusy(false); setCron(r);
    onSaved();
  };

  return (
    <div className="card">
      <h2>Alerts <span className={account.quoLive ? 'ok-tag' : 'chan-tag'}>
        {account.quoLive ? 'sending' : 'staged'}</span></h2>
      <p className="note">
        One message when a listing goes red, one when it comes back. Never while it simply stays
        red — a channel that repeats itself daily is a channel people mute, and then the message
        that mattered arrives to nobody. A listing counts as red only when a price change could
        still recover real money, so this is a handful of units, not a digest.
      </p>

      <div className="row">
        <label>QUO API key {account.hasQuoKey && <span className="ok-tag">stored</span>}
          <input type="password" value={key} onChange={e => setKey(e.target.value)}
                 placeholder={account.hasQuoKey ? 'stored — type to replace' : ''} />
        </label>
        <label>Send from
          <input value={from} onChange={e => setFrom(e.target.value)} placeholder="+1…" />
        </label>
      </div>
      <label>Send to
        <input value={to} onChange={e => setTo(e.target.value)} placeholder="+1…, +1…" />
      </label>

      <div className="preview">
        <div className="fact-k">What one looks like</div>
        <p className="mono">{sample}</p>
        <p className="note">
          {seg.used} characters · {seg.encoding} · <strong>{seg.count} segment
          {seg.count === 1 ? '' : 's'}</strong>. Curly quotes, dashes and emoji are folded to
          plain equivalents first: one character outside GSM-7 drops the segment from 160
          characters to 70 and triples the bill.
        </p>
      </div>

      <div className="button-row">
        <button onClick={() => void save()} disabled={busy}>Save</button>
        <button className="ghost" onClick={() => void run()} disabled={busy}>
          {busy ? 'Running…' : 'Run the check now'}
        </button>
        <label className="check">
          <input type="checkbox" checked={account.quoLive}
                 onChange={e => void save({ quoLive: e.target.checked })} />
          Actually send
        </label>
      </div>
      {!account.quoLive && (
        <p className="note">
          Staged. Everything runs and is logged; nothing leaves. Tick the box once the staged
          messages read the way you want them to.
        </p>
      )}
      {msg && <p className="note">{msg}</p>}

      {cron && (
        <div className={`disclaimer ${cron.ok ? 'good' : 'bad'}`}>
          {cron.ok ? (
            <>
              <strong>{cron.red} red · {cron.changed} changed</strong>
              <p className="note">
                Decisions closed: {cron.outcomes?.booked ?? 0} booked, {cron.outcomes?.expired ?? 0} expired,
                {' '}{cron.outcomes?.stillOpen ?? 0} still open of {cron.outcomes?.checked ?? 0} checked.
              </p>
              {(cron.alerts ?? []).map((a, i) => (
                <p key={i} className="mono">{a.unit} · {a.edge} · {a.outcome} · {a.segments} seg</p>
              ))}
              {cron.changed === 0 && <p className="note">Nothing changed since the last run, so nothing was sent.</p>}
            </>
          ) : <p>{cron.error}</p>}
        </div>
      )}
    </div>
  );
}
