/**
 * Settings → Slack (§99): the app, the connection, which channel hears
 * what, when the reservations reminder goes — and the cleaners' channels,
 * prepared but sent only by hand (cleans change, and are moved by hand).
 */
import { useEffect, useState } from 'react';
import { getOpsSettings, getSlack, slackAction, type SlackState } from '../api.ts';
import { DEFAULT_DIGEST, DEFAULT_EVENTS, DEFAULT_TASK_CHECK, TOPICS, type SlackConfig, type Topic } from '../lib/slack.ts';

const EVENT_LABEL: Record<keyof typeof DEFAULT_EVENTS, string> = {
  taskCreated: 'A task is created', taskAssigned: 'A task is assigned', taskClosed: 'A task is completed, cancelled or reopened',
  fromHostaway: 'The team changes a task in Hostaway', claimOpened: 'A claim is opened', claimChanged: 'A claim changes status'
};
const HOURS = Array.from({ length: 18 }, (_, i) => i + 5);
const hourWord = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

/** The Slack app, described for Slack's "Create from a manifest" — this deployment's URLs filled in. */
function manifest(origin: string) {
  return JSON.stringify({
    display_information: { name: 'Kaizen OS', description: 'Tasks, claims and the day’s reservations from Kaizen OS', background_color: '#1b2330' },
    features: {
      bot_user: { display_name: 'Kaizen', always_online: true },
      // Direct messages to people (§100): the app's Messages tab.
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: [{ command: '/kaizen', url: `${origin}/api/slack`, description: 'Tasks, claims and today’s check-ins',
                         usage_hint: 'tasks · task Fix the AC · repair … · claims · claim … · today', should_escape: false }],
      // ⚡ from anywhere, and ⋯ on any message (§100).
      shortcuts: [
        { name: 'New task', type: 'global', callback_id: 'new_task', description: 'Add a to-do in Kaizen' },
        { name: 'Report a repair', type: 'global', callback_id: 'new_repair', description: 'Add a repair in Kaizen' },
        { name: 'New claim', type: 'global', callback_id: 'new_claim', description: 'Log a guest claim in Kaizen' },
        { name: 'Create task from message', type: 'message', callback_id: 'task_from_message', description: 'Track this message as a Kaizen task' }
      ]
    },
    oauth_config: { scopes: { bot: ['chat:write', 'chat:write.public', 'commands', 'channels:read', 'groups:read', 'channels:manage',
                                    'groups:write', 'users:read', 'users:read.email', 'im:write',
                                    // §107: "@Kaizen …" in a thread — only the messages that name it — and the ✅ on them.
                                    'app_mentions:read', 'reactions:write'] } },
    settings: { interactivity: { is_enabled: true, request_url: `${origin}/api/slack` },
                event_subscriptions: { request_url: `${origin}/api/slack`, bot_events: ['app_mention'] }, org_deploy_enabled: false,
                socket_mode_enabled: false, token_rotation_enabled: false }
  }, null, 2);
}

export function SlackPanel() {
  const [st, setSt] = useState<SlackState | null>(null);
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [cfg, setCfg] = useState<SlackConfig>({});
  const [channels, setChannels] = useState<{ id: string; name: string; private: boolean; member: boolean }[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const origin = location.origin;

  const load = () => getSlack().then(r => { setSt(r); setCfg(r.config ?? {}); }).catch(e => setMsg({ ok: false, text: String(e) }));
  useEffect(() => { void load(); }, []);
  const connected = !!(st?.hasToken && st?.hasSecret);

  const run = async (body: Record<string, unknown>, done: (r: Awaited<ReturnType<typeof slackAction>>) => string) => {
    setBusy(true); setMsg(null);
    const r = await slackAction(body).catch(e => ({ ok: false, error: String(e) }) as Awaited<ReturnType<typeof slackAction>>);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: done(r) } : { ok: false, text: r.error ?? 'Failed.' });
    return r;
  };
  const save = (extra: Record<string, unknown> = {}) => run({ action: 'save', config: { ...cfg, appUrl: origin }, ...extra }, () => 'Saved.')
    .then(r => { if (r.ok) { setToken(''); setSecret(''); setSt(r); setCfg(r.config ?? cfg); } });
  const setChannel = (t: Topic, id: string) => {
    const c = channels?.find(x => x.id === id);
    setCfg(p => ({ ...p, channels: { ...(p.channels ?? {}), ...(c ? { [t]: { id: c.id, name: c.name } } : { [t]: undefined }) } }));
  };
  const ev = { ...DEFAULT_EVENTS, ...(cfg.events ?? {}) };
  const dg = { ...DEFAULT_DIGEST, ...(cfg.digest ?? {}) };
  const tc = { ...DEFAULT_TASK_CHECK, ...(cfg.taskCheck ?? {}) };

  return (
    <div className="card slack-panel">
      <h2>Slack</h2>
      <p className="note">Tasks, claims and the day’s reservations in Slack — and <b>/kaizen</b> to list, add, edit, complete and remove them
        from there. Whoever acts in Slack acts as the Kaizen member with the same email, with that member’s permissions.</p>
      {st && (
        <p className={`slack-state ${connected ? 'on' : ''}`}>{connected ? `● Connected${cfg.team ? ` to ${cfg.team}` : ''}` : '○ Not connected yet'}</p>
      )}

      <section className="slack-step">
        <h3>1 · The Slack app</h3>
        <p className="note">At <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">api.slack.com/apps</a> →
          <b> Create New App → From a manifest</b> → your workspace → paste this → Create → <b>Install to Workspace</b>.
          It already points /kaizen and the buttons at this Kaizen ({origin}).</p>
        <p className="note"><b>Already have the app?</b> When this manifest changes (it did for shortcuts, direct messages and thread comments): Slack → your app →
          <b> App Manifest</b> → paste → Save → <b>Reinstall to Workspace</b>. The token stays the same.</p>
        <div className="button-row">
          <button className="secondary small" onClick={() => setShowManifest(!showManifest)}>{showManifest ? 'Hide' : 'Show'} the manifest</button>
          <button className="secondary small" onClick={() => void navigator.clipboard.writeText(manifest(origin)).then(() => setMsg({ ok: true, text: 'Manifest copied.' }))}>Copy the manifest</button>
        </div>
        {showManifest && <pre className="slack-manifest">{manifest(origin)}</pre>}
      </section>

      <section className="slack-step">
        <h3>2 · Connect</h3>
        <div className="row">
          <label>Bot token <span className="sub-n">— OAuth &amp; Permissions → Bot User OAuth Token</span>
            <input type="password" value={token} placeholder={st?.hasToken ? '•••• set — type to replace' : 'xoxb-…'} onChange={e => setToken(e.target.value)} /></label>
          <label>Signing secret <span className="sub-n">— Basic Information → App Credentials</span>
            <input type="password" value={secret} placeholder={st?.hasSecret ? '•••• set — type to replace' : '32 characters'} onChange={e => setSecret(e.target.value)} /></label>
        </div>
        <div className="button-row">
          <button disabled={busy || (!token.trim() && !secret.trim())} onClick={() => void save({ botToken: token, signingSecret: secret })}>Save</button>
          <button className="secondary" disabled={busy || !st?.hasToken} onClick={() => void run({ action: 'test' }, r => `✓ ${r.bot} in ${r.team}.`).then(() => load())}>Test connection</button>
        </div>
        <p className="note">Slack reaches Kaizen at <code>/api/slack</code>, and the reminder scheduler at <code>/api/slack-cron</code>. In Cloudflare
          Zero Trust → Access → Applications, add one for those two paths with a <b>Bypass · Everyone</b> policy (as for
          <code>/api/observations</code>): Slack signs every request and Kaizen checks it, the scheduler carries the ingest token.</p>
      </section>

      {st?.hasToken && (
        <section className="slack-step">
          <h3>3 · Channels</h3>
          {!channels ? (
            <button className="secondary small" disabled={busy} onClick={() => void run({ action: 'channels' }, r => `${r.channels?.length ?? 0} channels.`).then(r => setChannels(r.channels ?? []))}>
              Read the channels</button>
          ) : (
            <div className="slack-topics">
              {TOPICS.map(t => (
                <div key={t.key} className="slack-topic">
                  <label>{t.label} <span className="sub-n">— {t.what}</span>
                    <select value={cfg.channels?.[t.key]?.id ?? ''} onChange={e => setChannel(t.key, e.target.value)}>
                      <option value="">Not sent</option>
                      {channels.map(c => <option key={c.id} value={c.id}>{c.private ? '🔒' : '#'}{c.name}{c.private && !c.member ? ' (invite @Kaizen first)' : ''}</option>)}
                    </select></label>
                  {cfg.channels?.[t.key] && <button className="link" disabled={busy} onClick={() => void save().then(() => run({ action: 'sendTest', topic: t.key }, () => `Sent to #${cfg.channels?.[t.key]?.name}.`))}>Send a test</button>}
                </div>
              ))}
            </div>
          )}
          {!channels && cfg.channels && <p className="note">Now: {TOPICS.filter(t => cfg.channels?.[t.key]).map(t => `${t.label} → #${cfg.channels![t.key]!.name}`).join(' · ') || 'no channels yet'}</p>}

          <h3>4 · What is said</h3>
          <div className="slack-events">
            {(Object.keys(EVENT_LABEL) as (keyof typeof DEFAULT_EVENTS)[]).map(k => (
              <label key={k} className="check"><input type="checkbox" checked={ev[k]} onChange={e => setCfg(p => ({ ...p, events: { ...ev, [k]: e.target.checked } }))} /> {EVENT_LABEL[k]}</label>
            ))}
          </div>
          <div className="row">
            <label>Morning reminder <span className="sub-n">today and tomorrow, and what is missing</span>
              <select value={dg.morning ?? ''} onChange={e => setCfg(p => ({ ...p, digest: { ...dg, morning: e.target.value === '' ? null : Number(e.target.value) } }))}>
                <option value="">Off</option>{HOURS.map(h => <option key={h} value={h}>{hourWord(h)} New York</option>)}
              </select></label>
            <label>Afternoon reminder <span className="sub-n">what is still missing for tomorrow</span>
              <select value={dg.afternoon ?? ''} onChange={e => setCfg(p => ({ ...p, digest: { ...dg, afternoon: e.target.value === '' ? null : Number(e.target.value) } }))}>
                <option value="">Off</option>{HOURS.map(h => <option key={h} value={h}>{hourWord(h)} New York</option>)}
              </select></label>
          </div>
          <div className="row slack-taskcheck">
            <label>Tasks check-in <span className="sub-n">— everything open</span>
              <input type="time" value={tc.checkin ?? ''} onChange={e => setCfg(p => ({ ...p, taskCheck: { ...tc, checkin: e.target.value || null } }))} /></label>
            <label>Tasks check-out <span className="sub-n">— closed, opened, still open</span>
              <input type="time" value={tc.checkout ?? ''} onChange={e => setCfg(p => ({ ...p, taskCheck: { ...tc, checkout: e.target.value || null } }))} /></label>
            <label>Their time zone
              <select value={tc.tz} onChange={e => setCfg(p => ({ ...p, taskCheck: { ...tc, tz: e.target.value } }))}>
                <option value="America/Chicago">Central</option><option value="America/New_York">Eastern</option>
                <option value="America/Denver">Mountain</option><option value="America/Los_Angeles">Pacific</option>
              </select></label>
          </div>
          <div className="button-row">
            <button disabled={busy} onClick={() => void save()}>Save channels and reminders</button>
            {cfg.channels?.tasks && <>
              <button className="secondary" disabled={busy} onClick={() => void save().then(() => run({ action: 'taskCheckNow', kind: 'checkin' }, () => 'Check-in sent.'))}>Send check-in now</button>
              <button className="secondary" disabled={busy} onClick={() => void save().then(() => run({ action: 'taskCheckNow', kind: 'checkout' }, () => 'Check-out sent.'))}>Send check-out now</button>
            </>}
            {cfg.channels?.reservations && <button className="secondary" disabled={busy}
              onClick={() => void run({ action: 'digestNow', kind: 'morning' }, r => `Reminder sent — ${r.missing ? `${r.missing} missing` : 'nothing missing'}.`)}>Send the reminder now</button>}
          </div>
          <p className="note">The reminders go on a clock: a GitHub Action (<code>.github/workflows/slack-cron.yml</code>) calls Kaizen every hour,
            and each reminder goes once a day at its hour. It needs two repository secrets on GitHub — <code>KAIZEN_URL</code> ({origin}) and
            <code>KAIZEN_INGEST_TOKEN</code> (the ingest token, above in Settings).</p>

          <People busy={busy} run={run} onSaved={() => void load()} />
          <Cleaners cfg={cfg} busy={busy} run={run} onSaved={() => void load()} />
        </section>
      )}
      {msg && <p className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
    </div>
  );
}

/** Prepared, not wired: a channel per cleaner, and their next cleans — sent only when someone presses Send. */
function Cleaners({ cfg, busy, run, onSaved }: {
  cfg: SlackConfig; busy: boolean; onSaved: () => void;
  run: (body: Record<string, unknown>, done: (r: Awaited<ReturnType<typeof slackAction>>) => string) => Promise<Awaited<ReturnType<typeof slackAction>>>;
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ name: string; lines: string[] } | null>(null);
  useEffect(() => { void getOpsSettings().then(r => setNames(r.ok ? r.roster.filter(c => c.active).map(c => c.name) : [])).catch(() => setNames([])); }, []);
  return (
    <>
      <h3>6 · Cleaners’ channels <span className="sub-n">— prepared: nothing is sent to them on a clock</span></h3>
      <p className="note">Cleans change often and get moved by hand, so a cleaner’s channel only gets what someone sends with the button.
        Create the channel (private, <code>#cleaning-name</code>) and invite them with the email they use in Slack.</p>
      {names === null ? <p className="note loading-dot">Reading the roster</p> : (
        <ul className="slack-cleaners">
          {names.map(n => {
            const ch = cfg.cleaners?.[n];
            return (
              <li key={n}>
                <b>{n}</b>
                {ch ? <span className="sub-n">🔒 #{ch.channelName}{ch.email ? ` · ${ch.email}` : ''}</span> : (
                  <input type="email" placeholder="their Slack email" value={emails[n] ?? ''} onChange={e => setEmails(p => ({ ...p, [n]: e.target.value }))} />
                )}
                <span className="slack-cl-tools">
                  {!ch && <button className="small secondary" disabled={busy} onClick={() => void run({ action: 'cleanerChannel', name: n, email: emails[n] ?? '' }, r => `Channel #${r.channel?.channelName} ready.`).then(onSaved)}>Create channel</button>}
                  <button className="link" disabled={busy} onClick={() => void run({ action: 'cleanerPreview', name: n }, () => 'Preview below.')
                    .then(r => setPreview(r.ok && r.message ? { name: n, lines: r.message.blocks.map(b => b.text?.text ?? '').filter(Boolean) } : null))}>Preview</button>
                  {ch && <button className="link" disabled={busy} onClick={() => { if (confirm(`Send ${n} their upcoming cleans in #${ch.channelName}?`)) void run({ action: 'cleanerSend', name: n }, () => `Sent to #${ch.channelName}.`); }}>Send now</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {preview && <pre className="slack-preview">{preview.lines.join('\n\n')}</pre>}
    </>
  );
}

/**
 * People (§100): each Hostaway user (owners and supervisors of tasks) is a
 * person in Slack — the link decides who gets a task's direct message and
 * who "Take it" makes the owner. Emails differ between the two, so the
 * links are suggested (same email, else same name) and set here.
 */
function People({ busy, run, onSaved }: {
  busy: boolean; onSaved: () => void;
  run: (body: Record<string, unknown>, done: (r: Awaited<ReturnType<typeof slackAction>>) => string) => Promise<Awaited<ReturnType<typeof slackAction>>>;
}) {
  type P = { hostaway: { id: number; name: string; email: string | null }[]; slack: { id: string; name: string; email: string | null }[];
             links: Record<string, string>; suggested: Record<string, string>; dm: { mode: 'off' | 'test' | 'on'; testUser?: string | null } };
  const [p, setP] = useState<P | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'off' | 'test' | 'on'>('test');
  const read = () => void run({ action: 'people' }, () => 'People read.').then(r => {
    const x = r as unknown as P & { ok: boolean };
    if (!x.ok) return;
    setP(x); setMode(x.dm?.mode ?? 'test');
    // Saved links win; suggestions fill the rest.
    setLinks({ ...x.suggested, ...x.links });
  });
  const save = () => void run({ action: 'save', config: { people: links, dm: { mode } } }, () => 'People and direct messages saved.').then(onSaved);
  return (
    <>
      <h3>5 · People and direct messages</h3>
      <p className="note">A task’s owner hears it directly in Slack — when it is given to them, and each morning if it is overdue — and
        <b> 🙋 Take it</b> makes whoever presses it the owner. For that, each Hostaway user is linked to their Slack account here.</p>
      {!p ? <button className="secondary small" disabled={busy} onClick={read}>Read the people</button> : (
        <>
          <ul className="slack-cleaners">
            {p.hostaway.map(h => (
              <li key={h.id}>
                <b>{h.name}</b><span className="sub-n">{h.email}</span>
                <select value={links[String(h.id)] ?? ''} onChange={e => setLinks(l => { const n = { ...l }; if (e.target.value) n[String(h.id)] = e.target.value; else delete n[String(h.id)]; return n; })}>
                  <option value="">Not in Slack</option>
                  {p.slack.map(u => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ''}</option>)}
                </select>
                {!p.links[String(h.id)] && p.suggested[String(h.id)] && links[String(h.id)] === p.suggested[String(h.id)] && <span className="sub-n">suggested</span>}
              </li>
            ))}
          </ul>
          <div className="slack-dm" role="radiogroup" aria-label="Direct messages">
            {([['test', 'Test — every direct message comes to me, saying whom it was for'], ['on', 'On — to the people linked above'], ['off', 'Off']] as const).map(([k, l]) => (
              <label key={k} className="check"><input type="radio" name="dm" checked={mode === k} onChange={() => setMode(k)} /> {l}</label>
            ))}
          </div>
          <div className="button-row"><button disabled={busy} onClick={save}>Save people</button></div>
        </>
      )}
    </>
  );
}
