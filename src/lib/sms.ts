/**
 * Making a string safe and cheap to send as SMS.
 *
 * Pure, so the awkward part — what a carrier actually charges for — is
 * testable without sending anything.
 *
 * A message is billed per SEGMENT, and the segment size depends on the
 * alphabet. Stay inside GSM-7 and you get 160 characters; use one
 * character outside it and the whole message switches to UCS-2 at 70.
 * So a single curly quote in "the unit's price" turns a one-part message
 * into three. That is the entire reason this file exists.
 */

/** The GSM 03.38 basic set, plus the extension characters that cost two. */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

/**
 * Folded rather than stripped.
 *
 * Deleting an unsupported character silently changes the words: "—" and
 * "…" vanish and sentences run together. Every replacement here keeps
 * the meaning and costs one GSM character.
 */
const FOLD: [RegExp, string][] = [
  [/[‘’‛′]/g, "'"],
  [/[“”″]/g, '"'],
  [/[–—−]/g, '-'],
  [/[…]/g, '...'],
  [/[   ]/g, ' '],
  [/[•·]/g, '*'],
  [/[→]/g, '->'],
  [/[≤]/g, '<='],
  [/[≥]/g, '>='],
  [/[★☆]/g, '*'],
  [/[✓✔]/g, 'OK'],
  [/[⚠️⚠]/g, '!'],
  // Emoji are removed, not folded: there is nothing to fold them to.
  // Matched as surrogate PAIRS — a range like [ἰ0-ᾯF] is
  // parsed as ἰ followed by "0-ᾯ" and eats ordinary letters,
  // which is a bug this project has already shipped once.
  [/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''],
  [/[️‍]/g, '']
];

export function sanitize(input: string): string {
  let out = input ?? '';
  for (const [re, to] of FOLD) out = out.replace(re, to);
  // Anything still outside the alphabet becomes '?' rather than
  // disappearing: a visible substitution can be noticed and fixed.
  out = [...out].map(ch =>
    GSM_BASIC.includes(ch) || GSM_EXTENDED.includes(ch) ? ch : (/\s/.test(ch) ? ' ' : '?')
  ).join('');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

export function isGsm(text: string): boolean {
  return [...text].every(ch => GSM_BASIC.includes(ch) || GSM_EXTENDED.includes(ch));
}

/** GSM-7 extension characters occupy two positions, not one. */
export function gsmLength(text: string): number {
  return [...text].reduce((n, ch) => n + (GSM_EXTENDED.includes(ch) ? 2 : 1), 0);
}

export interface Segments { count: number; encoding: 'GSM-7' | 'UCS-2'; used: number; limit: number }

/**
 * Multi-part messages lose room to the header that stitches them back
 * together: 153 per part instead of 160, 67 instead of 70. A count that
 * ignores that is right until the message is one character over, which
 * is exactly when someone is relying on it.
 */
export function segments(text: string): Segments {
  if (isGsm(text)) {
    const used = gsmLength(text);
    const count = used <= 160 ? Math.max(1, Math.ceil(used / 160)) : Math.ceil(used / 153);
    return { count, encoding: 'GSM-7', used, limit: used <= 160 ? 160 : 153 };
  }
  // Astral characters take two UTF-16 units and so two of the 70.
  const used = text.length;
  const count = used <= 70 ? Math.max(1, Math.ceil(used / 70)) : Math.ceil(used / 67);
  return { count, encoding: 'UCS-2', used, limit: used <= 70 ? 70 : 67 };
}

/**
 * E.164, or null.
 *
 * Refusing an unparseable number is the point: a silently mangled one
 * produces a message that is never delivered and never reported as
 * undelivered.
 */
export function toE164(raw: string, defaultCountry = '1'): string | null {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) {
    const rest = digits.slice(1).replace(/\D/g, '');
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null;
  }
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return `+${defaultCountry}${d}`;
  if (d.length === 11 && d.startsWith(defaultCountry)) return `+${d}`;
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}
