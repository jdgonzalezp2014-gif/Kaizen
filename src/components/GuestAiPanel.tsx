/**
 * Settings → Integrations → Guest messages & AI (owner, 2026-11-16): how the Inbox talks to guests for this account —
 * whether Kaizen really sends (off = staged), the reply AI (off / suggest — its models are in AI tasks, src/components/AiTasksPanel.tsx — the
 * house style), and the guest portal's address (it moves to its own domain; every link is built from this).
 * The API key is the account's own Claude / Gemini key, set in Integrations → AI — never typed here.
 */
import { useEffect, useState } from 'react';
import { getInboxSettings, saveInboxSettings, type InboxSettings } from '../api.ts';
import { MAX_BUSINESS, type GuestAi } from '../lib/inbox.ts';
import { WAIT_CHOICES } from '../lib/guest-watch.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';

export function GuestAiPanel({ onSaved }: { onSaved?: (s: InboxSettings) => void }) {
  const [s, setS] = useState<InboxSettings | null>(null);
  const [ai, setAi] = useState<GuestAi | null>(null);
  const [portal, setPortal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const take = (r: InboxSettings) => { setS(r); setAi(r.ai); setPortal(r.portalUrl ?? ''); onSaved?.(r); };
  useEffect(() => { void getInboxSettings().then(r => { if (r.ok) take(r); else setMsg(r.message ?? 'Could not load.'); }).catch(e => setMsg(String(e))); }, []);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg('');
    const r = await saveInboxSettings({ action: 'settings', ...body }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) { take(r); setMsg('Saved.'); } else setMsg(r.message ?? 'Not saved.');
  };
  if (!s || !ai) return <div className="card"><p className="note">{msg || 'Loading…'}</p></div>;
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
        <h2>Reply AI <Hint>The assistant drafts a reply for the conversation on screen from the listing's Repository record (guide, description, capacity, fees,
          house rules), Hostaway's amenities and this booking (party, pets, hours, total), the work open on the stay, the company facts below, the other
          listings, the guest-side SOPs that match and the thread. Before a booking it leaves out the exact address, Wi-Fi and arrival steps; codes are always withheld.
          A person reads it and sends — it never answers on its own (that mode is not built). It uses this company's own API key from Integrations → AI,
          and the models in AI tasks → Guest replies, in order: the next one writes only when the first fails, and the draft says which one wrote it.</Hint></h2>
        <div className="row">
          <label>Mode
            <select value={ai.mode} onChange={e => setAi({ ...ai, mode: e.target.value as GuestAi['mode'] })}>
              <option value="off">Off</option>
              <option value="suggest">Suggest a reply (a person sends)</option>
              <option value="auto" disabled>Answer on its own — later</option>
            </select>
          </label>
          <p className="note">Model: set in Integrations → AI → AI tasks → <b>Guest replies</b> (a first model and the ones behind it).</p>
        </div>
        <label>House style <Hint>Optional. How the company wants to sound — a sign-off, words to avoid, what to always mention. Rules about what is allowed
          belong in the SOPs, where the team reads them too.</Hint>
          <textarea className="ix-text" rows={3} maxLength={2000} value={ai.instructions} onChange={e => setAi({ ...ai, instructions: e.target.value })} />
        </label>
        <label>Company facts for guests <Hint>What is true for every listing and no Repository field holds — the AI may quote it to a guest. One line each:
          the hours the team answers and the emergency line; early check-in and late check-out (price, how far ahead, who approves); luggage drop;
          discounts for long stays; refunds and cancellations; booking approval (what we ask and how long it takes); insurance / relocation stays;
          what to do if something breaks; pets, parties, smoking, quiet hours. Never a door or lockbox code. When a draft says “Missing: …”, the
          fact usually belongs here or in the listing's record.</Hint>
          <textarea className="ix-text" rows={6} maxLength={MAX_BUSINESS} value={ai.business}
                    placeholder={'Team answers 8 AM – 10 PM Central; urgent issues 24/7 by message.\nEarly check-in: $20/hour before check-in, ask a day before, subject to approval.'}
                    onChange={e => setAi({ ...ai, business: e.target.value })} />
        </label>
        <label className="check inline"><input type="checkbox" checked={ai.autoDraft} onChange={e => setAi({ ...ai, autoDraft: e.target.checked })} />
          Draft a reply when a guest writes <Hint>The moment Hostaway reports a guest message that needs an answer, the AI writes the reply and it waits
            in that conversation (✦ in the list). Nobody is messaged: a person uses it, edits it, sends it — or dismisses it.</Hint></label>
        <label className="check inline"><input type="checkbox" checked={ai.portalFirst} onChange={e => setAi({ ...ai, portalFirst: e.target.checked })} />
          Online check-in first <Hint>Until the guest finishes the online check-in, the draft never gives the door code, arrival steps, exact address or
            Wi-Fi: it asks the guest to complete it with their portal link, and answers everything else. Once it is done, arrival questions are answered
            and the code stays in the portal.</Hint></label>
        <label className="check inline"><input type="checkbox" checked={ai.oldPortalNotice} onChange={e => setAi({ ...ai, oldPortalNotice: e.target.checked })} />
          Tell guests who used the old check-in <Hint>A guest who already signed the agreement or gave an ID in Hostaway's old portal is thanked, told we moved
            to a new online check-in, and asked to complete it once.</Hint></label>
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
      <div className="card">
        <h2>Live guest messages <Hint>Hostaway tells Kaizen the moment a guest writes or a booking is made. With it: the count of guests waiting on the menu, this
          computer's notice, "After booking" automations at once instead of within 5 minutes, and the watch below. To connect: in Hostaway → Settings → Integrations →
          Webhooks, add a <b>unified webhook</b> with this address (leave login and password empty — the address carries its own secret). Anyone holding the address
          can only report an event; Kaizen re-reads the truth from Hostaway. Treat it like a password all the same.</Hint></h2>
        {!s.migrated117 && <p className="note warn"><Icon n="alert" /> Needs migration 117 first (npm run migrate).</p>}
        <div className="row">
          <label>Webhook address<input readOnly value={s.hookUrl.replace(/k=.+$/, 'k=••••••••')} spellCheck={false} onFocus={e => e.target.select()} /></label>
          <button className="secondary" onClick={() => { void navigator.clipboard?.writeText(s.hookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p className="note">{s.lastEventAt ? <><Icon n="check" /> Connected — last event {new Date(s.lastEventAt).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.</>
          : <><Icon n="clock" /> Nothing received yet.</>}</p>
      </div>
      <div className="card">
        <h2>Unanswered guests <Hint>No Slack line per message. A light AI model reads each guest message as it arrives and sorts it: does it ask for an answer
          ("thanks!" does not), is it urgent (locked out, no power, a leak…). <b>Urgent</b> is told to the team at once. Anything else that asks for an answer and is
          still unanswered after the wait below is reported <b>once</b> — only for guests who are coming or in the house; one who already left is not chased. Before
          reporting, the conversation is read again: an answer given from Hostaway's own app counts. It posts to Slack's <b>Escalations</b> channel (Settings →
          Integrations → Slack → channels). Needs live guest messages, above.</Hint></h2>
        <div className="row">
          <label className="check inline">
            <input type="checkbox" checked={s.watch.watch} disabled={busy} onChange={e => void save({ watch: { ...s.watch, watch: e.target.checked } })} />
            <span>Tell the team in Slack</span>
          </label>
          <label>After waiting
            <select value={s.watch.waitMinutes} disabled={busy || !s.watch.watch} onChange={e => void save({ watch: { ...s.watch, waitMinutes: Number(e.target.value) } })}>
              {[...new Set([...WAIT_CHOICES, s.watch.waitMinutes])].sort((a, b) => a - b).map(m => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
            </select>
          </label>
        </div>
        {s.watch.watch && <p className={s.watchChannel ? 'note' : 'note warn'}>{s.watchChannel ? <><Icon n="check" /> Posts to #{s.watchChannel}.</>
          : <><Icon n="alert" /> No Escalations channel chosen in Slack's settings — nothing is posted until one is.</>}</p>}
      </div>
      {msg && <p className="note">{msg}</p>}
    </>
  );
}
