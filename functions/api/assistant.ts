/**
 * POST /api/assistant { question } — the help assistant (owner, 2026-11-17; src/lib/assistant.ts).
 * Rules first, a model only when it is needed:
 *   1. the Repository: a question that names a record is answered from it, no AI (needs permission `repository`) — unless it
 *      asks something no field is named for ("does Napa Valley have a pool table?"): then the light model reads that one
 *      record's non-secret fields and answers in a sentence, above the card (2026-11-19).
 *      Secrets are returned as { column } to reveal through /api/repository-reveal — its permission, its log.
 *   2. the SOPs (permission `sops`): ranked by words; no match = "no SOP covers this", still no AI; a match = the
 *      light chat tier answers from those few (the same prompt as @Kaizen in Slack).
 * Nothing is stored. The question is `redact`ed before it reaches a model (helpPrompt).
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { askJson } from '../_lib/ai-chain.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';
import { repoRecords } from '../_lib/assistant.ts';
import { extraWords, lookup, recordPrompt } from '../../src/lib/assistant.ts';
import { helpFromAi, helpPrompt, rankSops, type SopDoc } from '../../src/lib/slack-sops.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => null) as { question?: unknown } | null;
  const question = typeof b?.question === 'string' ? b.question.trim().slice(0, 600) : '';
  if (question.length < 2) return json({ ok: false, message: 'Ask something.' }, 400);
  const { permissions } = await accessOf(sql, who);

  try {
    if (can(permissions, 'repository')) {
      const recs = await repoRecords(sql);
      const hits = lookup(question, recs);
      if (hits.length) {
        const canReveal = can(permissions, 'repository.reveal');
        const one = hits.length === 1 && !hits[0]!.matched ? recs.find(r => r.table === hits[0]!.table && r.id === hits[0]!.id) : undefined;
        if (!one || extraWords(question, one.name).length < 2) return json({ ok: true, kind: 'records', hits, canReveal });
        const p = recordPrompt(question, one);
        const r = await askJson(sql, env, p.system, p.user, [], { task: 'assistant' });
        const answer = r.ok && typeof r.json.answer === 'string' ? r.json.answer.trim().slice(0, 800) : '';
        return json({ ok: true, kind: 'records', hits, canReveal, answer: answer || undefined, found: r.ok ? r.json.found !== false : undefined, by: r.ok ? r.by : null });
      }
    }
    if (!can(permissions, 'sops')) return json({ ok: true, kind: 'none', answer: 'Your role does not include the SOPs.' });
    const rows = await sql`SELECT o.id::text, o.title, o.purpose, o.trigger, o.steps, o.body, o.keywords, s.label AS section FROM sops o
                             LEFT JOIN sop_sections s ON s.account_id = o.account_id AND s.key = o.section_key
                            WHERE o.account_id = 1 AND o.deleted_at IS NULL AND o.status = 'published'` as SopDoc[];
    const shown = rankSops(question, rows);
    const brief = (s: SopDoc) => ({ id: s.id, title: s.title });
    if (!shown.length) return json({ ok: true, kind: 'none', answer: 'No SOP covers this yet, and no Repository record has that name.' });
    const p = helpPrompt(question, shown);
    const r = await askJson(sql, env, p.system, p.user, [], { task: 'assistant' });
    // No model answered: the closest SOPs by words, to read — better than nothing.
    if (!r.ok) return json({ ok: true, kind: 'sops', answer: 'No AI could answer just now — these SOPs look closest:', sops: shown.slice(0, 3).map(brief), by: null });
    const h = helpFromAi(r.json, shown);
    if (!h.sops.length) return json({ ok: true, kind: 'none', answer: 'No SOP says what to do about exactly this.', sops: shown.slice(0, 3).map(brief), by: r.by });
    return json({ ok: true, kind: 'sops', answer: h.answer, sops: h.sops.map(brief), missing: h.missing, by: r.by });
  } catch (e) {
    return json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 500);
  }
};
