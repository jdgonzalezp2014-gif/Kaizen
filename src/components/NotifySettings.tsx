/**
 * The bell's settings (owner 2026-11-17: "a professional customization and test menu"): guest messages and task
 * alerts each with their own switch, filter, tone and notices; one volume; quiet hours; a pause; and a test bench
 * that sends a sample of each kind through the same path a real one takes, plus a check of what this browser allows.
 * Per browser (localStorage), like the theme — the rules themselves are `src/lib/notify.ts`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal.tsx';
import { Icon } from './Icon.tsx';
import { Hint } from './Hint.tsx';
import { soundReady, testChime } from './chime.ts';
import { DEFAULT_PREFS, TONES, inQuiet, normalizePrefs, type Kind, type NotifyPrefs, type Tone } from '../lib/notify.ts';

const KEY = 'kaizen.notify.prefs';
const LEGACY = 'kaizen.live.sound';
export const loadPrefs = (): NotifyPrefs => {
  try { return normalizePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'), JSON.parse(localStorage.getItem(LEGACY) ?? 'null')); }
  catch { return DEFAULT_PREFS; }
};
export const savePrefs = (p: NotifyPrefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); localStorage.removeItem(LEGACY); } catch { /* private window */ } };

const hasDesktop = typeof Notification !== 'undefined';
/** Fired on `window` by the test buttons: `detail` is a bell item with `test: true`; the bell takes it like a real one. */
export const BELL_TEST = 'kaizen-bell-test';

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`nset-switch${disabled ? ' off' : ''}`}>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={e => onChange(e.target.checked)} aria-label={label} />
      <span aria-hidden="true" />
    </label>
  );
}
const Row = ({ label, sub, children }: { label: ReactNode; sub?: ReactNode; children: ReactNode }) => (
  <div className="nset-row"><div className="nset-label"><span>{label}</span>{sub && <span className="note">{sub}</span>}</div><div className="nset-ctl">{children}</div></div>
);

const SAMPLE: Record<Kind, (urgent: boolean) => Record<string, unknown>> = {
  messages: urgent => ({ kind: 'messages', what: 'Test guest', title: urgent ? 'The door code is not working and we are outside.' : 'Hi! What time is check-in?', urgent, conversation: undefined }),
  tasks: urgent => ({ kind: 'tasks', what: 'To-do · Test unit', title: urgent ? 'Water leak under the sink' : 'Replace the hallway bulb', urgent, event: 'new', by: 'test' })
};

export function NotifySettings({ prefs, onChange, tasks, messages, onClose }: {
  prefs: NotifyPrefs; onChange: (p: NotifyPrefs) => void; tasks: boolean; messages: boolean; onClose: () => void;
}) {
  const [perm, setPerm] = useState<NotificationPermission>(hasDesktop ? Notification.permission : 'denied');
  const [ready, setReady] = useState(soundReady());
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => { const t = window.setInterval(() => setReady(soundReady()), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => { if (!sent) return; const t = window.setTimeout(() => setSent(null), 4000); return () => window.clearTimeout(t); }, [sent]);

  const set = (f: (p: NotifyPrefs) => NotifyPrefs) => onChange(f(prefs));
  const ch = <K extends Kind>(k: K, patch: Partial<NotifyPrefs[K]>) => set(p => ({ ...p, [k]: { ...p[k], ...patch } }));
  const ask = async () => { if (hasDesktop) setPerm(await Notification.requestPermission()); };
  const play = (tone: Tone) => { testChime(prefs.volume, tone); setReady(soundReady()); };
  const send = (k: Kind, urgent = false) => {
    setReady(soundReady());
    dispatchEvent(new CustomEvent(BELL_TEST, { detail: { key: `test:${k}:${Date.now()}`, at: new Date().toISOString(), test: true, ...SAMPLE[k](urgent) } }));
    setSent(`Test ${k === 'messages' ? 'message' : 'task alert'} sent — see the bell${prefs[k].toast ? ' and the notice at the bottom' : ''}.`);
  };
  const pauseFor = (min: number | 'morning') => {
    let until: number;
    if (min === 'morning') { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0)); d.setHours(8, 0, 0, 0); until = d.getTime(); }
    else until = Date.now() + min * 60_000;
    set(p => ({ ...p, pausedUntil: until }));
  };
  const paused = prefs.pausedUntil > Date.now();
  const quietNow = inQuiet(prefs.quiet, new Date());

  const tone = (k: Kind) => (
    <span className="nset-tone">
      <select value={prefs[k].tone} aria-label="Tone" disabled={!prefs[k].on} onChange={e => ch(k, { tone: e.target.value as Tone })}>
        {TONES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <button type="button" className="ghost small" disabled={prefs[k].tone === 'none' || !prefs[k].on} onClick={() => play(prefs[k].tone)}><Icon n="zap" /> Play</button>
    </span>
  );
  const notices = (k: Kind) => <>
    <Row label="Notice on screen" sub="A short line at the bottom for 8 seconds"><Switch on={prefs[k].toast} disabled={!prefs[k].on} label="Notice on screen" onChange={v => ch(k, { toast: v })} /></Row>
    <Row label="Desktop notice" sub="When Kaizen is in another tab or window"><Switch on={prefs[k].desktop} disabled={!prefs[k].on} label="Desktop notice" onChange={v => ch(k, { desktop: v })} /></Row>
  </>;

  const checks: { ok: boolean | null; label: string; fix?: ReactNode }[] = [
    { ok: ready, label: ready ? 'Sound can play' : 'Sound waits for a click in Kaizen (the browser rule)', fix: !ready && <button type="button" className="link tiny" onClick={() => play('chime')}>Click to allow</button> },
    { ok: prefs.volume > 0, label: prefs.volume > 0 ? `Volume ${Math.round(prefs.volume * 100)}%` : 'Volume is at 0%' },
    { ok: hasDesktop ? perm === 'granted' : false, label: !hasDesktop ? 'This browser has no desktop notices' : perm === 'granted' ? 'Desktop notices allowed' : perm === 'denied' ? 'Desktop notices blocked — allow them for this site (the lock icon by the address)' : 'Desktop notices not turned on yet',
      fix: perm === 'default' && <button type="button" className="link tiny" onClick={() => void ask()}>Turn on</button> },
    { ok: !paused, label: paused ? `Paused until ${new Date(prefs.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Not paused' },
    { ok: !quietNow, label: quietNow ? `In quiet hours now (${prefs.quiet.from}–${prefs.quiet.to})` : prefs.quiet.on ? `Quiet hours ${prefs.quiet.from}–${prefs.quiet.to}, not now` : 'No quiet hours' }
  ];

  return (
    <Modal title="Notification settings" onClose={onClose}>
      <div className="nset">
        <section className="nset-card nset-status">
          <h3><Icon n="shield" /> Status <Hint>What this browser will let the bell do right now. A browser plays sound only after
            a click or a key in Kaizen since it was opened, and shows desktop notices only once you allow them — and only while
            Kaizen is open in some tab. These settings are kept in this browser; another computer or phone has its own.</Hint></h3>
          <ul className="nset-checks">
            {checks.map(c => <li key={c.label} className={c.ok ? 'ok' : 'no'}><Icon n={c.ok ? 'check' : 'warning'} /> <span>{c.label}</span>{c.fix}</li>)}
          </ul>
          <div className="nset-pause">
            <span className="note"><Icon n="moon" /> Pause all sounds and notices:</span>
            {paused ? <button type="button" className="ghost small" onClick={() => set(p => ({ ...p, pausedUntil: 0 }))}>Resume now</button> : <>
              <button type="button" className="ghost small" onClick={() => pauseFor(30)}>30 min</button>
              <button type="button" className="ghost small" onClick={() => pauseFor(60)}>1 hour</button>
              <button type="button" className="ghost small" onClick={() => pauseFor(240)}>4 hours</button>
              <button type="button" className="ghost small" onClick={() => pauseFor('morning')}>Until 8 AM</button></>}
          </div>
        </section>

        {messages && (
          <section className={`nset-card${prefs.messages.on ? '' : ' muted'}`}>
            <h3><Icon n="message" /> Guest messages <Hint>A guest wrote in Hostaway (Airbnb, Booking, VRBO, direct, SMS) and the message
              needs an answer — "thanks!" and the like do not count. "Urgent" is a guest locked out, a leak, no power… as sorted by
              the guest AI. Off = they do not reach the bell; the count on Guest Services stays.</Hint>
              <Switch on={prefs.messages.on} label="Guest messages" onChange={v => ch('messages', { on: v })} /></h3>
            <Row label="Urgent only" sub="Only guests the AI marks urgent"><Switch on={prefs.messages.urgentOnly} disabled={!prefs.messages.on} label="Urgent only" onChange={v => ch('messages', { urgentOnly: v })} /></Row>
            <Row label="Tone">{tone('messages')}</Row>
            {notices('messages')}
            <div className="nset-test">
              <button type="button" className="ghost small" onClick={() => send('messages')}><Icon n="message" /> Send a test message</button>
              <button type="button" className="ghost small" onClick={() => send('messages', true)}><Icon n="alert" /> Test an urgent one</button>
            </div>
          </section>
        )}

        {tasks && (
          <section className={`nset-card${prefs.tasks.on ? '' : ' muted'}`}>
            <h3><Icon n="clipboard" /> Task alerts <Hint>To-dos, work orders and purchase orders made, done or cancelled by someone
              else — in Kaizen, Slack, Hostaway, a cleaner's report or an inspection. Your own changes never ring. "High and urgent
              only" uses the task's priority.</Hint>
              <Switch on={prefs.tasks.on} label="Task alerts" onChange={v => ch('tasks', { on: v })} /></h3>
            <Row label="Which changes">
              <span className="nset-chips">
                {(['new', 'completed', 'cancelled'] as const).map(e => (
                  <label key={e} className={`nset-chip${prefs.tasks.events[e] ? ' on' : ''}`}>
                    <input type="checkbox" checked={prefs.tasks.events[e]} disabled={!prefs.tasks.on}
                           onChange={x => ch('tasks', { events: { ...prefs.tasks.events, [e]: x.target.checked } })} />
                    <Icon n={e === 'new' ? 'clipboard' : e === 'completed' ? 'done' : 'ban'} /> {e === 'new' ? 'New' : e === 'completed' ? 'Done' : 'Cancelled'}
                  </label>
                ))}
              </span>
            </Row>
            <Row label="High and urgent only"><Switch on={prefs.tasks.urgentOnly} disabled={!prefs.tasks.on} label="High and urgent only" onChange={v => ch('tasks', { urgentOnly: v })} /></Row>
            <Row label="Tone">{tone('tasks')}</Row>
            {notices('tasks')}
            <div className="nset-test">
              <button type="button" className="ghost small" onClick={() => send('tasks')}><Icon n="clipboard" /> Send a test task alert</button>
              <button type="button" className="ghost small" onClick={() => send('tasks', true)}><Icon n="alert" /> Test an urgent one</button>
            </div>
          </section>
        )}

        <section className="nset-card">
          <h3><Icon n="zap" /> Sound and quiet hours <Hint>One volume for every tone. In quiet hours (this computer's clock) nothing
            rings or pops up — notifications still collect in the bell. "Urgent still rings" lets an urgent guest or task through.</Hint></h3>
          <Row label="Volume">
            <span className="nset-vol">
              <input type="range" min={0} max={1} step={0.05} value={prefs.volume} aria-label="Volume" onChange={e => set(p => ({ ...p, volume: Number(e.target.value) }))} />
              <span className="note live-pct">{Math.round(prefs.volume * 100)}%</span>
            </span>
          </Row>
          <Row label="Quiet hours"><Switch on={prefs.quiet.on} label="Quiet hours" onChange={v => set(p => ({ ...p, quiet: { ...p.quiet, on: v } }))} /></Row>
          {prefs.quiet.on && <>
            <Row label="From – to">
              <span className="nset-times">
                <input type="time" value={prefs.quiet.from} aria-label="From" onChange={e => e.target.value && set(p => ({ ...p, quiet: { ...p.quiet, from: e.target.value } }))} />
                <span className="note">to</span>
                <input type="time" value={prefs.quiet.to} aria-label="To" onChange={e => e.target.value && set(p => ({ ...p, quiet: { ...p.quiet, to: e.target.value } }))} />
              </span>
            </Row>
            <Row label="Urgent still rings"><Switch on={prefs.quiet.urgentRings} label="Urgent still rings" onChange={v => set(p => ({ ...p, quiet: { ...p.quiet, urgentRings: v } }))} /></Row>
          </>}
        </section>

        <div className="nset-foot">
          {sent ? <span className="note" role="status"><Icon n="check" /> {sent}</span> : <span />}
          <button type="button" className="link tiny" onClick={() => onChange({ ...DEFAULT_PREFS, pausedUntil: 0 })}>Reset to defaults</button>
        </div>
      </div>
    </Modal>
  );
}
