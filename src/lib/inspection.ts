/**
 * Inspections as a checklist (§133) — pure: the areas a unit has, the
 * checklist they expand to, how far an inspection got, what its findings
 * become, and the overall result.
 *
 * The rooms come from the unit: one section per bedroom and per bathroom
 * (a half bath counts as one), plus the single areas. The items come from
 * the template edited in Setup — for every unit, or for one unit only.
 */

export type Area = 'general' | 'living' | 'kitchen' | 'bedroom' | 'bathroom' | 'exterior';
export type CheckResult = 'ok' | 'attention' | 'na';
/** What a finding becomes. `clean_next`: a task for the unit's next clean; `clean_new`: a new clean. */
export type Outcome = 'repair' | 'purchase' | 'clean_next' | 'clean_new' | 'none';
export type DefaultOutcome = 'repair' | 'purchase' | 'clean';

/** In walking order: in the door, the common rooms, the bedrooms and baths, then outside. */
export const AREAS: { key: Area; label: string; perRoom: boolean }[] = [
  { key: 'general', label: 'General & entry', perRoom: false },
  { key: 'living', label: 'Living room', perRoom: false },
  { key: 'kitchen', label: 'Kitchen', perRoom: false },
  { key: 'bedroom', label: 'Bedroom', perRoom: true },
  { key: 'bathroom', label: 'Bathroom', perRoom: true },
  { key: 'exterior', label: 'Outside', perRoom: false }
];
export const AREA_KEYS = new Set<string>(AREAS.map(a => a.key));

export interface InspectionItem {
  id: string; area: Area; label: string; defaultOutcome: DefaultOutcome;
  /** Only this unit; null = every unit. */
  unitId: string | null;
  position: number; active: boolean;
}

export interface Section { area: Area; n: number; title: string; items: InspectionItem[] }

/** How many of a per-room area a unit has: bedrooms, and bathrooms rounded up (2.5 baths = 3 to check). */
export function roomsOf(unit: { bedrooms: number | null; bathrooms: number | null }, area: Area): number {
  if (area === 'bedroom') return Math.max(1, Math.round(Number(unit.bedrooms) || 1));
  if (area === 'bathroom') return Math.max(1, Math.ceil(Number(unit.bathrooms) || 1));
  return 1;
}

export const areaTitle = (area: Area, n: number, count: number) => {
  const a = AREAS.find(x => x.key === area)!;
  return a.perRoom && count > 1 ? `${a.label} ${n}` : a.label;
};

/** The checklist one unit gets: its sections, in walking order, each with its active items. */
export function checklistFor(items: InspectionItem[], unit: { id: string; bedrooms: number | null; bathrooms: number | null }): Section[] {
  const mine = items.filter(i => i.active && (!i.unitId || i.unitId === unit.id))
    .sort((a, b) => a.position - b.position || Number(a.id) - Number(b.id));
  const out: Section[] = [];
  for (const a of AREAS) {
    const its = mine.filter(i => i.area === a.key);
    if (!its.length) continue;
    const count = roomsOf(unit, a.key);
    for (let n = 1; n <= (a.perRoom ? count : 1); n++) out.push({ area: a.key, n, title: areaTitle(a.key, n, count), items: its });
  }
  return out;
}

export interface Check {
  id?: string; itemId: string | null; area: Area; n: number; label: string;
  result: CheckResult | null; note: string | null;
  photos: { name: string; url: string }[];
  outcome: Outcome | null;
}

/** The key a check is stored and found by: the item in its room, or the ad-hoc check's own id. */
export const checkKey = (c: { itemId: string | null; n: number; id?: string }) => c.itemId ? `${c.itemId}:${c.n}` : `x:${c.id}`;

/** How far it got: items answered of all items, and how many need attention. */
export function progress(sections: Section[], checks: Check[]) {
  const by = new Map(checks.map(c => [checkKey(c), c]));
  let total = 0, done = 0;
  for (const s of sections) for (const i of s.items) {
    total++;
    if (by.get(`${i.id}:${s.n}`)?.result) done++;
  }
  const attention = checks.filter(c => c.result === 'attention').length;
  return { total, done, attention };
}

/** What a finding becomes unless the inspector says otherwise. */
export const suggestedOutcome = (d: DefaultOutcome | null | undefined): Outcome =>
  d === 'purchase' ? 'purchase' : d === 'clean' ? 'clean_next' : 'repair';

/** Before finishing: every finding needs a photo, and a decision. */
export function readyToFinish(checks: Check[]): { ok: boolean; missingPhoto: Check[]; undecided: Check[] } {
  const att = checks.filter(c => c.result === 'attention');
  const missingPhoto = att.filter(c => !c.photos.length);
  const undecided = att.filter(c => !c.outcome);
  return { ok: !missingPhoto.length && !undecided.length, missingPhoto, undecided };
}

/** The inspection's overall result, in the log's own words. */
export function overallResult(checks: Check[]): 'OK' | 'Minor issues' | 'Maintenance needed' {
  const att = checks.filter(c => c.result === 'attention');
  if (!att.length) return 'OK';
  return att.some(c => c.outcome === 'repair') ? 'Maintenance needed' : 'Minor issues';
}

/** The work a finding becomes: a repair (work order) or a purchase (to-do). */
export function workFor(c: Check, ctx: { unit: string; date: string; inspector: string; sectionTitle: string }):
  { kind: 'work_order' | 'task'; title: string; description: string } | null {
  if (c.outcome !== 'repair' && c.outcome !== 'purchase') return null;
  const what = c.note?.trim() ? `${c.label} — ${c.note.trim()}` : c.label;
  const lines = [
    `Found at the inspection of ${ctx.unit} on ${ctx.date}${ctx.inspector ? ` by ${ctx.inspector}` : ''} — ${ctx.sectionTitle}.`,
    c.note?.trim() ? `Note: ${c.note.trim()}` : null,
    ...c.photos.map(p => `Photo: ${p.url}`)
  ].filter(Boolean) as string[];
  return c.outcome === 'repair'
    ? { kind: 'work_order', title: `${ctx.sectionTitle}: ${what}`.slice(0, 300), description: lines.join('\n') }
    : { kind: 'task', title: `Buy: ${what}`.slice(0, 300), description: lines.join('\n') };
}

/** The sub-task every repair from an inspection starts with: nobody is on it yet. */
export const ASSIGN_SUBTASK = 'Assign and schedule';

/** What a clean is asked to do, from a finding. */
export const cleanTaskText = (c: Check, sectionTitle: string) =>
  `${sectionTitle}: ${c.note?.trim() ? `${c.label} — ${c.note.trim()}` : c.label}`.slice(0, 500);
