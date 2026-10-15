/**
 * A JSON answer from a model, never failing on one provider (owner, 2026-10-14): Gemini's
 * free tier answers 503 when Google is busy, so the configured Gemini model, then flash-lite
 * (its own capacity), then Cloudflare Workers AI (free, no key — a binding). Each gets one
 * short retry on 503/429. Only called when a person asks (✨ Suggest): nothing reads every
 * message. Who answered is kept in accounts.ai_last, for Settings.
 * With `files` (a receipt's photo or PDF, owner 2026-10-14) only Gemini can read
 * them — Workers AI's text model cannot see images, so it is not asked.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const LITE = 'gemini-3.5-flash-lite';
const WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export interface AiAnswer { ok: true; json: Record<string, unknown>; by: string }
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

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The first `{…}` in a text — models wrap JSON in prose or fences now and then. */
export function firstJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(t.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

async function gemini(key: string, model: string, system: string, user: string, files: AiFile[] = []): Promise<{ json?: Record<string, unknown>; busy?: boolean; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${GEMINI}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [...files.map(f => ({ inlineData: f })), { text: user }] }],
                             generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
    }).catch(() => null);
    if (!r) return { error: 'no answer' };
    if (r.status === 503 || r.status === 429) { if (attempt === 0) { await wait(1000); continue; } return { busy: true, error: `${model} busy (${r.status})` }; }
    const j = await r.json().catch(() => ({})) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };
    if (!r.ok) return { error: `${model}: ${j.error?.message?.slice(0, 120) ?? r.status}` };
    const json = firstJson(j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '');
    return json ? { json } : { error: `${model}: no JSON in the answer` };
  }
  return { error: `${model}: busy` };
}

async function workers(env: Env, system: string, user: string): Promise<{ json?: Record<string, unknown>; error?: string }> {
  if (!env.AI) return { error: 'Workers AI not bound' };
  try {
    const out = await env.AI.run(WORKERS_MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                                                 max_tokens: 2048, temperature: 0.2 }) as { response?: unknown };
    const r = out?.response;
    const json = r && typeof r === 'object' ? r as Record<string, unknown> : firstJson(String(r ?? ''));
    return json ? { json } : { error: 'Workers AI: no JSON in the answer' };
  } catch (e) { return { error: `Workers AI: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }; }
}

export async function askJson(sql: SqlFn, env: Env, system: string, user: string, files: AiFile[] = []): Promise<AiAnswer | AiFailure> {
  const [a] = await sql`SELECT gemini_api_key_enc, gemini_model FROM accounts WHERE id = 1` as { gemini_api_key_enc: string | null; gemini_model: string | null }[];
  const key = a?.gemini_api_key_enc ? await decrypt(a.gemini_api_key_enc, env.ENCRYPTION_KEY).catch(() => null) : null;
  const errors: string[] = [];
  const done = async (by: string, json: Record<string, unknown>): Promise<AiAnswer> => {
    await sql`UPDATE accounts SET ai_last = ${JSON.stringify({ at: new Date().toISOString(), by, errors })}::jsonb WHERE id = 1`.catch(() => {});
    return { ok: true, json, by };
  };
  if (key) {
    for (const model of [...new Set([a?.gemini_model || 'gemini-3.6-flash', LITE])]) {
      const r = await gemini(key, model, system, user, files);
      if (r.json) return done(model, r.json);
      errors.push(r.error ?? model);
    }
  } else errors.push('no Gemini key');
  if (files.length) errors.push('Workers AI cannot read images or PDFs');
  const w = files.length ? null : await workers(env, system, user);
  if (w?.json) return done(`Workers AI (${WORKERS_MODEL.split('/').pop()})`, w.json);
  if (w) errors.push(w.error ?? 'Workers AI');
  await sql`UPDATE accounts SET ai_last = ${JSON.stringify({ at: new Date().toISOString(), by: null, errors })}::jsonb WHERE id = 1`.catch(() => {});
  return { ok: false, error: errors.join(' · ') };
}
