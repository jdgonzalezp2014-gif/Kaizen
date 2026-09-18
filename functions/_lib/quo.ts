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
