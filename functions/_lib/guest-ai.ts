/**
 * The guest AI (Guest Services → Inbox, owner 2026-11-16): a draft reply for the conversation on screen, written from
 * the listing's Repository record (as the guest portal shows it), the published SOPs that match, and the thread.
 * It only drafts — a person reads it and sends. Answering on its own is not built.
 *
 * Unlike ai-chain.ts (whoever answers first), this asks exactly the provider and model the account chose in
 * Settings → Integrations → Guest messages & AI: a guest-facing voice should not change model from one reply to the next.
 * The key is the account's own (the same Claude / Gemini key the rest of Kaizen uses).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SqlFn } from './accounts.ts';
import { askGemini, firstJson } from './ai-chain.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';
import { guestHouse } from '../api/guest-guide.ts';
import { aiPrompt, guestAiFrom, guideFacts, question, suggestionFromAi, type GuestAi, type Stay, type Suggestion, type ThreadMsg } from '../../src/lib/inbox.ts';
import { rankSops, type SopDoc } from '../../src/lib/slack-sops.ts';

const MS = 30000;

/** The account's settings — the defaults (off) while migration 116 has not run. */
export async function readGuestAi(sql: SqlFn): Promise<GuestAi> {
  const rows = await (sql`SELECT guest_ai FROM accounts WHERE id = 1` as Promise<{ guest_ai: unknown }[]>).catch(() => []);
  return guestAiFrom(rows[0]?.guest_ai);
}

/** Opus 5.5, Sonnet 5.5 and Fable can hand a declined request to another model inside the same call; Haiku cannot. */
const hasFallback = (model: string) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);

async function askClaude(key: string, model: string, system: string, user: string): Promise<{ json?: Record<string, unknown>; error?: string; by?: string }> {
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: MS });
    const r = await client.beta.messages.create({
      model, max_tokens: 4096, system,
      // A short draft with a person waiting: low effort; thinking stays adaptive (the default).
      output_config: { effort: 'low' },
      ...(hasFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as never } : {}),
      messages: [{ role: 'user', content: `${user}\n\nAnswer with the JSON only.` }],
    });
    if (r.stop_reason === 'refusal') return { error: `${model} declined to draft this one` };
    const json = firstJson(r.content.map(b => b.type === 'text' ? b.text : '').join(''));
    return json ? { json, by: r.model } : { error: `${model}: no JSON in the answer` };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: 'Claude refused the API key — check it in Settings → Integrations → AI.' };
    if (e instanceof Anthropic.NotFoundError) return { error: `Claude does not know the model "${model}" — check it in Settings → Integrations.` };
    if (e instanceof Anthropic.RateLimitError) return { error: `${model} is busy (429) — try again in a moment.` };
    if (e instanceof Anthropic.APIError) return { error: `${model}: ${e.status ?? ''} ${e.message.slice(0, 140)}` };
    return { error: `${model}: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}` };
  }
}

export async function suggestReply(sql: SqlFn, env: Env, stay: Stay, thread: ThreadMsg[], today: string):
  Promise<{ ok: true; suggestion: Suggestion; by: string; sops: string[] } | { ok: false; error: string }> {
  const cfg = await readGuestAi(sql);
  if (cfg.mode === 'off') return { ok: false, error: 'AI suggestions are off — turn them on in Settings → Integrations → Guest messages & AI.' };
  if (!thread.some(m => m.incoming)) return { ok: false, error: 'The guest has not written yet — there is nothing to answer.' };
  const [a] = await sql`SELECT name, gemini_api_key_enc, claude_api_key_enc FROM accounts WHERE id = 1` as
    { name: string; gemini_api_key_enc: string | null; claude_api_key_enc: string | null }[];
  const enc = cfg.provider === 'claude' ? a?.claude_api_key_enc : a?.gemini_api_key_enc;
  const key = enc ? await decrypt(enc, env.ENCRYPTION_KEY).catch(() => null) : null;
  if (!key) return { ok: false, error: `No ${cfg.provider === 'claude' ? 'Claude' : 'Gemini'} key yet — add it in Settings → Integrations → AI.` };

  const [house, docs] = await Promise.all([
    // No Hostaway key passed: the facts need the record and the builder, not the cover photo or the calendar.
    stay.listingId ? guestHouse(sql, stay.listingId).catch(() => null) : null,
    sql`SELECT o.id::text, o.title, o.purpose, o.trigger, o.steps, o.body, o.keywords, s.label AS section FROM sops o
          LEFT JOIN sop_sections s ON s.account_id = o.account_id AND s.key = o.section_key
         WHERE o.account_id = 1 AND o.deleted_at IS NULL AND o.status = 'published'`.catch(() => []) as Promise<SopDoc[]>,
  ]);
  const facts = guideFacts(house?.guide ?? null, { unitName: house?.unitName ?? stay.listing, notOffered: house?.notOffered, prices: house?.prices });
  const sops = rankSops(question(thread), docs, 5);
  const { system, user } = aiPrompt({ stay, today, facts, sops, thread, instructions: cfg.instructions, company: a?.name ?? 'the host' });
  const r = cfg.provider === 'claude' ? await askClaude(key, cfg.model, system, user)
    : await askGemini(key, cfg.model, system, user, [], MS).then(x => ({ ...x, by: cfg.model }));
  if (!r.json) return { ok: false, error: r.error ?? 'The model did not answer.' };
  const suggestion = suggestionFromAi(r.json);
  if (!suggestion) return { ok: false, error: 'The model answered without a reply.' };
  return { ok: true, suggestion, by: r.by ?? cfg.model, sops: sops.map(s => s.title) };
}
