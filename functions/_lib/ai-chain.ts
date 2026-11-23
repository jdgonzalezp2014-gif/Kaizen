/**
 * A JSON answer from a model, never failing on one provider (owner, 2026-10-14): Gemini's free tier answers 503/429 when Google
 * is busy, so the next one is asked at once — no retry. Each call names its TASK (src/lib/ai-tasks.ts) and the task's chain, set in
 * Settings → Integrations → AI → AI tasks (owner, 2026-11-23: a first AI, a second, a different one; on/off; in any order), is
 * tried top to bottom. Nothing saved = the old fixed order (chat: flash-lite → Workers AI → Haiku; heavy: the Gemini model →
 * flash-lite → Workers AI → Sonnet).
 * Every attempt has its own time limit and the whole chain a budget (owner, 2026-10-15 — "no unbounded waits"): a hung provider used
 * to keep "Looking in the SOPs…" up until Cloudflare killed the run (2026-10-15, 57 s).
 * Claude runs only with a key in Settings (prepaid credits = a hard cap; max_tokens caps each call). Only called when a person asks
 * or a guest writes: nothing reads every message twice.
 * Who answered is kept per task in accounts.ai_last, shown on each task's card.
 * With `files` (a receipt's photo or PDF) Workers AI is skipped — its text model cannot see them.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';
import { guestAiFrom } from '../../src/lib/inbox.ts';
import { plan, stepLabel, stepsFor, taskDef, type AiStep, type AiTaskKey, type AiTier } from '../../src/lib/ai-tasks.ts';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

export type { AiTier, AiTaskKey };
/** Each step's own limit by provider; the chain stops at `budgetMs` (a Slack waitUntil has 30 s in all). */
const STEP_MS: Record<AiTier, Record<'gemini' | 'lite' | 'workers' | 'claude', number>> = {
  chat: { gemini: 4000, lite: 4000, workers: 5000, claude: 6000 },
  heavy: { gemini: 10000, lite: 10000, workers: 10000, claude: 20000 }
};
/** A guest reply is long and a person waits for it in the Inbox: one slow model may take most of the time. */
const GUEST_MS = 30000;

/** `by` names who answered and, when it was not the first choice, why (owner, 2026-10-15: say when the model changed). */
export interface AiAnswer { ok: true; json: Record<string, unknown>; by: string; switched: boolean }
export interface AiFailure { ok: false; error: string }
/** A photo or PDF for the model to read, base64 (Gemini `inlineData`). */
export interface AiFile { mimeType: string; data: string }

/** Bytes → base64, in chunks (a whole receipt photo overflows String.fromCharCode's arguments). */
export function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A promise that gives up after `ms` (Workers AI's binding takes no AbortSignal). */
export function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`no answer in ${Math.round(ms / 1000)} s`)), ms))]);
}

/** The first `{…}` in a text — models wrap JSON in prose or fences now and then. */
export function firstJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(t.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

async function gemini(key: string, model: string, system: string, user: string, files: AiFile[], ms: number): Promise<{ json?: Record<string, unknown>; error?: string }> {
  const r = await fetch(`${GEMINI}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ms),
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [...files.map(f => ({ inlineData: f })), { text: user }] }],
                           generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
  }).catch((e: unknown) => e instanceof Error && e.name === 'TimeoutError' ? `no answer in ${Math.round(ms / 1000)} s` : 'no answer');
  if (typeof r === 'string') return { error: `${model}: ${r}` };
  if (r.status === 503 || r.status === 429) return { error: `${model} busy (${r.status})` };
  const j = await r.json().catch(() => ({})) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };
  if (!r.ok) return { error: `${model}: ${j.error?.message?.slice(0, 120) ?? r.status}` };
  const json = firstJson(j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '');
  return json ? { json } : { error: `${model}: no JSON in the answer` };
}

async function workers(env: Env, model: string, system: string, user: string, ms: number): Promise<{ json?: Record<string, unknown>; error?: string }> {
  if (!env.AI) return { error: 'Workers AI not bound' };
  try {
    const out = await within(ms, env.AI.run(model as never, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                                                            max_tokens: 2048, temperature: 0.2 })) as { response?: unknown };
    const r = out?.response;
    const json = r && typeof r === 'object' ? r as Record<string, unknown> : firstJson(String(r ?? ''));
    return json ? { json } : { error: 'Workers AI: no JSON in the answer' };
  } catch (e) { return { error: `Workers AI: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }; }
}

/** Opus 5.5, Sonnet 5.5 and Fable can hand a declined request to another model inside the same call; Haiku cannot. */
const hasFallback = (model: string) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);

async function claude(key: string, model: string, tier: AiTier, system: string, user: string, files: AiFile[], ms: number): Promise<{ json?: Record<string, unknown>; error?: string; by?: string }> {
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: ms });
    const r = await client.messages.create({
      model, max_tokens: 4096, system,
      // Low effort for a person waiting; thinking still counts toward max_tokens, which caps the call's cost.
      output_config: { effort: tier === 'chat' ? 'low' : 'medium' },
      ...(hasFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as never } : {}),
      messages: [{ role: 'user', content: [
        ...files.map(f => f.mimeType === 'application/pdf'
          ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: f.data } }
          : { type: 'image' as const, source: { type: 'base64' as const, media_type: f.mimeType as 'image/jpeg', data: f.data } }),
        { type: 'text' as const, text: `${user}\n\nAnswer with the JSON only.` }] }]
    });
    if (r.stop_reason === 'refusal') return { error: `${model}: declined` };
    const json = firstJson(r.content.map(b => b.type === 'text' ? b.text : '').join(''));
    return json ? { json, by: r.model } : { error: `${model}: no JSON in the answer` };
  } catch (e) {
    if (e instanceof Anthropic.NotFoundError) return { error: `Claude does not know the model "${model}" — check it in Settings → Integrations → AI` };
    if (e instanceof Anthropic.RateLimitError) return { error: `${model} busy (429)` };
    if (e instanceof Anthropic.APIError) return { error: `${model}: ${e.status ?? ''} ${e.message.slice(0, 100)}` };
    return { error: `${model}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}` };
  }
}

/** The account's keys and chains, in one query. `to_jsonb(accounts)` reads ai_tasks / ai_last even before migration 125 has run. */
async function settings(sql: SqlFn, env: Env) {
  const [a] = await sql`SELECT gemini_api_key_enc, gemini_model, claude_api_key_enc, guest_ai, to_jsonb(accounts)->'ai_tasks' AS ai_tasks
                          FROM accounts WHERE id = 1` as
    { gemini_api_key_enc: string | null; gemini_model: string | null; claude_api_key_enc: string | null; guest_ai: unknown; ai_tasks: unknown }[];
  const open = async (enc: string | null | undefined) => enc ? await decrypt(enc, env.ENCRYPTION_KEY).catch(() => null) : null;
  return { gemini: await open(a?.gemini_api_key_enc), claude: await open(a?.claude_api_key_enc), geminiModel: a?.gemini_model ?? null,
           guest: a ? guestAiFrom(a.guest_ai) : null, tasks: a?.ai_tasks ?? null };
}

/** Kept per task, for its card in Settings. The old single-answer shape (2026-10) is replaced on the first write. */
async function logLast(sql: SqlFn, task: AiTaskKey, v: Record<string, unknown>) {
  await sql`UPDATE accounts SET ai_last = (CASE WHEN jsonb_typeof(ai_last) = 'object' AND NOT ai_last ? 'at' THEN ai_last ELSE '{}'::jsonb END)
              || jsonb_build_object(${task}::text, ${JSON.stringify({ at: new Date().toISOString(), ...v })}::jsonb) WHERE id = 1`.catch(() => {});
}

export async function askJson(sql: SqlFn, env: Env, system: string, user: string, files: AiFile[] = [],
                              opts: { task: AiTaskKey; budgetMs?: number; log?: boolean }): Promise<AiAnswer | AiFailure> {
  const def = taskDef(opts.task);
  const tier = def.tier;
  const until = Date.now() + (opts.budgetMs ?? (tier === 'chat' ? 15000 : opts.task === 'guest' ? 50000 : 45000));
  const cfg = await settings(sql, env);
  const chain = plan(stepsFor(opts.task, cfg.tasks, { geminiModel: cfg.geminiModel, guest: cfg.guest }),
                     { gemini: !!cfg.gemini, claude: !!cfg.claude }, { files: files.length > 0 });
  const errors: string[] = [];
  // A step the owner turned off is not news; a missing key or a model that cannot do it is, once.
  for (const c of chain) if (c.skip && c.skip !== 'off') errors.push(`${stepLabel(c.step)}: ${c.skip}`);
  const skipped = errors.length;
  const ms = (s: AiStep) => opts.task === 'guest' ? GUEST_MS
    : STEP_MS[tier][s.provider === 'gemini' ? (/lite/.test(s.model) ? 'lite' : 'gemini') : s.provider];
  // What is left of the budget, never more than the step's own limit; under a second is not worth asking.
  const left = (n: number) => Math.min(n, until - Date.now());
  for (const { step, skip } of chain) {
    if (skip) continue;
    const t = left(ms(step));
    if (t < 1000) { errors.push('out of time'); break; }
    const r: { json?: Record<string, unknown>; error?: string; by?: string } = step.provider === 'gemini' ? await gemini(cfg.gemini!, step.model, system, user, files, t)
      : step.provider === 'claude' ? await claude(cfg.claude!, step.model, tier, system, user, files, t)
      : await workers(env, step.model, system, user, t);
    if (r.json) {
      const by = r.by || stepLabel(step);
      // `log: false` — a part of a list read in parallel: one ai_last is enough, and each write is one of a request's 50 subrequests.
      if (opts.log !== false) await logLast(sql, opts.task, { by, errors });
      const why = errors.slice(skipped);
      return { ok: true, json: r.json, by: why.length ? `${by} (${why.join('; ')})` : by, switched: why.length > 0 };
    }
    errors.push(r.error ?? stepLabel(step));
  }
  if (!chain.some(c => !c.skip)) errors.push(`no AI is on for "${def.name}" — Settings → Integrations → AI`);
  if (opts.log !== false) await logLast(sql, opts.task, { by: null, errors });
  return { ok: false, error: errors.join(' · ') };
}

/** One named Gemini model, asked directly. */
export { gemini as askGemini };
