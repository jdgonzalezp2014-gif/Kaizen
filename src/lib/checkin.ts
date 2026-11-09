/**
 * Check-in builder (guests + repository modules, 2026-11-09): a unit's arrival steps for the guest portal.
 * A step = a title, a short text, and optionally a pin the guest opens in Google Maps or Apple Maps —
 * e.g. The Links: "1. Pick up your key fob" (lockbox) → "2. Building entrance". Pure: parse, validate, links.
 */
export interface Pin { lat: number; lng: number }
/** `link`: a video of the step (Drive, YouTube…), https only, opened in a new tab. `photos`: Drive file ids, shown inline. */
export interface CheckinStep { title: string; text: string; pin: Pin | null; link?: string | null; photos?: string[] }
/**
 * House manual / Stay blocks (2026-11-09): either the house's own text (e.g. Trash) or a block that shows a part of the
 * record (`field`), so the guide decides what the guest sees and in which order. A guide with no field blocks keeps the
 * old layout (record parts first, then the items).
 */
export const FIELDS = { wifi: 'Wi-Fi', times: 'Check-in / out times', parking: 'Parking', access: 'What you can use', rules: 'House rules', contact: 'Full guide & phone' } as const;
export type FieldKey = keyof typeof FIELDS;
export const DEFAULT_FIELDS: FieldKey[] = ['wifi', 'times', 'parking'];
export const DEFAULT_FIELDS_AFTER: FieldKey[] = ['access', 'rules', 'contact'];
export interface HouseItem { title: string; text: string; field?: FieldKey }
export const MAX_PHOTOS = 3;
export const MAX_HOUSE = 10;
export const MAX_HOUSE_TEXT = 1200;
export const isPhotoId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{10,200}$/.test(v);
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
    const photos = Array.isArray(o.photos) ? o.photos : [];
    if (!photos.every(isPhotoId)) return { ok: false, error: `Step ${i + 1}: a photo is not valid.` };
    if (photos.length > MAX_PHOTOS) return { ok: false, error: `Step ${i + 1}: at most ${MAX_PHOTOS} photos.` };
    if (!title && !text && !pin && !link && !photos.length) continue;
    if (!title) return { ok: false, error: `Step ${i + 1} needs a title.` };
    if (title.length > MAX_TITLE) return { ok: false, error: `Step ${i + 1}: title over ${MAX_TITLE} characters.` };
    if (text.length > MAX_TEXT) return { ok: false, error: `Step ${i + 1}: text over ${MAX_TEXT} characters.` };
    steps.push({ title, text, pin, link: link || null, photos: [...new Set(photos as string[])] });
  }
  if (steps.length > MAX_STEPS) return { ok: false, error: `At most ${MAX_STEPS} steps.` };
  return { ok: true, steps };
}

/**
 * Record values a step may quote instead of copying them (so a changed code is changed once, in the record):
 * {lockbox} = the Units record's Lockbox, {unit} = the unit's number (P2-1304 → 1304), {floor} = its Floor ("third").
 * Shared guides (2026-11-09) lean on these: one text, every unit of the building. Unknown or empty tokens stay visible.
 */
export const TOKENS = { unit: 'Unit number', floor: 'Floor', lockbox: 'Lockbox code', address: 'Address', checkin: 'Check-in time' } as const;
export const unitNumber = (name: string) => (name.match(/(\d{3,})\D*$/)?.[1] ?? name).trim();
export function tokenVals(vals: Record<string, unknown> | null | undefined, unitName: string): Record<string, unknown> {
  const floor = typeof vals?.floor === 'string' ? vals.floor.trim().toLowerCase() : '';
  return { ...(vals ?? {}), unit: unitNumber(unitName), floor, address: vals?.hw_address ?? null, checkin: vals?.checkin_from ?? null };
}
export function fillTokens(text: string, vals: Record<string, unknown> | null | undefined): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => {
    if (!(k in TOKENS)) return all;
    const v = vals?.[k]; const t = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    return t || all;
  });
}

/** Shared guides: `shared:<slug>` rows. */
export const SHARED = 'shared:';
export const isShared = (id: string) => id.startsWith(SHARED);
export const sharedId = (title: string) => SHARED + title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** What the guest gets: the shared guide's steps and items first, then the unit's own; tokens filled per unit. */
export function composeGuide(shared: { steps: CheckinStep[]; house: HouseItem[] } | null, own: { steps: CheckinStep[]; house: HouseItem[] } | null,
                             vals: Record<string, unknown>): { steps: CheckinStep[]; house: HouseItem[] } {
  const steps = [...(shared?.steps ?? []), ...(own?.steps ?? [])].map(st => ({ ...st, title: fillTokens(st.title, vals), text: fillTokens(st.text, vals) }));
  const house = [...(shared?.house ?? []), ...(own?.house ?? [])].map(h => h.field ? h : { title: fillTokens(h.title, vals), text: fillTokens(h.text, vals) });
  return { steps, house };
}

export function cleanHouse(raw: unknown): { ok: true; house: HouseItem[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, house: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'house manual must be a list' };
  const house: HouseItem[] = [];
  for (const [i, r] of raw.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (o.field !== undefined && o.field !== null) {
      if (typeof o.field !== 'string' || !(o.field in FIELDS)) return { ok: false, error: `House manual item ${i + 1}: unknown record block.` };
      if (house.some(h => h.field === o.field)) continue;
      house.push({ title: '', text: '', field: o.field as FieldKey }); continue;
    }
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!title && !text) continue;
    if (!title) return { ok: false, error: `House manual item ${i + 1} needs a title.` };
    if (title.length > MAX_TITLE) return { ok: false, error: `House manual item ${i + 1}: title over ${MAX_TITLE} characters.` };
    if (text.length > MAX_HOUSE_TEXT) return { ok: false, error: `House manual item ${i + 1}: text over ${MAX_HOUSE_TEXT} characters.` };
    house.push({ title, text });
  }
  if (house.length > MAX_HOUSE + Object.keys(FIELDS).length) return { ok: false, error: `At most ${MAX_HOUSE} house manual items.` };
  return { ok: true, house };
}
