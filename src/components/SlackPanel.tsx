/**
 * Settings → Slack (§99): the app, the connection, which channel hears
 * what, when the reservations reminder goes — and the cleaners' channels,
 * prepared but sent only by hand (cleans change, and are moved by hand).
 */
import { Hint } from './Hint.tsx';
import { useEffect, useState } from 'react';
import { getOpsSettings, getSlack, slackAction, type SlackState } from '../api.ts';
import { DEFAULT_DIGEST, DEFAULT_EVENTS, DEFAULT_TASK_CHECK, TOPICS, type SlackConfig, type Topic } from '../lib/slack.ts';
import { crewChannelsOf } from '../lib/crew-slack.ts';

const EVENT_LABEL: Record<keyof typeof DEFAULT_EVENTS, string> = {
  taskCreated: 'A task is created', taskAssigned: 'A task is assigned', taskClosed: 'A task is completed, cancelled or reopened',
  fromHostaway: 'The team changes a task in Hostaway', claimOpened: 'A claim is opened', claimChanged: 'A claim changes status',
  cleanThread: 'Cleans: one thread a day (Reservations channel) with photos before/after and ✅ done'
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
                         usage_hint: 'tasks · task Fix the AC · repair … · claims · claim … · today · sop … · sops', should_escape: false }],
      // ⚡ from anywhere, and ⋯ on any message (§100).
      shortcuts: [
        { name: 'New task', type: 'global', callback_id: 'new_task', description: 'Add a to-do in Kaizen' },
        { name: 'Report a repair', type: 'global', callback_id: 'new_repair', description: 'Add a repair in Kaizen' },
        { name: 'New claim', type: 'global', callback_id: 'new_claim', description: 'Log a guest claim in Kaizen' },
        { name: 'Create task from message', type: 'message', callback_id: 'task_from_message', description: 'Track this message as a Kaizen task' },
        // Owner, 2026-10-14: a thread where a procedure was explained becomes an SOP draft (✨ AI fills it in, a person saves).
        { name: 'Make SOP from this', type: 'message', callback_id: 'sop_from_message', description: 'Write an SOP from this thread' }
      ]
    },
    oauth_config: { scopes: { bot: ['chat:write', 'chat:write.public', 'commands', 'channels:read', 'groups:read', 'channels:manage',
                                    'groups:write', 'users:read', 'users:read.email', 'im:write',
                                    // §107: "@Kaizen …" in a thread — only the messages that name it — and the ✅ on them.
                                    'app_mentions:read', 'reactions:write',
                                    // §153: a plain reply in a task/claim's own thread, saved as a comment without the mention.
                                    'channels:history', 'groups:history',
                                    // Owner, Oct 2026: the files of a message @Kaizen makes a to-do from go onto the to-do.
                                    'files:read',
                                    // Owner, 2026-10-14: 📎 on a message saves it to Kaizen.
                                    'reactions:read'] } },
    settings: { interactivity: { is_enabled: true, request_url: `${origin}/api/slack` },
                event_subscriptions: { request_url: `${origin}/api/slack`, bot_events: ['app_mention', 'message.channels', 'message.groups', 'reaction_added'] },
                org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }
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
      <h2>Slack <Hint>Tasks, claims and the day’s reservations in Slack — and <b>/kaizen</b> to list, add, edit, complete and remove them
        from there. Whoever acts in Slack acts as the Kaizen member with the same email, with that member’s permissions.</Hint></h2>
      {st && (
        <p className={`slack-state ${connected ? 'on' : ''}`}>{connected ? `● Connected${cfg.team ? ` to ${cfg.team}` : ''}` : '○ Not connected yet'}</p>
      )}

      <section className="slack-step">
        <h3>1 · The Slack app <Hint><b>New app:</b> api.slack.com/apps → Create New App → From a manifest → your workspace → paste this →
          Create → Install to Workspace. It already points /kaizen and the buttons at this Kaizen ({origin}).<br /><br />
          <b>Already have it?</b> When the manifest changes: Slack → your app → App Manifest → paste → Save → Reinstall to Workspace.
          The token stays the same.</Hint></h3>
        <div className="button-row">
          <button className="secondary small" onClick={() => setShowManifest(!showManifest)}>{showManifest ? 'Hide' : 'Show'} the manifest</button>
          <button className="secondary small" onClick={() => void navigator.clipboard.writeText(manifest(origin)).then(() => setMsg({ ok: true, text: 'Manifest copied.' }))}>Copy the manifest</button>
        </div>
        {showManifest && <pre className="slack-manifest">{manifest(origin)}</pre>}
        {(() => {
          // The scopes this manifest asks for that the installed app does not have yet — paste it again and Reinstall.
          const want = (JSON.parse(manifest(origin)) as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot;
          const missing = st?.grantedScopes ? want.filter(x => !st.grantedScopes!.includes(x)) : [];
          return missing.length ? <p className="note warn">⚠ The installed Slack app is missing {missing.join(', ')} — so some features do not work yet.
            Copy the manifest (reload this page first), paste it in Slack → App Manifest → Save → <b>Reinstall to Workspace</b>.</p> : null;
        })()}
      </section>

      <section className="slack-step">
        <h3>2 · Connect <Hint>Slack reaches Kaizen at <code>/api/slack</code>, the clock at <code>/api/slack-cron</code>. In Cloudflare Zero Trust →
          Access → Applications those two paths have a <b>Bypass · Everyone</b> policy: Slack signs every request and Kaizen checks it; the clock carries
          the ingest token.</Hint></h3>
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
          <p className="note"><b>Add to…</b> channels <Hint>In these channels each new message gets a private, silent offer (only its author sees it)
            to add it to a task, a purchase order, a work order or a claim. Replies in its thread are not all saved: react 📎 to one to add it.
            No AI reads the messages.</Hint>{channels ? '' : ` — now: ${(cfg.addTo?.channels ?? []).map(c => `#${c.name}`).join(', ') || 'none'} (read the channels to change)`}</p>
          {channels && (
            <div className="slack-events">
              {channels.filter(c => !c.private || c.member).map(c => {
                const on = (cfg.addTo?.channels ?? []).some(x => x.id === c.id);
                return <label key={c.id} className="check"><input type="checkbox" checked={on} onChange={e => setCfg(p => {
                  const now = (p.addTo?.channels ?? []).filter(x => x.id !== c.id);
                  return { ...p, addTo: { channels: e.target.checked ? [...now, { id: c.id, name: c.name }] : now } };
                })} /> {c.private ? '🔒' : '#'}{c.name}</label>;
              })}
            </div>
          )}

          <h3>4 · What is said <Hint>A clock (the Cloudflare Worker <code>kaizen-clock</code>) calls Kaizen every 5 minutes; each message goes once a day
            at its hour, in the time zone below. A GitHub Action is the backup.</Hint></h3>
          <div className="slack-events">
            {(Object.keys(EVENT_LABEL) as (keyof typeof DEFAULT_EVENTS)[]).map(k => (
              <label key={k} className="check"><input type="checkbox" checked={ev[k]} onChange={e => setCfg(p => ({ ...p, events: { ...ev, [k]: e.target.checked } }))} /> {EVENT_LABEL[k]}</label>
            ))}
          </div>
          <div className="row">
            <label>Morning reminder <span className="sub-n">today, tomorrow, the open tasks, and what is missing</span>
              <select value={dg.morning ?? ''} onChange={e => setCfg(p => ({ ...p, digest: { ...dg, morning: e.target.value === '' ? null : Number(e.target.value) } }))}>
                <option value="">Off</option>{HOURS.map(h => <option key={h} value={h}>{hourWord(h)}</option>)}
              </select></label>
            <label>Afternoon reminder <span className="sub-n">what is still missing for tomorrow</span>
              <select value={dg.afternoon ?? ''} onChange={e => setCfg(p => ({ ...p, digest: { ...dg, afternoon: e.target.value === '' ? null : Number(e.target.value) } }))}>
                <option value="">Off</option>{HOURS.map(h => <option key={h} value={h}>{hourWord(h)}</option>)}
              </select></label>
          </div>
          <div className="row slack-taskcheck">
            <label>Tasks check-out <span className="sub-n">— closed, opened, still open</span>
              <input type="time" value={tc.checkout ?? ''} onChange={e => setCfg(p => ({ ...p, taskCheck: { ...tc, checkout: e.target.value || null } }))} /></label>
            <label>Time zone <span className="sub-n">— for all three</span>
              <select value={tc.tz} onChange={e => setCfg(p => ({ ...p, taskCheck: { ...tc, tz: e.target.value } }))}>
                <option value="America/Chicago">Central</option><option value="America/New_York">Eastern</option>
                <option value="America/Denver">Mountain</option><option value="America/Los_Angeles">Pacific</option>
              </select></label>
          </div>
          <div className="button-row">
            <button disabled={busy} onClick={() => void save()}>Save channels and reminders</button>
            {cfg.channels?.tasks && <>
              <button className="secondary" disabled={busy} onClick={() => void save().then(() => run({ action: 'taskCheckNow', kind: 'checkout' }, () => 'Check-out sent.'))}>Send check-out now</button>
            </>}
            {cfg.channels?.reservations && <button className="secondary" disabled={busy}
              onClick={() => void run({ action: 'digestNow', kind: 'morning' }, r => `Reminder sent — ${r.missing ? `${r.missing} missing` : 'nothing missing'}.`)}>Send the reminder now</button>}
          </div>


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
  const [cc, setCc] = useState(() => crewChannelsOf(cfg.crewChannels));
  useEffect(() => { void getOpsSettings().then(r => setNames(r.ok ? r.roster.filter(c => c.active).map(c => c.name) : [])).catch(() => setNames([])); }, []);
  return (
    <>
      <h3>6 · Cleaners’ channels <Hint>One private channel per cleaner (<code>#cleaning-name</code>), invited with the email they use in Slack.
        Private means only its members see it: whoever creates it joins it; anyone else of the team uses <b>👁 Add me</b>. Messages there
        are in the cleaner’s language (English or Spanish, as on their page). Times are the team’s ({cfg.taskCheck?.tz ?? DEFAULT_TASK_CHECK.tz}).</Hint></h3>
      <div className="slack-events">
        {/* One option per line (2026-10-14: side by side they squeezed into narrow columns); how each works behind its ?. */}
        <div className="crew-opt"><label className="check"><input type="checkbox" checked={cc.reminders} onChange={e => setCc(p => ({ ...p, reminders: e.target.checked }))} />
          {' '}Remind each cleaner: today’s cleans at</label> <input type="time" value={cc.morning} onChange={e => setCc(p => ({ ...p, morning: e.target.value }))} />
          <span className="crew-and">and tomorrow’s at</span> <input type="time" value={cc.evening} onChange={e => setCc(p => ({ ...p, evening: e.target.value }))} />
          <Hint>Only on days they have cleans, with the 4 steps recalled, and when the next guest checks in. Clear a time to skip that reminder.</Hint></div>
        <div className="crew-opt"><label className="check"><input type="checkbox" checked={cc.helperNotices} onChange={e => setCc(p => ({ ...p, helperNotices: e.target.checked }))} />
          {' '}Tell each cleaner, in their channel, what they and their helpers report</label>
          <Hint>Photos, what they took from storage, done, problems, needs, extras. To follow up there: the team’s reply in a request’s thread
            is a comment on its to-do; it is still managed in Kaizen.</Hint></div>
      </div>
      <div className="button-row">
        <button className="small" disabled={busy} onClick={() => void run({ action: 'save', config: { ...cfg, crewChannels: cc } }, () => 'Cleaners’ channels saved.').then(onSaved)}>
          Save</button>
        <span className="note">Off until ticked and saved. Only cleaners with a channel below get anything.</span>
      </div>
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
                  {ch && <button className="link" disabled={busy} title="The channel is private: only its members see it"
                                 onClick={() => void run({ action: 'cleanerJoin', name: n }, r => (r as { already?: boolean }).already ? `You are already in #${ch.channelName}.` : `You are in #${ch.channelName} now — it shows in Slack.`)}>👁 Add me</button>}
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
      <h3>5 · People and direct messages <Hint>A task’s owner hears it directly in Slack — when it is given to them, and each morning if it is overdue — and
        <b> 🙋 Take it</b> makes whoever presses it the owner. For that, each Hostaway user is linked to their Slack account here.</Hint></h3>
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
