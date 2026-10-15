/**
 * Practice (§139) — the field pages the team trains on: the inspection, the
 * handyman with and without an account, the cleaner and the helper. The same
 * screens the field gets, with example data, every button working — and
 * nothing leaving the browser: no server, no Hostaway, no Slack, no Drive,
 * nothing in Costs or on the board. A reload starts over.
 * Opened from the SOP panel on Inspections and Cleaners (`/#practice/<which>`).
 */
import { useMemo, useState } from 'react';
import type { CleanFieldState, CrewPage, CrewUpcoming, InspectionRunData, InvItemRow, Inventory, ReportTeam, RunCheck, SupplyItem, WorkPage } from '../api.ts';
import { InspectionRun, type RunTransport } from '../components/InspectionRun.tsx';
import { CrewHome, type PracticeCrew } from './Crew.tsx';
import { ReportPage } from './Report.tsx';
import { InventoryView, type InvTransport } from './Inventory.tsx';
import { orderList, stockLevels, toOrder, type Move } from '../lib/inventory.ts';
import { VendorHome, WorkLinkPage } from './Work.tsx';
import {
  AREAS, areaTitle, checklistFor, overallResult, purchaseList, readyToFinish, roomsOf, suggestedOutcome, workFor,
  type Area, type AreaDef, type DefaultOutcome, type InspectionItem, type Outcome
} from '../lib/inspection.ts';
import { buildInvoice, periodOf, recentPeriods, type CrewClean, type CrewExtra } from '../lib/crew.ts';
import { addDays, todayIn } from '../lib/dates.ts';
import type { UnitAccess } from '../lib/unit-access.ts';
import type { Lang } from '../lib/crew-i18n.ts';
import { Icon, ic } from '../components/Icon.tsx';

export type PracticeWhich = 'inspection' | 'work-link' | 'vendor' | 'cleaner' | 'helper' | 'inventory';
export const PRACTICE: Record<PracticeWhich, { en: string; es: string }> = {
  inspection: { en: '🔍 An inspection', es: '🔍 Una inspección' },
  'work-link': { en: '🔧 A repair — handyman with a link (no account)', es: '🔧 Una reparación — handyman con link (sin cuenta)' },
  vendor: { en: '🔧 A repair — handyman signed in (account)', es: '🔧 Una reparación — handyman con cuenta' },
  cleaner: { en: '🧹 The cleaner’s page', es: '🧹 La página del cleaner' },
  helper: { en: '🧽 A helper’s link (sub cleaner)', es: '🧽 El link de un ayudante (sub cleaner)' },
  inventory: { en: '📦 Inventory — count, order, record a purchase', es: '📦 Inventario — contar, pedir, registrar una compra' }
};
/** Which practices the SOP panel offers on each screen. */
export const PRACTICE_FOR: Record<string, PracticeWhich[]> = {
  'operations.inspections': ['inspection', 'work-link', 'vendor'],
  'operations.crew': ['cleaner', 'helper'],
  'operations.inventory': ['inventory'],
  'operations.calendar': ['cleaner', 'helper']
};
export const isPractice = (s: string): s is PracticeWhich => s in PRACTICE;
/**
 * The practices a cleaner or helper opens without a sign-in (§140): under /crew,
 * which Access already lets through. The rest stay on the hash door, behind Access.
 */
export const PUBLIC_PRACTICE: Partial<Record<PracticeWhich, string>> = { cleaner: '/crew/mock', helper: '/crew/mock-helper' };
export const practiceUrl = (k: PracticeWhich) => PUBLIC_PRACTICE[k] ?? `/#practice/${k}`;

const TZ = 'America/New_York';
const UNIT = '🧪 Practice House', LOFT = '🧪 Practice Loft';
const ACCESS: UnitAccess = {
  address: '123 Practice Ln, Frisco, TX 75035', mapsUrl: 'https://maps.google.com/?q=Frisco%2C%20TX',
  lockType: 'Smart lock (practice)', kind: 'smart', code: '1234', codeFrom: 'repository', lockbox: null, fob: null,
  wifiName: 'Practice-WiFi', wifiPassword: 'practice123', missing: [],
  // §150: a house takes from its own closet…
  supplies: { label: 'Closet', self: true, code: '4321' }
};
// …an apartment from its building's storage.
const LOFT_ACCESS: UnitAccess = { ...ACCESS, address: '45 Example Ave #210, Frisco, TX 75034', lockType: 'Lockbox (practice)', kind: 'keys', code: null, lockbox: '0000',
  supplies: { label: 'S100', self: false, code: '0000' } };
const SUPPLIES: SupplyItem[] = [
  { id: 's1', name: 'Toilet paper', measure: 'rolls', category: 'Bathroom' },
  { id: 's2', name: 'Paper towels', measure: 'rolls', category: 'Kitchen' },
  { id: 's3', name: 'Trash bags', measure: 'bags', category: 'Kitchen' },
  { id: 's4', name: 'Dish soap', measure: 'bottles', category: 'Kitchen' },
  { id: 's5', name: 'Shampoo', measure: 'bottles', category: 'Bathroom' },
  { id: 's6', name: 'Coffee pods', measure: 'pods', category: 'Kitchen' }
];
const sleep = (ms = 250) => new Promise(r => setTimeout(r, ms));
const clone = <T,>(x: T): T => structuredClone(x);
const NOW = () => new Date().toISOString();

/* ── the inspection ───────────────────────────────────────────────── */

const AREA_ES: Record<string, string> = { general: 'General y entrada', living: 'Sala', kitchen: 'Cocina', bedroom: 'Habitación', bathroom: 'Baño', exterior: 'Exterior', pool: 'Piscina y jacuzzi' };
const ITEMS: [Area, DefaultOutcome, string, string][] = [
  ['general', 'repair', 'Entry door, lock and keypad work', 'Puerta de entrada, chapa y teclado funcionan'],
  ['general', 'repair', 'Smoke and CO detectors work', 'Detectores de humo y CO funcionan'],
  ['general', 'repair', 'Thermostat and A/C work', 'Termostato y aire acondicionado funcionan'],
  ['living', 'repair', 'Walls: no marks, holes or stains', 'Paredes: sin marcas, huecos ni manchas'],
  ['living', 'clean', 'Sofa and floors clean', 'Sofá y pisos limpios'],
  ['kitchen', 'purchase', 'Kitchen stock: coffee, tea, sugar, salt', 'Despensa: café, té, azúcar, sal'],
  ['kitchen', 'clean', 'Fridge, oven and microwave clean', 'Nevera, horno y microondas limpios'],
  ['kitchen', 'repair', 'Sink and faucet: no leaks', 'Lavaplatos y llave: sin fugas'],
  ['bedroom', 'purchase', 'Sheets clean, no stains or tears', 'Sábanas limpias, sin manchas ni rotos'],
  ['bedroom', 'repair', 'Lamps, outlets and blinds work', 'Lámparas, enchufes y persianas funcionan'],
  ['bathroom', 'purchase', 'Towels complete and clean', 'Toallas completas y limpias'],
  ['bathroom', 'purchase', 'Toilet paper stocked', 'Papel higiénico surtido'],
  ['bathroom', 'clean', 'Toilet, shower and sink clean', 'Inodoro, ducha y lavamanos limpios'],
  ['bathroom', 'repair', 'Hot water and good pressure', 'Agua caliente y buena presión'],
  ['exterior', 'clean', 'Patio clean, furniture in place', 'Patio limpio, muebles en su lugar'],
  ['pool' as Area, 'repair', 'Pool clean and working', 'Piscina limpia y funcionando']
];

function inspectionTransport(lang: Lang): RunTransport {
  const today = todayIn(TZ);
  const items: InspectionItem[] = ITEMS.map(([area, out, en, es], i) => ({
    id: String(i + 1), area, label: lang === 'es' ? es : en, defaultOutcome: out, appliesTo: 'all', unitIds: [], position: i, active: true,
    // §150: a purchase item with its supply preset — the inspector only says how many.
    supplyId: en === 'Toilet paper stocked' ? 's1' : null
  }));
  const areas: AreaDef[] = [...AREAS, { key: 'pool', label: 'Pool & hot tub', perRoom: false }]
    .map((a, i) => ({ ...a, label: lang === 'es' ? AREA_ES[a.key] ?? a.label : a.label, position: i + 1, active: true }));
  const unit = { id: 'practice', type: 'house' as const, bedrooms: 2, bathrooms: 2 };
  const sections = checklistFor(items, unit, areas);
  let checks: RunCheck[] = [];
  let seq = 1;
  let fin: { result: string; notes: string | null } | null = null;
  const data = (): InspectionRunData => ({
    inspection: { id: 'practice', unitId: 'practice', unit: UNIT, date: today, inspector: 'You', result: fin?.result ?? null, notes: fin?.notes ?? null, finished: !!fin },
    sections, rooms: { bedrooms: 2, bathrooms: 2 }, checks: clone(checks),
    nextClean: { key: 'P-NEXT', date: addDays(today, 1), cleaner: 'Practice cleaner' }, inspectors: ['You'], today,
    supplies: SUPPLIES.map(s => ({ id: s.id, name: s.name, measure: s.measure }))
  });
  const patch = (c: RunCheck, b: Record<string, unknown>) => {
    if ('result' in b) { c.result = (b.result as RunCheck['result']) ?? null; if (c.result !== 'attention') c.outcome = null; }
    if ('note' in b) c.note = String(b.note ?? '').trim() || null;
    if ('outcome' in b) c.outcome = (b.outcome as Outcome) ?? null;
    if (c.result === 'attention' && !c.outcome) c.outcome = suggestedOutcome(items.find(i => i.id === c.itemId)?.defaultOutcome);
  };
  const ok = <T extends object>(x: T) => ({ ok: true as const, ...x });
  return {
    get: async () => { await sleep(); return ok(data()); },
    act: async <T extends object>(b: Record<string, unknown>) => {
      await sleep();
      const r = (x: object) => ok(x) as { ok: true } & T;
      if (b.action === 'check') {
        let c = b.checkId ? checks.find(x => x.id === String(b.checkId)) : checks.find(x => x.itemId === String(b.itemId) && x.n === Number(b.n));
        if (!c) {
          const it = items.find(i => i.id === String(b.itemId));
          if (!it) return { ok: false as const, message: 'Unknown item.' };
          c = { id: String(seq++), itemId: it.id, area: it.area, n: Number(b.n) || 1, label: it.label, result: null, note: null, photos: [], outcome: null };
          checks.push(c);
        }
        patch(c, b);
        return r({ checkId: c.id });
      }
      if (b.action === 'allOk') {
        const s = sections.find(x => x.area === b.area && x.n === Number(b.n));
        for (const it of s?.items ?? []) if (!checks.some(c => c.itemId === it.id && c.n === s!.n))
          checks.push({ id: String(seq++), itemId: it.id, area: it.area, n: s!.n, label: it.label, result: 'ok', note: null, photos: [], outcome: null });
        return r({});
      }
      if (b.action === 'add') {
        const outcome: Outcome = b.kind === 'purchase' ? 'purchase' : b.kind === 'clean' ? 'clean_next' : 'repair';
        // §150: a supply from the 🔍 reads "Toilet paper × 4", as the real one.
        const sup = SUPPLIES.find(s => s.id === String(b.supplyId ?? ''));
        const c: RunCheck = { id: String(seq++), itemId: null, area: String(b.area ?? 'general'), n: Number(b.n) || 1,
                              label: sup ? `${sup.name} × ${Math.ceil(Number(b.supplyQty) || 1)}` : String(b.label ?? '').trim(),
                              result: 'attention', note: String(b.note ?? '').trim() || null, photos: [], outcome };
        if (!c.label) return { ok: false as const, message: 'Say what it is.' };
        checks.push(c);
        return r({ checkId: c.id });
      }
      if (b.action === 'remove') { checks = checks.filter(c => c.id !== String(b.checkId)); return r({}); }
      if (b.action === 'supply') {
        const c = checks.find(x => x.id === String(b.checkId));
        if (c) { c.supplyId = b.supplyId ? String(b.supplyId) : null; c.supplyQty = b.supplyId ? Math.ceil(Number(b.supplyQty) || 1) : null; }
        return r({});
      }
      if (b.action === 'finish') {
        const ready = readyToFinish(checks);
        if (!ready.ok) return { ok: false as const, message: `Choose what ${ready.undecided.length} finding(s) become.` };
        const title = (c: { area: Area; n: number }) => areaTitle(c.area, c.n, roomsOf(unit, c.area), areas);
        const ctx = { unit: UNIT, date: today, inspector: 'You' };
        const att = checks.filter(c => c.result === 'attention');
        const made = [
          ...att.filter(c => c.outcome === 'repair').map(c => ({ kind: 'repair', title: workFor(c, { ...ctx, sectionTitle: title(c) })!.title })),
          ...(() => { const p = purchaseList(checks, ctx, title); return p ? [{ kind: 'purchase', title: p.title }] : []; })(),
          ...att.filter(c => c.outcome === 'clean_next' || c.outcome === 'clean_new').map(c => ({ kind: 'clean', title: `${title(c)}: ${c.label}` }))
        ];
        fin = { result: String(b.result || overallResult(checks)), notes: String(b.notes ?? '') || null };
        return r({ made });
      }
      return r({});
    },
    photos: async (checkId, files) => {
      await sleep();
      const c = checks.find(x => x.id === checkId);
      if (c) c.photos.push(...files.map(f => ({ name: f.name, url: URL.createObjectURL(f) })));
      return { ok: true as const };
    }
  };
}

/** The run opens full screen on a phone, so the language is chosen first, here, under the practice banner. */
function InspectionPractice() {
  const [lang, setLang] = useState<Lang | null>(null);
  const [round, setRound] = useState(0);
  const tr = useMemo(() => inspectionTransport(lang ?? 'en'), [lang, round]);
  const es = lang === 'es';
  if (!lang) return (
    <div className="card">
      <h2><Icon n="search" /> {ic(UNIT)}</h2>
      <p className="note">A 2-bedroom, 2-bath house with a pool. Check the items, mark what needs work, then Review &amp; finish.
        <br />Una casa de 2 habitaciones y 2 baños con piscina. Revisa los ítems, marca lo que necesita trabajo y luego Review &amp; finish.</p>
      <div className="button-row">
        <button onClick={() => setLang('en')}>▶ Start in English</button>
        <button onClick={() => setLang('es')}>▶ Empezar en español</button>
      </div>
    </div>
  );
  return <>
    <InspectionRun key={round} id="practice" canEdit transport={tr} onClose={() => { setLang(null); setRound(n => n + 1); }} />
    <p className="note">{ic(es ? 'Inspección de práctica abierta.' : 'Practice inspection open.')}</p>
  </>;
}

/* ── the handyman ─────────────────────────────────────────────────── */

type WorkSend = (fields: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string; page?: WorkPage }>;

function workOf(id: string, title: string, description: string, day: string, time: string | null): WorkPage {
  const today = todayIn(TZ);
  return {
    work: { id, title, description, unit: UNIT, scheduledOn: day, startTime: time, dueOn: null, status: 'pending', vendor: 'Practice Handyman', accepted: null, resolution: null },
    today, address: ACCESS.address, access: day === today ? ACCESS : null, photos: { before: 0, after: 0 }, charges: []
  };
}

/** One step on a practice work order: the page as the server would answer it. */
function workStep(p: WorkPage, f: Record<string, string>, es: boolean): { ok: boolean; message?: string; page?: WorkPage } {
  const w = p.work;
  switch (f.action) {
    case 'accept': w.accepted = { at: NOW(), by: 'You' }; if (w.status === 'pending') w.status = 'confirmed'; break;
    case 'cant': return { ok: false, message: es
      ? '🧪 Práctica: enviado. En la vida real el equipo recibe una tarea "Reagendar" y este link se cierra.'
      : '🧪 Practice: sent. In real life the team gets a "Reschedule" task and this link closes.' };
    case 'photo': {
      const st = f.stage === 'after' ? 'after' : 'before';
      p.photos[st]++;
      if (st === 'before' && (w.status === 'pending' || w.status === 'confirmed')) w.status = 'in_progress';
      break;
    }
    case 'note': break;
    case 'charge': {
      const amount = Number(f.amount);
      if (!(amount > 0)) return { ok: false, message: es ? 'Escribe el monto.' : 'Write the amount.' };
      p.charges.push({ id: String(p.charges.length + 1), amount, description: `${f.kind === 'materials' ? 'Materials' : 'Labor'}: ${f.description}`, status: 'pending', decisionNote: null });
      break;
    }
    case 'done': w.status = 'completed'; w.resolution = f.text ?? ''; p.access = null; break;
    default: return { ok: false, message: 'Unknown step.' };
  }
  return { ok: true, page: clone(p) };
}

const esNow = () => { try { return localStorage.getItem('workLang') === 'es'; } catch { return false; } };

function WorkLinkPractice() {
  const page = useMemo(() => workOf('P-1', 'Fix the leaking kitchen faucet', 'Guest says the faucet drips all night. Replace the cartridge if needed. (Example)', todayIn(TZ), '10:00'), []);
  const send: WorkSend = async f => { await sleep(); return workStep(page, f, esNow()); };
  return <WorkLinkPage token="" practice={{ page: clone(page), send }} />;
}

function VendorPractice() {
  const today = todayIn(TZ);
  const works = useMemo(() => [
    workOf('P-1', 'Fix the leaking kitchen faucet', 'Guest says the faucet drips all night. (Example)', today, '10:00'),
    workOf('P-2', 'Replace the patio light', 'The bulb and the fixture are rusted. (Example)', addDays(today, 2), '14:30')
  ], []);
  const send = async (id: string, f: Record<string, string>) => {
    await sleep();
    const p = works.find(w => w.work.id === id);
    return p ? workStep(p, f, esNow()) : { ok: false, message: 'Not yours.' };
  };
  return <VendorHome practice={{ vendor: 'Practice Handyman', works: clone(works), send }} />;
}

/* ── the cleaner and the helper ───────────────────────────────────── */

const blankState = (): CleanFieldState => ({ before: 0, after: 0, folderUrl: null, done: null, supplies: null });

/** A clean's 4 steps, as the server keeps them: a photo, what was taken, done / reopened. */
function fieldStep(s: CleanFieldState, f: Record<string, string>, by: string): CleanFieldState {
  const kind = f.kind ?? f.action;
  if (kind === 'photo' || kind === 'cleanPhoto') { if (f.stage === 'after') s.after++; else s.before++; }
  else if (kind === 'taken' || kind === 'nothing' || kind === 'cleanTaken' || kind === 'cleanNothing') {
    const lines = f.lines ? (JSON.parse(f.lines) as unknown[]).length : 0;
    s.supplies = { lines, none: !lines };
  } else if (kind === 'done' || (kind === 'cleanMark' && f.kind === 'done')) s.done = { by, at: NOW() };
  else if (kind === 'reopened' || (kind === 'cleanMark' && f.kind === 'reopened')) s.done = null;
  return s;
}

function crewPractice(): PracticeCrew {
  const today = todayIn(TZ);
  const period = periodOf(today, 'weekly');
  const clean = (key: string, unit: string, date: string, price: number, deep = false): CrewClean =>
    ({ key, unit, date, beds: unit === UNIT ? 3 : 1, deep, kind: 'checkout', price, assignment: 'assigned', voidReason: null, flagNote: null });
  const cleans = [clean('P-101', LOFT, addDays(today, -2), 90), clean('P-102', UNIT, addDays(today, -1), 120),
                  clean('P-201', UNIT, today, 120), clean('P-202', LOFT, today, 90)];
  const row = (key: string, date: string, unit: string, time: string, extra: Partial<CrewUpcoming> = {}): CrewUpcoming =>
    ({ key, date, unit, beds: unit === UNIT ? 3 : 1, time, deep: false, sameDay: false, checkIn: null, price: unit === UNIT ? 120 : 90, manual: null, ...extra });
  const extras: CrewExtra[] = [];
  const page: CrewPage = {
    cleaner: { name: 'Practice cleaner', invoicePeriod: 'weekly', active: true, lang: esNow() ? 'es' : 'en' },
    today, periods: recentPeriods(today, 'weekly', 4), period, cleans, extras,
    invoice: buildInvoice('Practice cleaner', period, cleans, extras, today), extraFrom: addDays(today, -60), help: [],
    supplies: { items: SUPPLIES, units: [{ id: 'practice', name: UNIT }, { id: 'practice-loft', name: LOFT }] },
    field: { 'P-101': { ...blankState(), before: 6, after: 8, supplies: { lines: 2, none: false }, done: { by: 'Practice cleaner', at: NOW() } }, 'P-102': blankState() },
    access: { 'P-201': ACCESS, 'P-202': LOFT_ACCESS },
    places: Object.fromEntries([['P-101', LOFT_ACCESS], ['P-102', ACCESS], ['P-201', ACCESS], ['P-202', LOFT_ACCESS], ['P-301', ACCESS], ['P-302', LOFT_ACCESS]]
      .map(([k, a]) => [k, { ...(a as UnitAccess).supplies!, code: null }])),
    addresses: { 'P-301': ACCESS.address!, 'P-302': LOFT_ACCESS.address! },
    fieldPhotos: {},
    upcoming: {
      enabled: true, days: 4, through: addDays(today, 3), problem: null, autoDays: 4, confirmed: null, movements: [],
      rows: [
        row('P-201', today, UNIT, '10:00', { sameDay: true, checkIn: '16:00', tasks: ['Kitchen: Fridge — clean the shelves (example from an inspection)'] }),
        row('P-202', today, LOFT, '11:00'),
        row('P-301', addDays(today, 1), UNIT, '10:00'),
        row('P-302', addDays(today, 2), LOFT, '11:00', { deep: true })
      ]
    }
  };
  const photos = new Map<string, string>();
  const stateOf = (key: string) => (page.field![key] ??= blankState());
  const reInvoice = () => { page.invoice = buildInvoice('Practice cleaner', period, page.cleans, page.extras, today); };
  return {
    get: async () => { await sleep(); return clone(page); },
    act: async b => {
      await sleep();
      if (b.action === 'setLang') page.cleaner.lang = b.lang === 'es' ? 'es' : 'en';
      else if (b.action === 'decline') page.upcoming.rows = page.upcoming.rows.filter(r => r.key !== b.key);
      else if (b.action === 'cancelExtra') { const e = page.extras.find(x => x.id === b.id); if (e) e.status = 'cancelled'; reInvoice(); }
      return { ok: true };
    },
    upload: async () => { await sleep(); return { ok: true }; },
    report: async (f, files) => {
      await sleep();
      const key = f.key ?? f.cleaningKey ?? '';
      if (f.action === 'addExtra') {
        page.extras.push({ id: String(page.extras.length + 1), key, amount: Number(f.amount), description: f.description ?? '', status: 'pending',
                           decisionNote: null, decidedBy: null, createdAt: NOW(), files: files.map((x, i) => ({ id: String(i), name: x.name, url: URL.createObjectURL(x) })) });
        reInvoice();
        return { ok: true };
      }
      if (f.action === 'cleanPhoto' || f.action === 'cleanTaken' || f.action === 'cleanNothing' || f.action === 'cleanMark') {
        const s = fieldStep(stateOf(key), f, 'Practice cleaner');
        if (f.action === 'cleanPhoto' && files[0]) {
          const id = `p${photos.size + 1}`;
          photos.set(id, URL.createObjectURL(files[0]));
          (page.fieldPhotos![key] ??= []).push({ id, stage: f.stage === 'after' ? 'after' : 'before' });
        }
        return { ok: true, state: clone(s) };
      }
      return { ok: true };   // a problem, a request, a supply: in real life a task for Ops
    },
    shareLink: async key => {
      await sleep();
      const r = page.upcoming.rows.find(x => x.key === key);
      return { ok: true, link: `${location.origin}${practiceUrl('helper')}`, unit: r?.unit ?? UNIT, date: r?.date ?? today, expires: addDays(today, 2) };
    },
    photo: async id => photos.get(id) ?? ''
  };
}

function helperPractice(): { team: ReportTeam; post: (f: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string; state?: CleanFieldState }> } {
  const today = todayIn(TZ);
  const state = blankState();
  return {
    team: { team: 'Practice cleaner', lang: esNow() ? 'es' : 'en', items: SUPPLIES, clean: { unit: UNIT, date: today, until: addDays(today, 2) }, state: clone(state), access: ACCESS },
    post: async f => { await sleep(); return { ok: true, state: clone(fieldStep(state, f, f.reporter || 'You')) }; }
  };
}

/* ── the team's inventory (§150) ─────────────────────────────────── */

/**
 * Operations → Inventory with example places — two storages and a house's
 * closet — some counted, a "not found" report, a field request and a problem
 * to attach an order to. Counting, minimums, orders (split by place) and
 * purchases all work, on the same pure rules as the real one.
 */
function inventoryPractice(): InvTransport {
  const today = todayIn(TZ);
  const items: InvItemRow[] = [...SUPPLIES.map((x, i): InvItemRow => ({ ...x, category: x.category.toLowerCase(), measure: x.measure.replace(/s$/, ''),
    perClean: [2, 1, 3, 0.25, 1, 6][i] ?? 1, reorderAt: [12, 4, 10, 1, 2, 24][i] ?? 2, active: true, kind: 'supply' })),
    // Owner, 2026-10-15: furniture is the house's — counted and ordered in the house, never in a storage.
    { id: 'f1', name: 'Bath towels', measure: 'unit', category: 'linens', perClean: null, reorderAt: 8, active: true, kind: 'furniture' },
    { id: 'f2', name: 'Wine glasses', measure: 'unit', category: 'kitchen', perClean: null, reorderAt: 6, active: true, kind: 'furniture' }];
  const S100 = 'practice/S100', S200 = 'practice/S200', HOUSE = 'practice/HOUSE', APT2 = 'practice/APT2';
  const LOFT_HOUSE = 'practice/LOFT#house', HOUSE_HOUSE = 'practice/HOUSE#house';
  const places: { place: string; name: string; self: boolean; view: 'storage' | 'house'; supplies?: string | null; from?: string; refills?: string[];
                  units: { id: string; name: string; recordId: string | null; cleansAhead: number }[] }[] = [
    { place: S100, name: 'S100 Storage (practice)', self: false, view: 'storage', refills: [APT2],
      units: [{ id: 'practice-loft', name: LOFT, recordId: null, cleansAhead: 4 }] },
    // An apartment with a closet (owner, 2026-10-15): cleaners take from the closet; S100 refills it.
    { place: APT2, name: '🧪 Practice Apt 2', self: true, view: 'storage', from: S100, units: [{ id: 'practice-apt', name: '🧪 Practice Apt 2', recordId: null, cleansAhead: 3 }] },
    { place: S200, name: 'S200 Storage (practice)', self: false, view: 'storage', units: [] },
    { place: HOUSE, name: UNIT, self: true, view: 'storage', units: [{ id: 'practice', name: UNIT, recordId: null, cleansAhead: 2 }] },
    { place: HOUSE_HOUSE, name: UNIT, self: false, view: 'house', supplies: HOUSE, units: [{ id: 'practice', name: UNIT, recordId: null, cleansAhead: 2 }] },
    { place: LOFT_HOUSE, name: LOFT, self: false, view: 'house', supplies: S100, units: [{ id: 'practice-loft', name: LOFT, recordId: null, cleansAhead: 4 }] }
  ];
  let seq = 0;
  const at = (day: string) => `${day} 09:${String(10 + (seq++ % 50)).padStart(2, '0')}:00`;
  const mv = (kind: Move['kind'], itemId: string, place: string, qty: number, day: string, unitId: string | null = null, byName = 'Practice team'): Move & { note?: string } =>
    ({ itemId, place, unitId, kind, qty, at: at(day), byName, source: unitId ? 'cleaner' : 'team' });
  const moves: (Move & { note?: string })[] = [
    mv('count', 's1', S100, 30, addDays(today, -6)), mv('count', 's6', S100, 40, addDays(today, -6)), mv('count', 's3', S100, 8, addDays(today, -6)),
    mv('taken', 's1', S100, 4, addDays(today, -3), 'practice-loft', 'Practice cleaner'), mv('taken', 's6', S100, 6, addDays(today, -3), 'practice-loft', 'Practice cleaner'),
    mv('count', 's1', APT2, 2, addDays(today, -2)), mv('count', 's6', APT2, 3, addDays(today, -2)),
    mv('count', 's1', HOUSE, 6, addDays(today, -5)), mv('missing', 's6', HOUSE, 0, addDays(today, -1), 'practice', 'Practice cleaner'),
    mv('count', 'f1', HOUSE_HOUSE, 5, addDays(today, -5)), mv('count', 'f1', S200, 4, addDays(today, -5)), mv('count', 'f2', LOFT_HOUSE, 6, addDays(today, -4))
  ];
  const mins = new Map<string, number>();
  let draft: Inventory['draft'] = null;
  const payBack: Inventory['toPayBack'] = [];
  const hidden = new Set<string>([`s5|${S200}`]);
  const orders: Inventory['orders'] = [];
  const fieldTodos: Inventory['fieldTodos'] = [
    { id: 'pt1', title: `Supplies requested — clean of ${LOFT} on ${addDays(today, -1)}`, group: 'request' },
    { id: 'pt2', title: `Problem at ${UNIT}: Broken blind`, group: 'problem' }
  ];
  const nameOf = (key: string | null) => places.find(p => p.place === key)?.name ?? '▲ no place';
  const view = (): { ok: true } & Inventory => {
    const levels = stockLevels(moves);
    const own = (i: InvItemRow, p: (typeof places)[number]) => {
      const l = levels.get(`${i.id}|${p.place}`);
      const need = p.view === 'house' ? 0 : p.units.reduce((a, u) => a + (i.perClean ?? 0) * u.cleansAhead, 0);
      return { l, need, min: mins.get(`${i.id}|${p.place}`) ?? i.reorderAt };
    };
    // A closet's shortfall is refilled from its storage, and counts as need there.
    const fed = (i: InvItemRow, key: string) => places.filter(c => c.from === key).reduce((a, c) => {
      const o = own(i, c); return a + (o.l?.countedAt ? toOrder(o.l.qty, o.need, o.min) : Math.ceil(o.need)); }, 0);
    return { ok: true, items: clone(items), aheadDays: 14, windowDays: 60, unassigned: [], orders: clone(orders), fieldTodos: clone(fieldTodos),
      draft: clone(draft), lowStockTasks: false, toPayBack: clone(payBack),
      places: places.map(p => ({ ...clone(p), hidden: items.filter(i => hidden.has(`${i.id}|${p.place}`)).map(i => i.id),
        items: items.filter(i => i.active && !hidden.has(`${i.id}|${p.place}`)
          // A house: furniture only. A storage or closet: supplies, and the furniture kept there.
          && (p.view === 'house' ? i.kind === 'furniture' : i.kind !== 'furniture' || moves.some(m => m.itemId === i.id && m.place === p.place))).map(i => {
        const o = own(i, p), l = o.l;
        const need = o.need + (i.kind === 'furniture' ? 0 : fed(i, p.place));
        const min = o.min;
        const order = toOrder(l?.countedAt ? l.qty : null, need, min);
        return { itemId: i.id, qty: l?.qty ?? null, countedAt: l?.countedAt ?? null, missingSince: l?.missingSince ?? null,
                 perClean: i.perClean, learned: false, reportedCleans: 0, need: Math.ceil(need), min, minOwn: mins.has(`${i.id}|${p.place}`),
                 ...(p.from && i.kind !== 'furniture' ? { toOrder: 0, toRefill: order } : { toOrder: order }) };
      }) })),
      recent: [...moves].reverse().map((m, k) => ({ id: String(k), item: items.find(i => i.id === m.itemId)?.name ?? '', place: nameOf(m.place),
        unit: places.flatMap(p => p.units).find(u => u.id === m.unitId)?.name ?? null, kind: m.kind, qty: m.qty, note: m.note ?? null,
        byName: m.byName ?? '', source: (m.source ?? 'team') as 'team', photos: [], at: m.at.slice(0, 16) })) };
  };
  const fail = (message: string) => ({ ok: false as const, message });
  const act = async (b: Record<string, unknown>) => {
    await sleep();
    const place = String(b.place ?? '');
    if (b.action === 'count') for (const c of (b.counts as { itemId: string; qty: string }[])) moves.push(mv('count', c.itemId, place, Number(c.qty), today));
    else if (b.action === 'settings') for (const e of (b.items as { itemId: string; name?: string; measure?: string; perClean?: string; min?: string }[])) {
      const it = items.find(i => i.id === e.itemId);
      if (!it) continue;
      if (e.name !== undefined) it.name = e.name.trim() || it.name;
      if (e.measure !== undefined) it.measure = e.measure.trim() || 'unit';
      if (e.perClean !== undefined) it.perClean = e.perClean === '' ? null : Number(e.perClean);
      if (e.min !== undefined) { if (e.min === '') mins.delete(`${e.itemId}|${place}`); else mins.set(`${e.itemId}|${place}`, Number(e.min)); }
        } else if (b.action === 'adjusts') {
      if (!String(b.note ?? '').trim()) return fail('Say why it is corrected.');
      for (const a of (b.adjusts as { itemId: string; qty: number }[]))
        moves.push({ ...mv('adjust', a.itemId, place, Number(a.qty), today), note: String(b.note) });
    } else if (b.action === 'removeItem') {
      const it = items.find(i => i.id === String(b.itemId));
      if (it) it.active = false;
    } else if (b.action === 'hide') {
      const k = `${b.itemId}|${place}`;
      if (b.hide !== false) hidden.add(k); else hidden.delete(k);
    } else if (b.action === 'newItem') {
      const name = String(b.name ?? '').trim();
      if (!name) return fail('An item needs a name.');
      const had = items.find(i => i.name.toLowerCase() === name.toLowerCase());
      if (had) { had.active = true; hidden.delete(`${had.id}|${place}`); return { ...view(), itemId: had.id }; }
      const id = `s${items.length + 1}`;
      items.push({ id, name, category: String(b.category ?? 'other'), measure: String(b.measure ?? 'unit') || 'unit', perClean: null, reorderAt: null, active: true,
                   kind: b.kind === 'furniture' ? 'furniture' : 'supply' });
      return { ...view(), itemId: id };
    } else if (b.action === 'transfer') {
      const it = items.find(i => i.id === String(b.itemId));
      const to = places.find(x => x.place === String(b.to)), from = places.find(x => x.place === String(b.from));
      const n = Number(b.qty);
      if (!it || !to || !from || !(n > 0)) return fail('Which item, where to, how many?');
      if (to.view === 'house' && it.kind !== 'furniture') return fail('Supplies are kept in a storage or a closet — not in the house.');
      moves.push({ ...mv('adjust', it.id, from.place, -n, today), note: `Moved to ${to.name}` }, { ...mv('adjust', it.id, to.place, n, today), note: `Moved from ${from.name}` });
    } else if (b.action === 'refill') {
      const to = places.find(x => x.place === String(b.to)), from = places.find(x => x.place === to?.from);
      if (!to || !from) return fail('That closet is not refilled from a storage.');
      const levels = stockLevels(moves);
      const lines = b.lines as { itemId: string; qty: number }[];
      for (const x of lines) { const have = levels.get(`${x.itemId}|${from.place}`)?.qty;
        if (have != null && x.qty > have) return fail(`${items.find(i => i.id === x.itemId)?.name}: ${from.name} has ${have} on record — count it first if there are more.`); }
      for (const x of lines) moves.push({ ...mv('adjust', x.itemId, from.place, -x.qty, today), note: `Moved to ${to.name} closet — Refill` },
                                        { ...mv('adjust', x.itemId, to.place, x.qty, today), note: `Moved from ${from.name} — Refill` });
    } else if (b.action === 'measure') {
      const it = items.find(i => i.id === String(b.itemId));
      if (!it || !String(b.measure ?? '').trim()) return fail('Counted in what?');
      it.measure = String(b.measure).trim();
    } else if (b.action === 'editItem') {
      const it = items.find(i => i.id === String(b.itemId));
      if (!it) return fail('Which item?');
      if (moves.some(m => m.itemId === it.id)) return fail('This item already has a record — edit it in Setup → Inventory.');
      it.name = String(b.name ?? '').trim() || it.name; it.measure = String(b.measure ?? '').trim() || 'unit';
      it.kind = b.kind === 'furniture' ? 'furniture' : 'supply';
    } else if (b.action === 'draft') {
      const lines = (b.lines as { itemId: string; place: string; qty: number }[]).filter(l => l.qty > 0);
      draft = lines.length ? { lines, forTodo: b.forTodo ? String(b.forTodo) : null, savedBy: 'You (practice)', savedAt: `${today} ${new Date().toTimeString().slice(0, 5)}` } : null;
    } else if (b.action === 'order') {
      draft = null;
      const lines = b.lines as { itemId: string; place: string; qty: number }[];
      const list = orderList(lines.map(l => ({ item: items.find(i => i.id === l.itemId)!, place: nameOf(l.place), qty: l.qty })));
      if (!list) return fail('Nothing to order.');
      const t = b.forTodo ? fieldTodos.find(x => x.id === b.forTodo) : null;
      const had = t ? orders.find(o => o.todoId === t.id) : null;
      if (had) had.lines.push(...lines);
      else orders.unshift({ todoId: t?.id ?? `po${orders.length + 1}`, title: t?.title ?? list.title, lines: clone(lines), at: today, purchases: 0 });
    } else return fail('Unknown action.');
    return view();
  };
  return {
    get: async () => { await sleep(); return view(); },
    act,
    upload: async f => {
      // A count with storage photos: the count is kept, the photos stay in the browser (nothing leaves it).
      if (f.get('action') === 'count') return act({ action: 'count', place: f.get('place'), counts: JSON.parse(String(f.get('counts') ?? '[]')) });
      // The receipt would go to the AI — it never leaves the browser here.
      if (f.get('action') === 'readReceipt') return fail('Practice: ✨ Read receipt works on the real screen only — nothing leaves the browser here. Fill it in by hand.');
      await sleep();
      type Part = { todoId?: string; total: number; lines: { itemId: string; place: string; qty: number }[] };
      const parts: Part[] = f.get('splits') ? JSON.parse(String(f.get('splits')))
        : [{ todoId: String(f.get('todoId') ?? ''), total: Number(f.get('total')), lines: JSON.parse(String(f.get('lines') ?? '[]')) }];
      if (parts.some(p => !(Number(p.total) > 0))) return fail('Write the total you paid.');
      const paidBy = String(f.get('paidBy') ?? '').trim();
      for (const p of parts) {
        for (const l of p.lines) moves.push({ ...mv('purchase', l.itemId, l.place, l.qty, today), note: String(f.get('note') ?? '') || undefined });
        if (paidBy) payBack.unshift({ id: String(payBack.length + 1), paidBy, total: Number(p.total), note: String(f.get('note') ?? '') || null, todo: null, at: today, photos: [] });
        const o = orders.find(x => x.todoId === p.todoId);
        if (o) o.purchases++;
      }
      return view();
    }
  };
}

/* ── the page ─────────────────────────────────────────────────────── */

export function PracticePage({ which }: { which: PracticeWhich }) {
  const crew = useMemo(crewPractice, []);
  const helper = useMemo(helperPractice, []);
  const inventory = useMemo(inventoryPractice, []);
  return (
    <main>
      <p className="banner warn practice-banner"><Icon n="flask" /> <b>Practice — nothing here is real.</b> Example data; nothing is saved or sent (no Hostaway, Slack or Drive). Reload to start over.
        <br /><Icon n="flask" /> <b>Práctica — nada de esto es real.</b> Datos de ejemplo; nada se guarda ni se envía. Recarga para empezar de nuevo.</p>
      {which === 'inspection' && <InspectionPractice />}
      {which === 'work-link' && <WorkLinkPractice />}
      {which === 'vendor' && <VendorPractice />}
      {which === 'cleaner' && <CrewHome practice={crew} />}
      {which === 'helper' && <ReportPage token={null} practice={helper} />}
      {which === 'inventory' && <InventoryView canEdit api={inventory} />}
    </main>
  );
}
