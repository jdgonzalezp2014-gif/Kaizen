/**
 * Inspections as a checklist (§133) — pure: the areas a unit has, the
 * checklist they expand to, how far an inspection got, what its findings
 * become, and the overall result.
 *
 * The rooms come from the unit: one section per bedroom and per bathroom
 * (a half bath counts as one), plus the single areas. The items come from
 * the template edited in Setup — for every unit, every house, every
 * apartment, or a list of units (§138). The areas are data too: the team adds
 * its own (a pool, a garage); only bedrooms and bathrooms repeat per room.
 */

/** An area's key: the built-in six, or one the team added (`pool`). */
export type Area = string;
export type CheckResult = 'ok' | 'attention' | 'na';
/** What a finding becomes. `clean_next`: a task for the unit's next clean; `clean_new`: a new clean. */
export type Outcome = 'repair' | 'purchase' | 'clean_next' | 'clean_new' | 'none';
export type DefaultOutcome = 'repair' | 'purchase' | 'clean';

export interface AreaDef { key: Area; label: string; perRoom: boolean; position?: number; active?: boolean }

/** The built-in areas, in walking order — what the table starts with (067), and the fallback. */
export const AREAS: AreaDef[] = [
  { key: 'general', label: 'General & entry', perRoom: false },
  { key: 'living', label: 'Living room', perRoom: false },
  { key: 'kitchen', label: 'Kitchen', perRoom: false },
  { key: 'bedroom', label: 'Bedroom', perRoom: true },
  { key: 'bathroom', label: 'Bathroom', perRoom: true },
  { key: 'exterior', label: 'Outside', perRoom: false }
];

/** A new area's key from its name: "Pool & hot tub" → `pool_hot_tub`. */
export const areaKey = (label: string) => label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Where an item applies: every unit, houses, apartments, or the units listed. */
export type AppliesTo = 'all' | 'house' | 'apartment' | 'units';
export const APPLIES: AppliesTo[] = ['all', 'house', 'apartment', 'units'];
/** House or apartment, from the Repository's "Property type"; null when it is not filled. */
export type UnitType = 'house' | 'apartment' | null;
export const unitTypeOf = (v: unknown): UnitType => {
  const t = String(v ?? '').trim().toLowerCase();
  return t === 'house' ? 'house' : t === 'apartment' ? 'apartment' : null;
};

export interface InspectionItem {
  id: string; area: Area; label: string; defaultOutcome: DefaultOutcome;
  appliesTo: AppliesTo;
  /** With appliesTo `units`: which. */
  unitIds: string[];
  position: number; active: boolean;
}

export interface UnitShape { id: string; type?: UnitType; bedrooms: number | null; bathrooms: number | null }

/** Does this item apply to this unit? A unit of unknown type gets only the items for all and its own. */
export function appliesHere(i: Pick<InspectionItem, 'appliesTo' | 'unitIds'>, unit: { id: string; type?: UnitType }): boolean {
  if (i.appliesTo === 'units') return i.unitIds.includes(unit.id);
  if (i.appliesTo === 'house' || i.appliesTo === 'apartment') return unit.type === i.appliesTo;
  return true;
}

export interface Section { area: Area; n: number; title: string; items: InspectionItem[] }

/** How many of a per-room area a unit has: bedrooms, and bathrooms rounded up (2.5 baths = 3 to check). */
export function roomsOf(unit: { bedrooms: number | null; bathrooms: number | null }, area: Area): number {
  if (area === 'bedroom') return Math.max(1, Math.round(Number(unit.bedrooms) || 1));
  if (area === 'bathroom') return Math.max(1, Math.ceil(Number(unit.bathrooms) || 1));
  return 1;
}

export const areaTitle = (area: Area, n: number, count: number, areas: AreaDef[] = AREAS) => {
  const a = areas.find(x => x.key === area);
  if (!a) return area;
  return a.perRoom && count > 1 ? `${a.label} ${n}` : a.label;
};

/** The checklist one unit gets: its sections, in walking order, each with its active items. Areas switched off are left out. */
export function checklistFor(items: InspectionItem[], unit: UnitShape, areas: AreaDef[] = AREAS): Section[] {
  const mine = items.filter(i => i.active && appliesHere(i, unit))
    .sort((a, b) => a.position - b.position || Number(a.id) - Number(b.id));
  const out: Section[] = [];
  const walk = [...areas].filter(a => a.active !== false).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const a of walk) {
    const its = mine.filter(i => i.area === a.key);
    if (!its.length) continue;
    const count = roomsOf(unit, a.key);
    for (let n = 1; n <= (a.perRoom ? count : 1); n++) out.push({ area: a.key, n, title: areaTitle(a.key, n, count, areas), items: its });
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

/**
 * Before finishing: every finding needs a decision. Photos help but are
 * never required (§135, the owner: "las fotos no son requeridas para nada").
 */
export function readyToFinish(checks: Check[]): { ok: boolean; undecided: Check[] } {
  const undecided = checks.filter(c => c.result === 'attention' && !c.outcome);
  return { ok: !undecided.length, undecided };
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

/**
 * Every purchase of an inspection as ONE to-do — a shopping list — with one
 * sub-task per item to tick off as it is bought (§133, the owner's flow).
 */
export function purchaseList(cs: Check[], ctx: { unit: string; date: string; inspector: string },
                             titleOf: (c: Check) => string): { title: string; description: string; items: string[] } | null {
  const buys = cs.filter(c => c.result === 'attention' && c.outcome === 'purchase');
  if (!buys.length) return null;
  const item = (c: Check) => `${c.label}${c.note?.trim() ? ` — ${c.note.trim()}` : ''} (${titleOf(c)})`;
  const title = buys.length === 1 ? `Buy for ${ctx.unit}: ${buys[0]!.label}` : `Buy for ${ctx.unit}: ${buys.length} items`;
  const lines = [
    `From the inspection of ${ctx.unit} on ${ctx.date}${ctx.inspector ? ` by ${ctx.inspector}` : ''}.`,
    ...buys.flatMap(c => [`• ${item(c)}`, ...c.photos.map(p => `  Photo: ${p.url}`)])
  ];
  return { title: title.slice(0, 300), description: lines.join('\n'), items: buys.map(c => `Buy: ${item(c)}`.slice(0, 300)) };
}

/** The steps of the review, in order — only the ones with something in them. */
export type ReviewStep = 'repair' | 'purchase' | 'clean' | 'finish';
export function reviewSteps(cs: Check[]): ReviewStep[] {
  const att = cs.filter(c => c.result === 'attention');
  const has = (f: (c: Check) => boolean) => att.some(f);
  return [
    ...(has(c => c.outcome === 'repair') ? ['repair' as const] : []),
    ...(has(c => c.outcome === 'purchase') ? ['purchase' as const] : []),
    ...(has(c => c.outcome === 'clean_next' || c.outcome === 'clean_new') ? ['clean' as const] : []),
    'finish'
  ];
}
