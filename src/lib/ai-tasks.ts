/**
 * Which AI answers each job, in order (owner, 2026-11-23: "each task with a first AI, a second one, a different one — turn them on and
 * off, move them"). Every place Kaizen asks a model names its task; the task's chain is tried top to bottom, skipping what is off,
 * what has no key and what cannot do the job (Workers AI cannot see a photo; only Gemini can search the web for local events).
 * Nothing saved for a task = its default below, which is what the code did before this screen existed.
 */
import { isModel } from './inbox.ts';

export type AiProviderId = 'gemini' | 'workers' | 'claude';
export interface AiStep { provider: AiProviderId; model: string; on: boolean }
export type AiTaskKey = 'assistant' | 'triage' | 'orders' | 'receipts' | 'guest' | 'pricing';
export type AiTier = 'chat' | 'heavy';
export interface AiTaskDef {
  key: AiTaskKey; name: string;
  /** Where it is used — shown under the name. */
  does: string;
  /** chat: a person is waiting (short limits); heavy: harder reading, longer limits. */
  tier: AiTier;
  providers: AiProviderId[];
}

export const MAX_STEPS = 4;
export const GEMINI_DEFAULT = 'gemini-3.6-flash';
export const LITE = 'gemini-3.5-flash-lite';
export const WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const PROVIDERS: Record<AiProviderId, { name: string; models: string[]; note: string }> = {
  gemini: { name: 'Gemini (Google)', models: [GEMINI_DEFAULT, LITE], note: 'free tier: busy at times (503/429)' },
  workers: { name: 'Workers AI (Cloudflare)', models: [WORKERS_MODEL], note: 'no key, included; text only' },
  claude: { name: 'Claude (Anthropic)', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], note: 'prepaid credits' },
};

export const AI_TASKS: AiTaskDef[] = [
  { key: 'assistant', name: 'Questions to Kaizen', does: '@Kaizen in Slack, Ask Kaizen, SOP keywords', tier: 'chat', providers: ['gemini', 'workers', 'claude'] },
  { key: 'triage', name: 'Sorting guest messages', does: 'Unanswered watch: does a guest message need an answer, how urgent', tier: 'chat', providers: ['gemini', 'workers', 'claude'] },
  { key: 'orders', name: 'Reading Slack threads', does: 'Orders and carts from Slack, SOP drafts from a thread', tier: 'heavy', providers: ['gemini', 'workers', 'claude'] },
  { key: 'receipts', name: 'Receipts', does: 'Reads a receipt photo or PDF (needs a model that sees images)', tier: 'heavy', providers: ['gemini', 'claude'] },
  { key: 'guest', name: 'Guest replies', does: 'Inbox: the drafted reply to a guest', tier: 'heavy', providers: ['claude', 'gemini', 'workers'] },
  { key: 'pricing', name: 'Price suggestions & local events', does: 'Units: price advice and the events search (Gemini only — it searches the web)', tier: 'heavy', providers: ['gemini'] },
];
export const taskDef = (k: AiTaskKey) => AI_TASKS.find(t => t.key === k)!;

const on = (provider: AiProviderId, model: string): AiStep => ({ provider, model, on: true });
const CLAUDE_FOR: Record<AiTier, string> = { chat: 'claude-haiku-5-5', heavy: 'claude-sonnet-5-5' };

/** What each task did before this screen — and still does until someone saves it. */
export function defaultSteps(k: AiTaskKey, ctx: { geminiModel?: string | null; guest?: { provider: string; model: string } | null } = {}): AiStep[] {
  const g = ctx.geminiModel?.trim() || GEMINI_DEFAULT;
  const heavy = [...new Set([g, LITE])].map(m => on('gemini', m));
  switch (k) {
    case 'assistant': case 'triage': return [on('gemini', LITE), on('workers', WORKERS_MODEL), on('claude', CLAUDE_FOR.chat)];
    case 'orders': return [...heavy, on('workers', WORKERS_MODEL), on('claude', CLAUDE_FOR.heavy)].slice(0, MAX_STEPS);
    case 'receipts': return [...heavy, on('claude', CLAUDE_FOR.heavy)];
    case 'guest': {
      // The model chosen in Guest messages & AI first; the other provider behind it, so one busy API is not "no draft".
      const first = ctx.guest && (ctx.guest.provider === 'gemini' || ctx.guest.provider === 'claude') && isModel(ctx.guest.model)
        ? on(ctx.guest.provider, ctx.guest.model) : on('claude', 'claude-opus-5-5');
      return [first, first.provider === 'claude' ? on('gemini', g) : on('claude', 'claude-sonnet-5-5')];
    }
    case 'pricing': return heavy;
  }
}

/** One step from untrusted JSON, or null. */
function stepFrom(x: unknown, def: AiTaskDef): AiStep | null {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const provider = o.provider as AiProviderId;
  if (!def.providers.includes(provider)) return null;
  const model = typeof o.model === 'string' ? o.model.trim() : '';
  if (!isModel(model)) return null;
  return { provider, model, on: o.on !== false };
}

/** The saved chains, cleaned: unknown tasks and bad steps dropped, at most MAX_STEPS, duplicates once. An empty list is kept (= nothing runs). */
export function parseAiTasks(raw: unknown): Partial<Record<AiTaskKey, AiStep[]>> {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: Partial<Record<AiTaskKey, AiStep[]>> = {};
  for (const def of AI_TASKS) {
    const list = o[def.key];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    out[def.key] = list.map(s => stepFrom(s, def)).filter((s): s is AiStep => {
      if (!s || seen.has(`${s.provider}:${s.model}`)) return false;
      seen.add(`${s.provider}:${s.model}`); return true;
    }).slice(0, MAX_STEPS);
  }
  return out;
}

/** The chain a task runs now: the saved one, else its default. */
export function stepsFor(k: AiTaskKey, raw: unknown, ctx: Parameters<typeof defaultSteps>[1] = {}): AiStep[] {
  return parseAiTasks(raw)[k] ?? defaultSteps(k, ctx);
}

/** What will actually be asked, in order, and why the others are skipped — the screen shows the same reasons the run would hit. */
export function plan(steps: AiStep[], keys: { gemini: boolean; claude: boolean }, opts: { files?: boolean } = {}): { step: AiStep; skip: string | null }[] {
  return steps.map(step => ({ step, skip: !step.on ? 'off'
    : step.provider === 'gemini' && !keys.gemini ? 'no Gemini key'
    : step.provider === 'claude' && !keys.claude ? 'no Claude key'
    : step.provider === 'workers' && opts.files ? 'cannot read images or PDFs'
    : null }));
}

export const stepLabel = (s: AiStep) => s.provider === 'workers' ? `Workers AI (${s.model.split('/').pop()})` : s.model;
export const ORDINAL = ['First', 'Second', 'Third', 'Fourth'];
