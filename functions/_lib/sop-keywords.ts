/**
 * An SOP's search words (owner, 2026-10-14): what someone might type when looking for it — synonyms, the
 * team's shorthand, English and Spanish — so "@Kaizen help" finds "Early departure" for "guest leaving
 * early". Written by the AI chain when an SOP is saved; a failure leaves the old ones (search still has the text).
 */
import type { SqlFn } from './accounts.ts';
import type { Env } from './db.ts';
import { askJson } from './ai-chain.ts';

const SYSTEM = [
  'You write search keywords for a company SOP (short-term rentals: guests, cleaners, Hostaway, Kaizen).',
  'Answer ONLY with JSON: {"keywords": string[]}. 12 to 25 lowercase words or short phrases a team member might type to find',
  'this SOP: its topic, synonyms, the shorthand a team uses, the problem it solves, in English AND Spanish. No generic words',
  '(sop, guide, process, kaizen).'
].join('\n');

export async function writeKeywords(sql: SqlFn, env: Env, id: string): Promise<string[] | null> {
  const [s] = await sql`SELECT title, purpose, trigger, steps, body FROM sops WHERE account_id = 1 AND id::text = ${id}` as
    { title: string; purpose: string | null; trigger: string | null; steps: { text: string }[]; body: string | null }[];
  if (!s) return null;
  const user = [`Title: ${s.title}`, s.purpose ? `Purpose: ${s.purpose}` : '', s.trigger ? `When: ${s.trigger}` : '',
    s.steps.length ? `Steps: ${s.steps.map(x => x.text).join(' / ')}` : '', s.body ? s.body.slice(0, 3000) : ''].filter(Boolean).join('\n');
  const r = await askJson(sql, env, SYSTEM, user);
  if (!r.ok) return null;
  const kw = [...new Set((Array.isArray(r.json.keywords) ? r.json.keywords : []).map(k => String(k).toLowerCase().trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
  if (!kw.length) return null;
  await sql`UPDATE sops SET keywords = ${kw} WHERE account_id = 1 AND id::text = ${id}`;
  return kw;
}
