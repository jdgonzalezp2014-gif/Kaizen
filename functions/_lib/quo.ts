/**
 * Sending through QUO (formerly OpenPhone).
 *
 * STAGED BY DEFAULT. With `live` false the entire path runs — recipients
 * resolved, message sanitised, segments counted, row written — and the
 * request is simply not made. That is the only way to find out a message
 * is malformed, a number unparseable or a body three segments long
 * without someone's phone proving it.
 *
 * Flipping `quo_live` is a decision, made once, after reading what the
 * staged rows say.
 */
import { sanitize, segments, toE164 } from '../../src/lib/sms.ts';
import type { ThreadMsg } from '../../src/lib/inbox.ts';

export interface QuoConfig {
  apiKey: string | null;
  from: string | null;
  recipients: string[];
  live: boolean;
}

export interface SendResult {
  outcome: 'staged' | 'sent' | 'failed';
  body: string;
  segments: number;
  recipients: string[];
  detail: string;
}

const ENDPOINT = 'https://api.openphone.com/v1/messages';

export async function sendSms(cfg: QuoConfig, rawBody: string): Promise<SendResult> {
  const body = sanitize(rawBody);
  const seg = segments(body);

  // Numbers are normalised before anything is decided, so a bad one is
  // reported rather than silently dropped at the far end.
  const good: string[] = [];
  const bad: string[] = [];
  for (const r of cfg.recipients) {
    const e = toE164(r);
    if (e) good.push(e); else bad.push(r);
  }
  const note = bad.length ? ` Unusable number(s): ${bad.join(', ')}.` : '';

  if (!cfg.live) {
    return {
      outcome: 'staged', body, segments: seg.count, recipients: good,
      detail: `Staged, not sent. ${seg.count} segment(s), ${seg.encoding}.${note}`
    };
  }
  if (!cfg.apiKey || !cfg.from) {
    return { outcome: 'failed', body, segments: seg.count, recipients: good,
      detail: 'QUO is marked live but has no API key or sending number.' };
  }
  if (!good.length) {
    return { outcome: 'failed', body, segments: seg.count, recipients: [],
      detail: `No usable recipient.${note}` };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: good, content: body })
    });
    if (!res.ok) {
      return { outcome: 'failed', body, segments: seg.count, recipients: good,
        detail: `QUO returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { outcome: 'sent', body, segments: seg.count, recipients: good,
      detail: `Sent, ${seg.count} segment(s).${note}` };
  } catch (e) {
    return { outcome: 'failed', body, segments: seg.count, recipients: good,
      detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A guest's SMS thread (Guest Services → Inbox → SMS, 2026-11-16). Quo lists messages per line and per other party:
 * GET /v1/messages?phoneNumberId=PN…&participants=+1…&maxResults=… — so the account's sending number is first turned
 * into its id (GET /v1/phone-numbers). Written from Quo's reference; not exercised yet — the account has no Quo key.
 */
const HOST = 'https://api.openphone.com/v1';

async function numberId(apiKey: string, from: string): Promise<string | null> {
  if (/^PN\w+$/.test(from)) return from;
  const res = await fetch(`${HOST}/phone-numbers`, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`QUO returned ${res.status}`);
  const j = await res.json() as { data?: { id?: string; number?: string }[] };
  const want = toE164(from);
  return j.data?.find(n => n.number === want)?.id ?? null;
}

export async function quoThread(cfg: Pick<QuoConfig, 'apiKey' | 'from'>, guestPhone: string): Promise<ThreadMsg[]> {
  const to = toE164(guestPhone);
  if (!cfg.apiKey || !cfg.from) throw new Error('Quo is not connected.');
  if (!to) throw new Error('The guest has no usable phone number.');
  const pn = await numberId(cfg.apiKey, cfg.from);
  if (!pn) throw new Error('The sending number in Settings is not one of this Quo account\'s numbers.');
  const q = new URLSearchParams({ phoneNumberId: pn, participants: to, maxResults: '50' });
  const res = await fetch(`${HOST}/messages?${q}`, { headers: { Authorization: cfg.apiKey }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`QUO returned ${res.status}`);
  const j = await res.json() as { data?: { id?: string; text?: string; direction?: string; status?: string; createdAt?: string }[] };
  return (j.data ?? []).filter(m => m.text && m.createdAt).map((m): ThreadMsg => ({
    id: `q${m.id ?? m.createdAt}`, at: new Date(m.createdAt!).toISOString(), incoming: m.direction === 'incoming', body: m.text!, channel: 'sms',
    status: m.direction === 'incoming' ? 'received' : m.status === 'undelivered' ? 'failed' : 'sent', via: 'sms',
  })).sort((a, b) => a.at < b.at ? -1 : 1);
}
