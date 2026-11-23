/**
 * Settings → Integrations → AI → AI tasks (owner, 2026-11-23): for each job Kaizen gives an AI, the models it asks in order —
 * a first one, a second, a different one — each turned on or off and moved up or down. The run follows exactly this list
 * (functions/_lib/ai-chain.ts); a task never saved shows, and uses, its default.
 */
import { useEffect, useState } from 'react';
import { getAiTasks, saveAiTask, type AiTaskState, type AiTasksResult } from '../api.ts';
import { MAX_STEPS, ORDINAL, PROVIDERS, plan, stepLabel, taskDef, type AiProviderId, type AiStep } from '../lib/ai-tasks.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';

type Ok = Extract<AiTasksResult, { ok: true }>;

export function AiTasksPanel() {
  const [s, setS] = useState<Ok | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { void getAiTasks().then(r => r.ok ? setS(r) : setMsg(r.message ?? 'Could not load.')).catch(e => setMsg(String(e))); }, []);
  if (!s) return <div className="card"><p className="note">{msg || 'Loading…'}</p></div>;
  return (
    <div className="card">
      <h2>AI tasks <Hint>Each job Kaizen gives an AI asks the models below from the top: the first one answers; if it is busy, fails or runs
        out of time, the next one is asked at once — no retry, no waiting. Turn a model off to skip it, move it to change the order, add a
        different one behind it. Gemini needs its key, Claude its key (prepaid credits are the most it can spend); Workers AI needs none but
        reads text only. Quick jobs (a person waiting in Slack) give each model a few seconds; the others longer. "Default" is what Kaizen
        did before this list — saving makes it yours, "Back to default" undoes it.</Hint></h2>
      {!s.migrated && <p className="banner warn">The database needs migration 125 before a change can be saved (npm run migrate). Until then every task uses its default.</p>}
      <div className="ait-list">
        {s.tasks.map(t => <TaskCard key={t.key} t={t} keys={s.keys} disabled={!s.migrated} onSaved={setS} />)}
      </div>
    </div>
  );
}

function TaskCard({ t, keys, disabled, onSaved }: { t: AiTaskState; keys: Ok['keys']; disabled: boolean; onSaved: (s: Ok) => void }) {
  const def = taskDef(t.key);
  const [steps, setSteps] = useState<AiStep[]>(t.steps);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => setSteps(t.steps), [t.steps]);
  const dirty = JSON.stringify(steps) !== JSON.stringify(t.steps);
  const rows = plan(steps, keys, { files: t.key === 'receipts' });
  const runs = rows.filter(r => !r.skip);
  const set = (i: number, p: Partial<AiStep>) => setSteps(steps.map((x, j) => j === i ? { ...x, ...p } : x));
  const move = (i: number, d: -1 | 1) => { const n = [...steps]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; setSteps(n); };
  const add = () => {
    // A provider not in the list yet, else another model of the first one.
    const p = def.providers.find(x => !steps.some(s => s.provider === x)) ?? def.providers[0]!;
    const m = PROVIDERS[p].models.find(x => !steps.some(s => s.provider === p && s.model === x)) ?? PROVIDERS[p].models[0]!;
    setSteps([...steps, { provider: p, model: m, on: true }]);
  };
  const send = async (body: { steps?: AiStep[]; reset?: boolean }) => {
    setBusy(true); setMsg('');
    const r = await saveAiTask({ task: t.key, ...body }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) { onSaved(r); setMsg(body.reset ? 'Back to default.' : 'Saved.'); } else setMsg(r.message ?? 'Not saved.');
  };
  const dup = new Set<string>();
  const repeated = steps.some(s => { const k = `${s.provider}:${s.model.trim()}`; if (dup.has(k)) return true; dup.add(k); return false; });

  return (
    <details className="ait-task">
      <summary>
        <span className="ait-head"><b>{def.name}</b> {t.saved ? <span className="ok-tag">Custom</span> : <span className="note">· Default</span>}
          <span className="note">{def.does}</span></span>
        <span className="ait-chain">{runs.length
          ? runs.map(r => stepLabel(r.step)).join(' → ')
          : <span className="warn"><Icon n="alert" /> No AI will answer</span>}</span>
      </summary>
      <ol className="ait-steps">
        {steps.map((st, i) => {
          const skip = rows[i]!.skip;
          return <li key={i} className={st.on ? '' : 'off'}>
            <span className="ait-ord">{ORDINAL[i]}</span>
            <label className="check inline"><input type="checkbox" checked={st.on} onChange={e => set(i, { on: e.target.checked })} /> {st.on ? 'On' : 'Off'}</label>
            <select value={st.provider} aria-label="Provider"
                    onChange={e => { const p = e.target.value as AiProviderId; set(i, { provider: p, model: PROVIDERS[p].models[0]! }); }}>
              {def.providers.map(p => <option key={p} value={p}>{PROVIDERS[p].name}</option>)}
            </select>
            <input value={st.model} list={`ait-${t.key}-${st.provider}`} spellCheck={false} aria-label="Model" onChange={e => set(i, { model: e.target.value })} />
            <datalist id={`ait-${t.key}-${st.provider}`}>{PROVIDERS[st.provider].models.map(m => <option key={m} value={m} />)}</datalist>
            <span className="ait-tools">
              <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button type="button" className="link" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
              <button type="button" className="link" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove"><Icon n="trash" /></button>
            </span>
            {skip && skip !== 'off' && <span className="note warn ait-skip"><Icon n="alert" /> Skipped: {skip}</span>}
          </li>;
        })}
      </ol>
      {repeated && <p className="note warn"><Icon n="alert" /> The same model is listed twice — keep it once.</p>}
      {t.last && <p className="note">Last answer {new Date(t.last.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}:{' '}
        {t.last.by ? <><Icon n="check" /> {t.last.by}</> : <><Icon n="alert" /> none answered</>}
        {t.last.errors.length > 0 && <Hint>{t.last.errors.join(' · ')}</Hint>}</p>}
      <div className="button-row">
        {steps.length < MAX_STEPS && <button type="button" className="secondary small" onClick={add}>+ Add another AI</button>}
        <button type="button" className="small" disabled={busy || disabled || !dirty || repeated} onClick={() => void send({ steps })}>{busy ? 'Saving…' : 'Save'}</button>
        {dirty && <button type="button" className="secondary small" onClick={() => setSteps(t.steps)}>Undo changes</button>}
        {t.saved && !dirty && <button type="button" className="secondary small" disabled={busy || disabled} onClick={() => void send({ reset: true })}><Icon n="undo" /> Back to default</button>}
      </div>
      {msg && <p className="note">{msg}</p>}
    </details>
  );
}
