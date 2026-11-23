/**
 * Guest Services → Inbox → Automations (owner, 2026-11-16): the messages that go to guests on their own — when
 * something happens (a booking, the online check-in is finished) or at a moment of the stay (before / after check-in
 * and check-out) — for all listings or the chosen ones, with a condition. And the quick replies a person picks in
 * the reply box. One card each: when · for whom · what it did in the last 30 days.
 *
 * They are `message_templates` rows; the outbox sends them (functions/_lib/guest-outbox.ts) — once per stay, only for
 * confirmed bookings, dropped if the booking was cancelled meanwhile.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getAutomations, saveInboxSettings, type Automations as Data } from '../api.ts';
import { COND_SUBJECTS, HOUSE_VARS, MAX_BODY, RECIPES, TRIGGERS, VARS, condWords, isEvent, scopeWords, whenWords, type Channel, type Cond, type Template, type Trigger } from '../lib/inbox.ts';
import { Hint } from '../components/Hint.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Modal.tsx';

const BLANK: Template = { id: '', name: '', body: '', channel: 'hostaway', trigger: 'before_checkin', offsetHours: 24, active: true, listingIds: null, conditions: [], holdHours: null };
const QUICK: Template = { ...BLANK, trigger: 'manual', offsetHours: 0 };
const day = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).format(new Date(iso));

export function Automations({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<Template | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => getAutomations().then(r => { if (r.ok) { setData(r); setErr(''); } else setErr(r.message ?? 'Could not load the automations.'); }).catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, []);

  const stats = useMemo(() => {
    const m = new Map<string, { sent: number; failed: number; staged: number; last: string | null }>();
    for (const s of data?.stats ?? []) {
      const x = m.get(s.id) ?? { sent: 0, failed: 0, staged: 0, last: null };
      if (s.status === 'sent') x.sent += s.n; else if (s.status === 'staged') x.staged += s.n; else if (s.status === 'failed') x.failed += s.n;
      if (s.last && (!x.last || s.last > x.last)) x.last = s.last;
      m.set(s.id, x);
    }
    return m;
  }, [data]);
  const save = async (t: Template) => {
    setBusy(t.id || 'new'); setErr('');
    const r = await saveInboxSettings({ action: 'template', ...t, id: t.id || undefined }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy('');
    if (!r.ok) { setErr(r.message ?? 'Not saved.'); void load(); return false; }
    void load(); return true;
  };
  const remove = async (t: Template) => {
    setBusy(t.id);
    const r = await saveInboxSettings({ action: 'removeTemplate', id: t.id }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy('');
    if (!r.ok) { setErr(r.message ?? 'Not deleted.'); return false; }
    void load(); return true;
  };
  const autos = data?.templates.filter(t => t.trigger !== 'manual') ?? [], quick = data?.templates.filter(t => t.trigger === 'manual') ?? [];
  const unitName = (id: string) => data?.units.find(u => u.id === id)?.name ?? `#${id}`;

  return (
    <div className="ix-auto">
      <header className="ix-auto-head">
        <button type="button" className="ix-icon-btn" aria-label="Back to the inbox" title="Back to the inbox" onClick={onBack}><Icon n="undo" /></button>
        <h2>Automations <Hint>Messages Kaizen sends to guests on its own. Each one has a moment — when something happens (a booking, the online check-in is finished)
          or a time around check-in / check-out — the listings it is for, and optionally a condition. It goes <b>once per stay</b>, only for confirmed bookings, through the
          outbox (which tries again if a send fails) and shows in that guest's conversation. A message whose blank has no value (no door code, no portal address) is
          <b> not sent</b> and says why. While guest messages are off in Settings they are kept as <b>Staged</b>.</Hint></h2>
        <span className="ix-grow" />
        <button type="button" className="ix-send" onClick={() => setEdit(BLANK)}>New automation</button>
      </header>
      {err && <p className="banner error">{err}</p>}
      {data && (data.live
        ? <p className="ix-state"><Icon n="zap" /> Sending is on — an active automation reaches guests by itself.</p>
        : <p className="ix-state"><Icon n="eye" /> Sending is off — automations run and are kept as Staged, not sent.</p>)}
      {!data && !err && <p className="note ix-pad">Loading…</p>}

      {data && <>
        <ul className="ix-auto-grid">
          {autos.map(t => {
            const s = stats.get(t.id);
            return <li key={t.id} className={`ix-auto-card ${t.active ? '' : 'off'}`}>
              <div className="ix-auto-top">
                <Icon n={t.channel === 'sms' ? 'phone' : 'message'} />
                <button type="button" className="ix-auto-name" onClick={() => setEdit(t)} title="Edit">{t.name}</button>
                <label className="ix-switch" title={t.active ? 'Active — click to pause' : 'Paused — click to turn on'}>
                  <input type="checkbox" checked={t.active} disabled={busy === t.id} onChange={e => void save({ ...t, active: e.target.checked })} />
                  <span>{t.active ? 'On' : 'Paused'}</span>
                </label>
              </div>
              <p className="ix-auto-when"><Icon n="clock" /> {whenWords(t)}</p>
              <div className="ix-auto-chips">
                <span title={t.listingIds?.length ? t.listingIds.map(unitName).join(', ') : 'Every listing, including new ones'}><Icon n="home" /> {scopeWords(t)}</span>
                {t.conditions.length > 0 && <span><Icon n="filter" /> {condWords(t.conditions)}</span>}
                <span><Icon n={t.channel === 'sms' ? 'phone' : 'message'} /> {t.channel === 'sms' ? 'SMS (Quo)' : 'Chat'}</span>
              </div>
              <p className="ix-auto-body">{t.body}</p>
              <p className="ix-auto-stats">{s && (s.sent || s.failed || s.staged)
                ? <>{s.sent > 0 && <b>{s.sent} sent</b>}{s.staged > 0 && <span>{s.staged} staged</span>}{s.failed > 0 && <span className="bad"><Icon n="alert" /> {s.failed} not sent</span>}
                    {s.last && <span>last {day(s.last)}</span>}</>
                : <span>Nothing in the last 30 days</span>}</p>
            </li>;
          })}
        </ul>
        {!autos.length && <p className="note ix-pad">No automations yet — start from one of these, or make your own.</p>}

        <h3 className="ix-auto-sub">Start from <Hint>Ready-made automations. Each opens in the editor, paused: read the words, make them yours, choose the listings, then turn it on.</Hint></h3>
        <ul className="ix-auto-grid recipes">
          {RECIPES.map(r => <li key={r.key}>
            <button type="button" className="ix-auto-card recipe" onClick={() => setEdit({ ...r.t, id: '' })}>
              <span className="ix-auto-top"><Icon n={r.icon} /><b>{r.t.name}</b></span>
              <span className="ix-auto-when">{r.what}</span>
            </button>
          </li>)}
        </ul>

        <h3 className="ix-auto-sub">Quick replies <span className="ix-count">{quick.length}</span>
          <Hint>Messages with blanks that a person picks in the reply box (the Template menu) — they never go on their own.</Hint>
          <button type="button" className="ix-add" aria-label="New quick reply" onClick={() => setEdit(QUICK)}>+</button></h3>
        <ul className="ix-tpls">
          {quick.map(t => <li key={t.id} className={t.active ? '' : 'off'}>
            <button type="button" className="ix-tpl" onClick={() => setEdit(t)}><Icon n={t.channel === 'sms' ? 'phone' : 'message'} />
              <span><b>{t.name}</b><span>{t.body.slice(0, 110)}</span></span></button>
          </li>)}
        </ul>
        {!quick.length && <p className="note ix-pad">None yet.</p>}
      </>}

      {edit && data && <Editor t={edit} units={data.units} live={data.live} busy={busy !== ''} onClose={() => setEdit(null)}
                               onSave={async t => { if (await save(t)) setEdit(null); }} onDelete={async t => { if (await remove(t)) setEdit(null); }} />}
    </div>
  );
}

function Editor({ t, units, live, busy, onClose, onSave, onDelete }: {
  t: Template; units: { id: string; name: string }[]; live: boolean; busy: boolean; onClose: () => void; onSave: (t: Template) => void; onDelete: (t: Template) => void;
}) {
  const [e, setE] = useState<Template>(t);
  const [days, setDays] = useState(t.offsetHours > 0 && t.offsetHours % 24 === 0);
  const [some, setSome] = useState(!!t.listingIds?.length);
  const [q, setQ] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const manual = e.trigger === 'manual';
  const insert = (v: string) => {
    const el = area.current, at = el?.selectionStart ?? e.body.length;
    setE({ ...e, body: `${e.body.slice(0, at)}{{${v}}}${e.body.slice(el?.selectionEnd ?? at)}` });
    el?.focus();
  };
  const picked = new Set(e.listingIds ?? []);
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setE({ ...e, listingIds: [...n] }); };
  const shown = units.filter(u => !q.trim() || u.name.toLowerCase().includes(q.trim().toLowerCase()));
  const usesHouse = HOUSE_VARS.filter(v => new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`, 'i').test(e.body));
  const ok = e.name.trim() && e.body.trim() && (!some || picked.size > 0);
  return (
    <Modal title={manual ? (t.id ? 'Quick reply' : 'New quick reply') : t.id ? 'Automation' : 'New automation'} onClose={onClose} wide>
      <div className="ix-form ix-tpl-form">
        <label>Name<input value={e.name} maxLength={80} autoFocus={!t.name} onChange={x => setE({ ...e, name: x.target.value })} /></label>
        <div className="ix-form-row">
          <label>Goes<select value={e.trigger} onChange={x => setE({ ...e, trigger: x.target.value as Trigger })}>
            {TRIGGERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {!manual && <label>{isEvent(e.trigger) ? 'Wait' : 'How long'}<span className="ix-offset">
            <input type="number" min={0} max={days ? 30 : 720} value={days ? e.offsetHours / 24 : e.offsetHours}
                   onChange={x => setE({ ...e, offsetHours: Math.max(0, Math.round(Number(x.target.value) || 0)) * (days ? 24 : 1) })} />
            <select value={days ? 'd' : 'h'} aria-label="Unit" onChange={x => { const d = x.target.value === 'd'; setDays(d); setE({ ...e, offsetHours: d ? Math.round(e.offsetHours / 24) * 24 : e.offsetHours }); }}>
              <option value="h">hours</option><option value="d">days</option></select></span></label>}
          <label>Channel<select value={e.channel} onChange={x => setE({ ...e, channel: x.target.value as Channel })}>
            <option value="hostaway">Chat (Hostaway)</option><option value="sms">SMS (Quo)</option></select></label>
        </div>
        {!manual && isEvent(e.trigger) && <label className="ix-check">
          <input type="checkbox" checked={e.holdHours != null} onChange={x => setE({ ...e, holdHours: x.target.checked ? 48 : null })} />
          Not before
          <input type="number" className="ix-num" min={0} max={720} disabled={e.holdHours == null} value={e.holdHours ?? 48} aria-label="Hours before check-in"
                 onChange={x => setE({ ...e, holdHours: Math.max(0, Math.round(Number(x.target.value) || 0)) })} />
          hours ahead of check-in
          <Hint label="Why hold a message">A guest may finish the online check-in weeks ahead. With this on, the message waits until the stay is this close —
            a door code is not left in an inbox for three weeks. If the event happens later than that, the message goes at once.</Hint>
        </label>}
        {!manual && <p className="ix-auto-sum"><Icon n="clock" /> {whenWords(e)}</p>}

        {!manual && <>
          <div className="ix-form-row">
            <label>For<select value={some ? 'some' : 'all'} onChange={x => { const s = x.target.value === 'some'; setSome(s); if (!s) setE({ ...e, listingIds: null }); }}>
              <option value="all">All listings</option><option value="some">Only these listings</option></select></label>
          </div>
          <fieldset className="ix-conds">
            <legend>Only if <Hint label="How conditions work">Each one you set must hold for the message to go. <b>Not done / Pending / Not signed /
              Not verified</b> work as a stopper: the moment the guest does it, the message is not needed any more — a reminder stops by itself, even
              if its moment has not come. <b>Done / Paid / Signed / Verified</b> are checked when the message's moment comes; if it does not hold then,
              the message is skipped for that stay. Payment, agreement and ID are what Hostaway reports; a payment Hostaway does not know (Expedia
              collects) and a booking without an agreement count as done — nobody is chased for them. The online check-in is Kaizen's own (the guest
              portal, or "Mark done" in the conversation). Hostaway's ID check was off on every stay seen on 2026-11-17 — until the
              portal's own verification reports it, "ID verified" never holds. <b>Stay length</b>: a monthly stay is 28 nights or more.
              <b>Night after check-out</b> is read from the hourly calendar look; when Kaizen has not seen the calendar in the last day, the
              message is skipped (no extension is offered on a guess).</Hint></legend>
            {COND_SUBJECTS.map(([k, label, no, yes]) => {
              const cur = e.conditions.find(c => c.startsWith(`${k}_`)) ?? '';
              return <label key={k}>{label}<select value={cur} onChange={x => {
                const rest = e.conditions.filter(c => !c.startsWith(`${k}_`));
                const v = x.target.value as Cond | '';
                setE({ ...e, conditions: COND_SUBJECTS.flatMap(([s2]) => (v && v.startsWith(`${s2}_`) ? [v] : rest.filter(c => c.startsWith(`${s2}_`)))) });
              }}>
                <option value="">Any</option><option value={`${k}_pending`}>{no}</option><option value={`${k}_done`}>{yes}</option></select></label>;
            })}
          </fieldset>
          {some && <div className="ix-units">
            <label className="ix-search"><Icon n="search" /><input type="search" value={q} placeholder="Listing" aria-label="Search a listing" onChange={x => setQ(x.target.value)} /></label>
            <ul>{shown.map(u => <li key={u.id}><label className="ix-check"><input type="checkbox" checked={picked.has(u.id)} onChange={() => toggle(u.id)} /> {u.name}</label></li>)}</ul>
            <p className="note">{picked.size} chosen</p>
          </div>}
        </>}

        <label>Message<textarea ref={area} className="ix-text" rows={6} maxLength={MAX_BODY} value={e.body} onChange={x => setE({ ...e, body: x.target.value })} /></label>
        <div className="ix-vars" aria-label="Insert a blank">{VARS.filter(([k]) => !manual || !HOUSE_VARS.includes(k)).map(([k, l]) =>
          <button key={k} type="button" className="ix-pill" title={l} onClick={() => insert(k)}>{k}</button>)}</div>
        {usesHouse.includes('door_code') && <p className="ix-state"><Icon n="key" /> The door code is the reservation's own in Hostaway (smart locks), else the Repository's guest code.
          A stay with neither is not sent — it shows as Not sent in that conversation.</p>}
        <label className="ix-check"><input type="checkbox" checked={e.active} onChange={x => setE({ ...e, active: x.target.checked })} /> Active
          {!manual && live && e.active && <span className="ix-warn"><Icon n="zap" /> Sending is on: it will reach guests by itself.</span>}</label>
        <div className="ix-form-row">
          <button type="button" className="ix-send" disabled={busy || !ok} onClick={() => onSave({ ...e, listingIds: some ? [...picked] : null })}>Save</button>
          <button type="button" className="ix-ghost" onClick={onClose}>Cancel</button>
          <span className="ix-grow" />
          {t.id && <button type="button" className="link tiny danger" disabled={busy} onClick={() => onDelete(t)}>Delete</button>}
        </div>
      </div>
    </Modal>
  );
}
