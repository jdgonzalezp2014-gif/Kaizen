/**
 * /api/ai-tasks — Settings → Integrations → AI → AI tasks (permission `settings`):
 *   GET  → each task's chain (saved or default), whether it was saved, its last answer, which keys exist
 *   POST { task, steps } saves one task's chain; { task, reset: true } puts it back to the default.
 * Keys never leave the server; only whether each one exists.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';
import { guestAiFrom } from '../../src/lib/inbox.ts';
import { AI_TASKS, parseAiTasks, stepsFor, type AiTaskKey } from '../../src/lib/ai-tasks.ts';

const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });

async function state(sql: SqlFn) {
  const [a] = await sql`SELECT gemini_api_key_enc IS NOT NULL AS gemini, claude_api_key_enc IS NOT NULL AS claude, gemini_model, guest_ai, ai_last,
                               to_jsonb(accounts) ? 'ai_tasks' AS migrated, to_jsonb(accounts)->'ai_tasks' AS ai_tasks FROM accounts WHERE id = 1` as
    { gemini: boolean; claude: boolean; gemini_model: string | null; guest_ai: unknown; ai_last: unknown; migrated: boolean; ai_tasks: unknown }[];
  const saved = parseAiTasks(a?.ai_tasks);
  const last = (a?.ai_last && typeof a.ai_last === 'object' ? a.ai_last : {}) as Record<string, unknown>;
  const ctx = { geminiModel: a?.gemini_model, guest: guestAiFrom(a?.guest_ai) };
  return {
    ok: true, migrated: a?.migrated === true, keys: { gemini: a?.gemini === true, claude: a?.claude === true },
    tasks: AI_TASKS.map(t => ({ key: t.key, steps: stepsFor(t.key, a?.ai_tasks, ctx), saved: t.key in saved, last: last[t.key] ?? null })),
  };
}

async function allowed(request: Request, env: Env, sql: SqlFn) {
  const who = identify(request, env);
  if (!who) return null;
  return can((await accessOf(sql, who)).permissions, 'settings') ? who : false;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const who = await allowed(request, env, sql);
  if (who === null) return unauthorised();
  if (!who) return bad('Only someone who can open Settings sees this.', 403);
  return Response.json(await state(sql));
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const who = await allowed(request, env, sql);
  if (who === null) return unauthorised();
  if (!who) return bad('Only someone who can open Settings changes this.', 403);
  const b = await request.json().catch(() => ({})) as { task?: string; steps?: unknown; reset?: boolean };
  const task = AI_TASKS.find(t => t.key === b.task)?.key as AiTaskKey | undefined;
  if (!task) return bad('Unknown task.');
  try {
    if (b.reset) await sql`UPDATE accounts SET ai_tasks = coalesce(ai_tasks, '{}'::jsonb) - ${task}::text WHERE id = 1`;
    else {
      if (!Array.isArray(b.steps)) return bad('steps must be a list.');
      const steps = parseAiTasks({ [task]: b.steps })[task] ?? [];
      if (steps.length !== b.steps.length) return bad('A step has a provider this task cannot use, a model id that does not look right, or is repeated.');
      await sql`UPDATE accounts SET ai_tasks = coalesce(ai_tasks, '{}'::jsonb) || jsonb_build_object(${task}::text, ${JSON.stringify(steps)}::jsonb) WHERE id = 1`;
    }
  } catch (e) {
    return /ai_tasks/.test(String(e)) ? bad('The database needs migration 125 first (npm run migrate).', 409) : bad(String(e), 500);
  }
  return Response.json(await state(sql));
};
