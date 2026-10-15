/**
 * Reports (owner, 2026-10-15): bugs and requests about Kaizen itself — from the app's
 * "Report" button (bottom-left on a computer, the menu on a phone) and from Slack
 * (@Kaizen bug / /kaizen bug). Pure: the API, the screen, Slack and the tests share it.
 */

export type ReportKind = 'bug' | 'request';
export type ReportUrgency = 'low' | 'normal' | 'blocking';
export type ReportStatus = 'new' | 'seen' | 'doing' | 'done' | 'wontfix';

export const KIND_LABEL: Record<ReportKind, string> = { bug: 'Bug', request: 'Request' };
export const URGENCY_LABEL: Record<ReportUrgency, string> = { low: 'Low', normal: 'Normal', blocking: 'Blocks my work' };
export const REPORT_STATUS: Record<ReportStatus, string> = { new: 'New', seen: 'Seen', doing: 'In progress', done: 'Done', wontfix: "Won't do" };
export const REPORT_STATUSES = Object.keys(REPORT_STATUS) as ReportStatus[];

export interface ReportRow {
  id: string; kind: ReportKind; body: string; urgency: ReportUrgency; status: ReportStatus;
  whereFrom: string | null; device: string | null; source: 'app' | 'slack';
  reporter: string; hasPhoto: boolean; createdAt: string; updatedAt: string;
  comments?: { body: string; author: string; createdAt: string }[];
}

export interface NewReport { kind: ReportKind; body: string; urgency: ReportUrgency; whereFrom?: string | null; device?: string | null }

/** What a report must have, or what is wrong with it. */
export function readReport(b: Record<string, unknown>): NewReport | { error: string } {
  const kind = b.kind === 'request' ? 'request' : b.kind === 'bug' ? 'bug' : null;
  if (!kind) return { error: 'Bug or request?' };
  const body = String(b.body ?? '').trim();
  if (!body) return { error: kind === 'bug' ? 'Say what went wrong.' : 'Say what you need.' };
  if (body.length > 4000) return { error: 'Too long — 4000 characters at most.' };
  const urgency = (['low', 'normal', 'blocking'] as const).find(u => u === b.urgency) ?? 'normal';
  const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return { kind, body, urgency, whereFrom: clip(b.whereFrom, 200), device: clip(b.device, 200) };
}

/** "@Kaizen bug the board is blank" → a bug; "pedir"/"request"/"feature" → a request. Null: not a report verb. */
export function reportVerb(word: string): ReportKind | null {
  const w = word.toLowerCase().replace(/:$/, '');
  if (['bug', 'error', 'fallo', 'falla', 'report', 'reporte', 'reportar'].includes(w)) return 'bug';
  if (['request', 'pedir', 'pido', 'solicitud', 'feature', 'idea'].includes(w)) return 'request';
  return null;
}

/** The first line, short — a report's name in lists and in Slack. */
export const reportTitle = (body: string) => {
  const first = body.split('\n')[0]!.trim();
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
};

/* ── Slack ── */

type Block = Record<string, unknown>;
const plain = (text: string) => ({ type: 'plain_text', text, emoji: true });
const esc = (s: string | null | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KIND_EMOJI: Record<ReportKind, string> = { bug: '🐞', request: '💡' };
const STATUS_EMOJI: Record<ReportStatus, string> = { new: '🆕', seen: '👀', doing: '🔧', done: '✅', wontfix: '✕' };

/** The card in the reports channel; its thread is the report's conversation. */
export function reportMessage(r: Pick<ReportRow, 'id' | 'kind' | 'body' | 'urgency' | 'status' | 'whereFrom' | 'device' | 'source' | 'reporter' | 'hasPhoto'>,
                              appUrl?: string, reporterSlack?: string | null): { text: string; blocks: Block[] } {
  const who = reporterSlack ? `<@${reporterSlack}>` : esc(r.reporter.split('@')[0]);
  const facts = [`${STATUS_EMOJI[r.status]} ${REPORT_STATUS[r.status]}`, r.urgency === 'blocking' ? '🔴 Blocks their work' : r.urgency === 'low' ? 'Low' : null,
    `${who}`, r.whereFrom ? `from ${esc(r.whereFrom)}` : null, r.source === 'slack' ? 'via Slack' : r.device ? esc(r.device) : null,
    r.hasPhoto ? `📷 ${appUrl ? `<${appUrl}/?report=${r.id}|photo in Kaizen>` : 'photo in Kaizen'}` : null].filter(Boolean);
  const closed = r.status === 'done' || r.status === 'wontfix';
  const btn = (text: string, status: ReportStatus, primary = false) =>
    ({ type: 'button', text: plain(text), action_id: `report_status_${status}`, value: `${r.id}:${status}`, ...(primary ? { style: 'primary' } : {}) });
  return {
    text: `${KIND_EMOJI[r.kind]} ${KIND_LABEL[r.kind]} #${r.id}: ${reportTitle(r.body)}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${KIND_EMOJI[r.kind]} *${KIND_LABEL[r.kind]} #${r.id}*\n${esc(r.body).slice(0, 2900)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: facts.join(' · ') }] },
      { type: 'actions', elements: closed ? [btn('↺ Reopen', 'seen')]
        : [...(r.status === 'new' ? [btn('👀 Seen', 'seen')] : []), ...(r.status !== 'doing' ? [btn('🔧 Working on it', 'doing')] : []),
           btn('✓ Done', 'done', true), btn("✕ Won't do", 'wontfix')] }
    ]
  };
}

/** The form, in Slack — the same fields as the app's. */
export function reportModal(prefill: { kind?: ReportKind; body?: string; whereFrom?: string }): Block {
  const opt = (value: string, text: string) => ({ value, text: plain(text) });
  const kinds = [opt('bug', '🐞 Bug — something is wrong'), opt('request', '💡 Request — something new or a change')];
  const urg = (Object.keys(URGENCY_LABEL) as ReportUrgency[]).map(u => opt(u, URGENCY_LABEL[u]));
  return {
    type: 'modal', callback_id: 'report_save', title: plain('Report / request'), submit: plain('Send'), close: plain('Cancel'),
    private_metadata: JSON.stringify({ whereFrom: prefill.whereFrom ?? null }),
    blocks: [
      { type: 'input', block_id: 'kind', label: plain('What is it?'),
        element: { type: 'radio_buttons', action_id: 'v', options: kinds, initial_option: kinds[prefill.kind === 'request' ? 1 : 0] } },
      { type: 'input', block_id: 'body', label: plain('What happened, or what do you need?'),
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 4000, ...(prefill.body ? { initial_value: prefill.body.slice(0, 4000) } : {}),
                   placeholder: plain('Where you were, what you did, what you expected') } },
      { type: 'input', block_id: 'urgency', label: plain('How urgent?'),
        element: { type: 'static_select', action_id: 'v', options: urg, initial_option: urg[1] } },
      { type: 'input', block_id: 'photo', optional: true, label: plain('Screenshot or photo'),
        element: { type: 'file_input', action_id: 'v', filetypes: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'], max_files: 1 } }
    ]
  };
}

/** What the Slack form holds. */
export function readReportModal(state: Record<string, Record<string, any>>): NewReport & { fileUrl?: string; fileType?: string } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const file = state.photo?.v?.files?.[0];
  return {
    kind: state.kind?.v?.selected_option?.value === 'request' ? 'request' : 'bug',
    body: String(state.body?.v?.value ?? '').trim(),
    urgency: (state.urgency?.v?.selected_option?.value ?? 'normal') as ReportUrgency,
    ...(file?.url_private ? { fileUrl: String(file.url_private), fileType: String(file.mimetype ?? 'image/jpeg') } : {})
  };
}

/** "@Kaizen bug …": the words ready, the form one tap away (a mention cannot open a pop-up). */
export function reportOffer(kind: ReportKind, words: string, whereFrom: string): { text: string; blocks: Block[] } {
  const value = JSON.stringify({ kind, body: words.slice(0, 1500), whereFrom });
  return {
    text: kind === 'bug' ? 'Report a bug' : 'Ask for something',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: words ? `${KIND_EMOJI[kind]} *${KIND_LABEL[kind]}:* ${esc(words).slice(0, 1500)}`
                                                            : `${KIND_EMOJI[kind]} Tap to ${kind === 'bug' ? 'report a bug' : 'ask for something'} in Kaizen.` } },
      { type: 'actions', elements: [
        { type: 'button', text: plain(words ? 'Complete the report' : 'Open the form'), action_id: 'report_form', value, ...(words ? {} : { style: 'primary' }) },
        ...(words ? [{ type: 'button', text: plain('Send as is'), action_id: 'report_send', value, style: 'primary' }] : [])] }
    ]
  };
}
