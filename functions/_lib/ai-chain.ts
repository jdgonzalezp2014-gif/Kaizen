/**
 * A JSON answer from a model, never failing on one provider (owner, 2026-10-14): Gemini's
 * free tier answers 503/429 when Google is busy, so the next one is asked at once — no retry.
 * Two tiers (owner, 2026-10-15 — "no unbounded waits"):
 *   chat  — a person is waiting in Slack: flash-lite, then Workers AI, then Claude Haiku — 15 s in all.
 *   heavy — work lite does badly (a receipt, a cart, an SOP from a thread): the configured Gemini
 *           model, then flash-lite, then Workers AI, then Claude Sonnet.
 * Every attempt has its own time limit and the whole chain a budget: a hung provider used to
 * keep "Looking in the SOPs…" up until Cloudflare killed the run (2026-10-15, 57 s).
 * Claude is the last resort and only with a key in Settings (prepaid credits = a hard cap;
 * max_tokens caps each call). Only called when a person asks: nothing reads every message.
 * Who answered is kept in accounts.ai_last, for Settings.
 * With `files` (a receipt's photo or PDF) Workers AI is skipped — its text model cannot see them.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const LITE = 'gemini-3.5-flash-lite';
const WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export type AiTier = 'chat' | 'heavy';
/** Each step's own limit; the chain stops at `budgetMs` (a Slack waitUntil has 30 s in all). */
const STEP_MS: Record<AiTier, { gemini: number; lite: number; workers: number; claude: number }> = {
  chat: { gemini: 4000, lite: 4000, workers: 5000, claude: 6000 },
  heavy: { gemini: 10000, lite: 10000, workers: 10000, claude: 20000 }
};
const CLAUDE: Record<AiTier, string> = { chat: 'claude-haiku-5-5', heavy: 'claude-sonnet-5-5' };

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

async function workers(env: Env, system: string, user: string, ms: number): Promise<{ json?: Record<string, unknown>; error?: string }> {
  if (!env.AI) return { error: 'Workers AI not bound' };
  try {
    const out = await within(ms, env.AI.run(WORKERS_MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                                                            max_tokens: 2048, temperature: 0.2 })) as { response?: unknown };
    const r = out?.response;
    const json = r && typeof r === 'object' ? r as Record<string, unknown> : firstJson(String(r ?? ''));
    return json ? { json } : { error: 'Workers AI: no JSON in the answer' };
  } catch (e) { return { error: `Workers AI: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }; }
}

async function claude(key: string, tier: AiTier, system: string, user: string, files: AiFile[], ms: number): Promise<{ json?: Record<string, unknown>; error?: string }> {
  const model = CLAUDE[tier];
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: ms });
    const r = await client.messages.create({
      model, max_tokens: 4096, system,
      // Low effort for a person waiting; thinking still counts toward max_tokens, which caps the call's cost.
      output_config: { effort: tier === 'chat' ? 'low' : 'medium' },
      messages: [{ role: 'user', content: [
        ...files.map(f => f.mimeType === 'application/pdf'
          ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: f.data } }
          : { type: 'image' as const, source: { type: 'base64' as const, media_type: f.mimeType as 'image/jpeg', data: f.data } }),
        { type: 'text' as const, text: `${user}\n\nAnswer with the JSON only.` }] }]
    });
    if (r.stop_reason === 'refusal') return { error: `${model}: declined` };
    const json = firstJson(r.content.map(b => b.type === 'text' ? b.text : '').join(''));
    return json ? { json } : { error: `${model}: no JSON in the answer` };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { error: `${model} busy (429)` };
    if (e instanceof Anthropic.APIError) return { error: `${model}: ${e.status ?? ''} ${e.message.slice(0, 100)}` };
    return { error: `${model}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}` };
  }
}

export async function askJson(sql: SqlFn, env: Env, system: string, user: string, files: AiFile[] = [],
                              opts: { tier?: AiTier; budgetMs?: number } = {}): Promise<AiAnswer | AiFailure> {
  const tier = opts.tier ?? 'heavy';
  const until = Date.now() + (opts.budgetMs ?? (tier === 'chat' ? 15000 : 45000));
  const [a] = await sql`SELECT gemini_api_key_enc, gemini_model, claude_api_key_enc FROM accounts WHERE id = 1` as
    { gemini_api_key_enc: string | null; gemini_model: string | null; claude_api_key_enc: string | null }[];
  const key = a?.gemini_api_key_enc ? await decrypt(a.gemini_api_key_enc, env.ENCRYPTION_KEY).catch(() => null) : null;
  const claudeKey = a?.claude_api_key_enc ? await decrypt(a.claude_api_key_enc, env.ENCRYPTION_KEY).catch(() => null) : null;
  const errors: string[] = [];
  const done = async (by: string, json: Record<string, unknown>): Promise<AiAnswer> => {
    await sql`UPDATE accounts SET ai_last = ${JSON.stringify({ at: new Date().toISOString(), by, errors, tier })}::jsonb WHERE id = 1`.catch(() => {});
    const why = errors.filter(e => e !== 'no Gemini key' && e !== 'Workers AI cannot read images or PDFs');
    return { ok: true, json, by: why.length ? `${by} (${why.join('; ')})` : by, switched: why.length > 0 };
  };
  const step = STEP_MS[tier];
  // What is left of the budget, never more than the step's own limit; under a second is not worth asking.
  const left = (ms: number) => Math.min(ms, until - Date.now());
  const steps: { by: string; ms: number; run: (ms: number) => Promise<{ json?: Record<string, unknown>; error?: string }> }[] = [];
  if (key) {
    const models = tier === 'chat' ? [LITE] : [...new Set([a?.gemini_model || 'gemini-3.6-flash', LITE])];
    for (const m of models) steps.push({ by: m, ms: m === LITE ? step.lite : step.gemini, run: ms => gemini(key, m, system, user, files, ms) });
  } else errors.push('no Gemini key');
  if (files.length) errors.push('Workers AI cannot read images or PDFs');
  else steps.push({ by: `Workers AI (${WORKERS_MODEL.split('/').pop()})`, ms: step.workers, run: ms => workers(env, system, user, ms) });
  if (claudeKey) steps.push({ by: CLAUDE[tier], ms: step.claude, run: ms => claude(claudeKey, tier, system, user, files, ms) });
  for (const s of steps) {
    const ms = left(s.ms);
    if (ms < 1000) { errors.push('out of time'); break; }
    const r = await s.run(ms);
    if (r.json) return done(s.by, r.json);
    errors.push(r.error ?? s.by);
  }
  await sql`UPDATE accounts SET ai_last = ${JSON.stringify({ at: new Date().toISOString(), by: null, errors, tier })}::jsonb WHERE id = 1`.catch(() => {});
  return { ok: false, error: errors.join(' · ') };
}
