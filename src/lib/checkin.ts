/**
 * Check-in builder (guests + repository modules, 2026-11-09): a unit's arrival steps for the guest portal.
 * A step = a title, a short text, and optionally a pin the guest opens in Google Maps or Apple Maps —
 * e.g. The Links: "1. Pick up your key fob" (lockbox) → "2. Building entrance". Pure: parse, validate, links.
 */
export interface Pin { lat: number; lng: number }
/** `link`: a video or photo of the step (Drive, YouTube…), https only. */
export interface CheckinStep { title: string; text: string; pin: Pin | null; link?: string | null }
export const MAX_STEPS = 8;
export const MAX_TITLE = 80;
export const MAX_TEXT = 600;

const ok = (lat: number, lng: number): Pin | null =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
    ? { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 } : null;

/**
 * A pin from what someone pastes: "33.1507, -96.8236" (Google Maps → hold on the spot → copy the numbers),
 * or a long Google / Apple Maps link. A place link's own point (!3d…!4d…) wins over the map's centre (@…).
 * Short share links (maps.app.goo.gl) carry no numbers → null.
 */
export function parsePin(raw: string): Pin | null {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
  if (m) return ok(+m[1]!, +m[2]!);
  let u = s; try { u = decodeURIComponent(s); } catch { /* keep as is */ }
  m = u.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return ok(+m[1]!, +m[2]!);
  m = u.match(/[?&](?:q|query|destination|daddr|ll|sll|center)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return ok(+m[1]!, +m[2]!);
  m = u.match(/\/maps\/(?:search|place|dir)\/(?:[^/]*\/)?(-?\d+\.\d+)\s*,\s*\+?(-?\d+\.\d+)/);
  if (m) return ok(+m[1]!, +m[2]!);
  m = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return ok(+m[1]!, +m[2]!);
  return null;
}

export const pinText = (p: Pin) => `${p.lat}, ${p.lng}`;
export const googleDir = (p: Pin) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
export const appleDir = (p: Pin) => `https://maps.apple.com/?daddr=${p.lat},${p.lng}`;

/** What a save may store: trimmed, empty steps dropped, every limit checked. */
export function cleanSteps(raw: unknown): { ok: true; steps: CheckinStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'steps must be a list' };
  const steps: CheckinStep[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    const p = o.pin as Record<string, unknown> | null | undefined;
    const pin = p && typeof p === 'object' ? ok(Number(p.lat), Number(p.lng)) : null;
    if (p && !pin) return { ok: false, error: `Step ${i + 1}: the location is not a valid point.` };
    const link = typeof o.link === 'string' ? o.link.trim() : '';
    if (link && !/^https:\/\/\S+$/i.test(link)) return { ok: false, error: `Step ${i + 1}: the link must start with https://` };
    if (!title && !text && !pin && !link) continue;
    if (!title) return { ok: false, error: `Step ${i + 1} needs a title.` };
    if (title.length > MAX_TITLE) return { ok: false, error: `Step ${i + 1}: title over ${MAX_TITLE} characters.` };
    if (text.length > MAX_TEXT) return { ok: false, error: `Step ${i + 1}: text over ${MAX_TEXT} characters.` };
    steps.push({ title, text, pin, link: link || null });
  }
  if (steps.length > MAX_STEPS) return { ok: false, error: `At most ${MAX_STEPS} steps.` };
  return { ok: true, steps };
}

/**
 * Record values a step may quote instead of copying them (so a changed code is changed once, in the record):
 * {lockbox} = the Units record's Lockbox. Unknown or empty tokens stay visible, so a gap shows in the preview.
 */
export const TOKENS = { lockbox: 'Lockbox code' } as const;
export function fillTokens(text: string, vals: Record<string, unknown> | null | undefined): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => {
    if (!(k in TOKENS)) return all;
    const v = vals?.[k]; const t = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    return t || all;
  });
}
