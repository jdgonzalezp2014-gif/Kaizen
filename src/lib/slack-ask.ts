/**
 * "@Kaizen <anything that is not a command>" (owner, 2026-11-23): Kaizen answers it as Ask Kaizen does on the web — the
 * Repository by rules first (Wi-Fi, codes, check-in… no AI), then the SOPs (a model only when an SOP matches). Scripting decides
 * before any model is asked: a sentence that is neither a record nor a question is still offered as a to-do, with no AI.
 */
import type { RepoAnswer } from './assistant.ts';
import { esc } from './slack.ts';

type Block = Record<string, unknown>;

/** First words that make a sentence a question, English and Spanish (accents dropped). */
const ASK = new Set(['what', 'whats', 'where', 'wheres', 'how', 'when', 'who', 'which', 'why', 'is', 'are', 'does', 'do', 'did', 'can', 'could', 'should',
  'any', 'anyone', 'tell', 'show', 'give', 'find', 'info', 'que', 'cual', 'cuales', 'donde', 'como', 'cuando', 'quien', 'por', 'cuanto', 'cuantos',
  'hay', 'tiene', 'tienen', 'tenemos', 'dame', 'dime', 'muestrame', 'busca', 'buscar', 'sabe', 'saben', 'alguien', 'se', 'puedo', 'podemos', 'debo']);

const words = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9']+/g) ?? [];

/** A question by its shape alone: "?" / "¿", or a question word first. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?\s*$/.test(t) || t.startsWith('¿')) return true;
  const w = words(t)[0]?.replace(/'s$/, '') ?? '';
  return ASK.has(w);
}

/**
 * What to do with text after "@Kaizen" that is no command — decided by script, before anything is read or asked:
 *   question — shaped like one (or asked with "help"): Repository, then SOPs (+ a model only on a match)
 *   lookup   — five words or fewer ("wifi amber valley"): the Repository only, and only if a field is named; else a to-do
 *   todo     — a longer sentence that does not ask ("fix the door lock at Amber Valley"): the to-do offer, nothing read
 */
export function askKind(text: string, asked = false): 'question' | 'lookup' | 'todo' {
  if (asked || looksLikeQuestion(text)) return 'question';
  return words(text).length <= 5 ? 'lookup' : 'todo';
}

/** The records a question named, as Slack blocks. A secret is a button: its value goes privately to whoever taps, and is logged. */
export function recordBlocks(hits: RepoAnswer[], opts: { canReveal: boolean; appUrl?: string; answer?: string; by?: string | null }): Block[] {
  const out: Block[] = [];
  if (opts.answer) out.push({ type: 'section', text: { type: 'mrkdwn', text: `💬 ${esc(opts.answer)}` } });
  for (const h of hits) {
    const lines = h.fields.slice(0, 10).map(f => `• *${esc(f.label)}:* ${esc(f.value).slice(0, 300)}`);
    out.push({ type: 'section', text: { type: 'mrkdwn', text: `🗂 *${esc(h.name)}* _(${esc(h.tableTitle)})_${lines.length ? `\n${lines.join('\n')}` : ''}`.slice(0, 2900) } });
    if (h.secrets.length) {
      out.push(opts.canReveal
        ? { type: 'actions', elements: h.secrets.slice(0, 5).map(s => ({ type: 'button', action_id: `ask_reveal_${s.column}`,
            text: { type: 'plain_text', text: `🔒 Show ${s.label}`.slice(0, 75), emoji: true },
            value: JSON.stringify({ table: h.table, id: h.id, column: s.column }) })) }
        : { type: 'context', elements: [{ type: 'mrkdwn', text: `🔒 ${h.secrets.map(s => esc(s.label)).join(', ')} — your role cannot reveal passwords.` }] });
    }
  }
  const open = opts.appUrl ? ` · <${opts.appUrl}/?tab=repository|Open the Repository>` : '';
  out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `From the Repository${opts.by ? ` · answered by ${esc(opts.by)}` : ' · no AI used'}${open}` }] });
  return out;
}
