/**
 * Settings → Slack (§99): the app, the connection, which channel hears
 * what, when the reservations reminder goes — and the cleaners' channels,
 * prepared but sent only by hand (cleans change, and are moved by hand).
 */
import { useEffect, useState } from 'react';
import { getOpsSettings, getSlack, slackAction, type SlackState } from '../api.ts';
import { DEFAULT_DIGEST, DEFAULT_EVENTS, TOPICS, type SlackConfig, type Topic } from '../lib/slack.ts';

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
      slash_commands: [{ command: '/kaizen', url: `${origin}/api/slack`, description: 'Tasks, claims and today’s check-ins',
                         usage_hint: 'tasks · task Fix the AC · repair … · claims · claim … · today', should_escape: false }]
    },
    oauth_config: { scopes: { bot: ['chat:write', 'chat:write.public', 'commands', 'channels:read', 'groups:read', 'channels:manage',
                                    'groups:write', 'users:read', 'users:read.email'] } },
    settings: { interactivity: { is_enabled: true, request_url: `${origin}/api/slack` }, org_deploy_enabled: false,
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
          <div className="button-row">
            <button disabled={busy} onClick={() => void save()}>Save channels and reminders</button>
            {cfg.channels?.reservations && <button className="secondary" disabled={busy}
              onClick={() => void run({ action: 'digestNow', kind: 'morning' }, r => `Reminder sent — ${r.missing ? `${r.missing} missing` : 'nothing missing'}.`)}>Send the reminder now</button>}
          </div>
          <p className="note">The reminders go on a clock: a GitHub Action (<code>.github/workflows/slack-cron.yml</code>) calls Kaizen every hour,
            and each reminder goes once a day at its hour. It needs two repository secrets on GitHub — <code>KAIZEN_URL</code> ({origin}) and
            <code>KAIZEN_INGEST_TOKEN</code> (the ingest token, above in Settings).</p>

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
      <h3>5 · Cleaners’ channels <span className="sub-n">— prepared: nothing is sent to them on a clock</span></h3>
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
