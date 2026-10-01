/**
 * SOPs and articles (§92) — shared by the library, each screen's "SOPs"
 * button and the API.
 *
 * Two axes: a SECTION is a process area (how the library is browsed); the
 * FEATURES are the screens an SOP shows on (where it is needed). The
 * screens are code, so their list is here; sections are data.
 */

export type SopKind = 'sop' | 'article';
export type SopStatus = 'draft' | 'published' | 'archived';
/**
 * One step: what to do (a line), who does it, and — expandable — how, in
 * as much detail as it takes (the same markdown habits as the body).
 */
export interface SopStep { text: string; who?: string; detail?: string }

export interface SopSection { key: string; label: string; description: string | null; sort: number }

export interface Sop {
  id: string;
  sectionKey: string;
  kind: SopKind;
  title: string;
  status: SopStatus;
  purpose: string | null;
  trigger: string | null;
  owner: string | null;
  doneWhen: string | null;
  steps: SopStep[];
  body: string | null;
  features: string[];
  reviewDays: number;
  reviewedAt: string | null;
  reviewedBy: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

/** What a version snapshot holds — the content, not the filing. */
export const CONTENT_FIELDS = ['title', 'kind', 'purpose', 'trigger', 'owner', 'doneWhen', 'steps', 'body'] as const;
export type SopContent = Pick<Sop, typeof CONTENT_FIELDS[number]>;

export interface SopVersion { version: number; snapshot: SopContent; note: string | null; editedBy: string | null; editedAt: string }

/**
 * The screens of the app, each a place an SOP can be shown. `section` is
 * where a new SOP written from that screen is filed by default.
 */
export const FEATURES: { key: string; label: string; tab: string; view?: string; section: string }[] = [
  { key: 'home', label: 'Home', tab: 'home', section: 'guest' },
  { key: 'units', label: 'Units', tab: 'units', section: 'revenue' },
  { key: 'revenue', label: 'Revenue', tab: 'revenue', section: 'revenue' },
  { key: 'operations.board', label: 'Operations · Next 10 days', tab: 'operations', view: 'board', section: 'turnover' },
  { key: 'operations.todos', label: 'Operations · To-do', tab: 'operations', view: 'todos', section: 'maintenance' },
  { key: 'operations.calendar', label: 'Operations · Calendar', tab: 'operations', view: 'calendar', section: 'turnover' },
  { key: 'operations.cleaners', label: 'Operations · By cleaner', tab: 'operations', view: 'cleaners', section: 'turnover' },
  { key: 'operations.inspections', label: 'Operations · Inspections', tab: 'operations', view: 'inspections', section: 'inspections' },
  { key: 'operations.notes', label: 'Operations · Notes log', tab: 'operations', view: 'notes', section: 'guest' },
  { key: 'operations.rates', label: 'Operations · Rates & rules', tab: 'operations', view: 'rates', section: 'turnover' },
  { key: 'operations.setup', label: 'Operations · Setup', tab: 'operations', view: 'setup', section: 'systems' },
  { key: 'repository', label: 'Repository', tab: 'repository', section: 'systems' },
  { key: 'costs', label: 'Costs', tab: 'costs', section: 'finance' },
  { key: 'claims', label: 'Claims', tab: 'claims', section: 'claims' },
  { key: 'settings', label: 'Settings', tab: 'settings', section: 'systems' }
];
export const FEATURE_KEYS = new Set(FEATURES.map(f => f.key));
export const featureLabel = (key: string) => FEATURES.find(f => f.key === key)?.label ?? key;

/** The screen someone is on, as a feature key: a tab, or Operations and its view. */
export function featureOf(tab: string, view?: string): string | null {
  if (tab === 'operations') return `operations.${view || 'board'}`;
  return FEATURES.some(f => f.key === tab) ? tab : null;
}

/** The day a published SOP is next due for review; null for drafts and archived ones. */
export function reviewDueOn(s: Pick<Sop, 'status' | 'reviewedAt' | 'updatedAt' | 'reviewDays'>): string | null {
  if (s.status !== 'published') return null;
  const from = Date.parse(s.reviewedAt ?? s.updatedAt);
  if (!Number.isFinite(from)) return null;
  return new Date(from + s.reviewDays * 864e5).toISOString().slice(0, 10);
}
export const reviewOverdue = (s: Parameters<typeof reviewDueOn>[0], today: string) => {
  const due = reviewDueOn(s);
  return due != null && due < today;
};

/** Screens with at least one published SOP, and the ones with none — the library's gaps. */
export function coverage(sops: Pick<Sop, 'status' | 'features'>[]) {
  const covered = new Set(sops.filter(s => s.status === 'published').flatMap(s => s.features));
  const gaps = FEATURES.filter(f => !covered.has(f.key));
  return { covered: FEATURES.length - gaps.length, total: FEATURES.length, gaps };
}

/** What a reader sees on a screen: published ones, SOPs before articles, then by title. */
export function forFeature<T extends Pick<Sop, 'status' | 'features' | 'kind' | 'title'>>(sops: T[], feature: string, drafts = false): T[] {
  return sops.filter(s => s.features.includes(feature) && (s.status === 'published' || (drafts && s.status === 'draft')))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sop' ? -1 : 1) || a.title.localeCompare(b.title));
}

/** Every word typed must appear somewhere in the SOP, in any order. */
export function matchesSearch(s: Pick<Sop, 'title' | 'purpose' | 'trigger' | 'owner' | 'body' | 'steps' | 'doneWhen'>, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [s.title, s.purpose, s.trigger, s.owner, s.body, s.doneWhen, ...s.steps.map(x => `${x.text} ${x.who ?? ''} ${x.detail ?? ''}`)]
    .filter(Boolean).join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

/** True when the content changed — the difference between a new version and a re-filing. */
export function contentChanged(a: SopContent, b: SopContent): boolean {
  const norm = (c: SopContent) => JSON.stringify(CONTENT_FIELDS.map(k => {
    const v = c[k];
    if (k === 'steps') return (v as SopStep[]).map(x => [x.text.trim(), (x.who ?? '').trim(), (x.detail ?? '').trim()]);
    return typeof v === 'string' ? v.trim() : v ?? '';
  }));
  return norm(a) !== norm(b);
}

/** Steps as typed: blanks dropped, trimmed, "who" and "detail" only when given. */
export function cleanSteps(steps: unknown): SopStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map(x => ({
    text: String((x as SopStep)?.text ?? '').trim().slice(0, 600),
    who: String((x as SopStep)?.who ?? '').trim().slice(0, 80),
    detail: String((x as SopStep)?.detail ?? '').trim().slice(0, 4000)
  })).filter(x => x.text).slice(0, 60)
    .map(x => ({ text: x.text, ...(x.who ? { who: x.who } : {}), ...(x.detail ? { detail: x.detail } : {}) }));
}

/* ── the body: a few markdown habits, rendered without HTML ─────────── */

export type Inline = { t: 'text'; v: string } | { t: 'bold'; v: string } | { t: 'link'; v: string; href: string };
export type Block =
  | { t: 'h'; v: Inline[] }
  | { t: 'p'; v: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] };

/**
 * `## heading`, `- bullet`, `1. numbered`, `**bold**`, bare https links,
 * blank line between paragraphs. Parsed into data and drawn as React
 * elements, so nothing typed into an SOP is ever interpreted as HTML.
 */
export function parseBody(text: string | null | undefined): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: 'p', v: inline(para.join(' ')) }); para = []; } };
  for (const raw of (text ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ t: 'h', v: inline(h[1]!) }); continue; }
    if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const last = out[out.length - 1];
      const item = inline((ul ?? ol)![1]!);
      if (last && last.t === kind) last.items.push(item); else out.push({ t: kind, items: [item] });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|(https:\/\/[^\s)]+)/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ t: 'text', v: s.slice(at, m.index) });
    if (m[1]) out.push({ t: 'bold', v: m[1] });
    else { const href = m[2]!.replace(/[.,;:]+$/, ''); out.push({ t: 'link', v: href, href }); re.lastIndex = m.index + href.length; }
    at = re.lastIndex;
  }
  if (at < s.length) out.push({ t: 'text', v: s.slice(at) });
  return out;
}
