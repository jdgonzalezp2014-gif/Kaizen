/**
 * Settings → Integrations → Guest messages & AI (owner, 2026-11-16): how the Inbox talks to guests for this account —
 * whether Kaizen really sends (off = staged), the reply AI (off / suggest, which provider's API and which model, the
 * house style), and the guest portal's address (it moves to its own domain; every link is built from this).
 * The API key is the account's own Claude / Gemini key, set in Integrations → AI — never typed here.
 */
import { useEffect, useState } from 'react';
import { getInboxSettings, saveInboxSettings, type InboxSettings } from '../api.ts';
import { AI_MODELS, type AiProvider, type GuestAi } from '../lib/inbox.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';

export function GuestAiPanel({ onSaved }: { onSaved?: (s: InboxSettings) => void }) {
  const [s, setS] = useState<InboxSettings | null>(null);
  const [ai, setAi] = useState<GuestAi | null>(null);
  const [portal, setPortal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const take = (r: InboxSettings) => { setS(r); setAi(r.ai); setPortal(r.portalUrl ?? ''); onSaved?.(r); };
  useEffect(() => { void getInboxSettings().then(r => { if (r.ok) take(r); else setMsg(r.message ?? 'Could not load.'); }).catch(e => setMsg(String(e))); }, []);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg('');
    const r = await saveInboxSettings({ action: 'settings', ...body }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) { take(r); setMsg('Saved.'); } else setMsg(r.message ?? 'Not saved.');
  };
  if (!s || !ai) return <div className="card"><p className="note">{msg || 'Loading…'}</p></div>;
  const hasKey = ai.provider === 'claude' ? s.hasClaudeKey : s.hasGeminiKey;
  return (
    <>
      {!s.migrated && <p className="banner warn">The database needs migration 116 before any of this can be saved (npm run migrate).</p>}
      <div className="card">
        <h2>Sending to guests <Hint>Off: everything written or scheduled in the Inbox is kept as <b>Staged</b> — the whole path runs, nothing reaches a guest, and
          Hostaway keeps sending its own automated messages. Turn it on only after reading the staged messages beside Hostaway's: from then on a reply
          typed in the Inbox goes to the guest through Hostaway (or Quo for SMS), and the automatic templates send on their own.</Hint></h2>
        <label className="check inline">
          <input type="checkbox" checked={s.live} disabled={busy} onChange={e => void save({ live: e.target.checked })} />
          {s.live ? <span><Icon n="check" /> On — Kaizen sends to guests</span> : <span><Icon n="eye" /> Off — messages are staged, not sent</span>}
        </label>
      </div>
      <div className="card">
        <h2>Reply AI <Hint>The assistant drafts a reply for the conversation on screen from the listing's Repository record, the published SOPs and the thread.
          A person reads it and sends — it never answers on its own (that mode is not built). It uses this company's own API key from Integrations → AI,
          and exactly the model named here.</Hint></h2>
        <div className="row">
          <label>Mode
            <select value={ai.mode} onChange={e => setAi({ ...ai, mode: e.target.value as GuestAi['mode'] })}>
              <option value="off">Off</option>
              <option value="suggest">Suggest a reply (a person sends)</option>
              <option value="auto" disabled>Answer on its own — later</option>
            </select>
          </label>
          <label>API
            <select value={ai.provider} onChange={e => { const p = e.target.value as AiProvider; setAi({ ...ai, provider: p, model: AI_MODELS[p][0]! }); }}>
              <option value="claude">Claude (Anthropic)</option>
              <option value="gemini">Gemini (Google)</option>
            </select>
          </label>
          <label>Model
            <input value={ai.model} list="guest-ai-models" spellCheck={false} onChange={e => setAi({ ...ai, model: e.target.value })} />
            <datalist id="guest-ai-models">{AI_MODELS[ai.provider].map(m => <option key={m} value={m} />)}</datalist>
          </label>
        </div>
        {!hasKey && <p className="note warn"><Icon n="alert" /> No {ai.provider === 'claude' ? 'Claude' : 'Gemini'} key stored yet — add it in Integrations → AI.</p>}
        <label>House style <Hint>Optional. How the company wants to sound — a sign-off, words to avoid, what to always mention. Rules about what is allowed
          belong in the SOPs, where the team reads them too.</Hint>
          <textarea className="ix-text" rows={3} maxLength={2000} value={ai.instructions} onChange={e => setAi({ ...ai, instructions: e.target.value })} />
        </label>
        <div className="row"><button disabled={busy} onClick={() => void save({ ai })}>Save</button></div>
      </div>
      <div className="card">
        <h2>Guest portal address <Hint>Where guests open their portal — its own domain, separate from the team's app. Every stay's link is this address
          + /guest/&lt;reservation&gt;.&lt;signature&gt;; it is what {'{{portal_link}}'} puts in a message and what the Inbox opens. Leave it blank until the portal is live there.</Hint></h2>
        <div className="row">
          <label>Address<input value={portal} placeholder="https://stay.yourcompany.com" spellCheck={false} onChange={e => setPortal(e.target.value)} /></label>
          <button className="secondary" disabled={busy} onClick={() => void save({ portalUrl: portal })}>Save</button>
        </div>
      </div>
      {msg && <p className="note">{msg}</p>}
    </>
  );
}
