/**
 * The module map (restructure, owner 2026-11-13 → 2026-11-16): the menu is the company's areas, not the order the
 * screens were built in. Core at the base, one module per area, the two portals apart. The screens themselves are
 * unchanged — a module is a group of doors to them (a tab, or one of Operations' views). Pure: App.tsx draws it.
 *
 * A module with `phase` is planned and empty on purpose (owner, 2026-11-16: "created but empty"): it has a page that
 * says what will live there, and only someone who can open Settings sees it — nobody is assigned to those areas yet.
 */
export interface NavLink {
  key: string; label: string;
  /** The tab the server allows (roles.ts `tabsFor`); 'operations' + `view` is one of Operations' views. */
  tab: string; view?: string;
  /** Extra query keys the screen reads (To-do's `list`). */
  params?: Record<string, string>;
  /** Every one of these permissions is needed to see the link. */
  perms?: string[];
  /** A second door to a screen that already belongs to another module: never the one that lights up. */
  alias?: boolean;
  /** Opens outside the team app (the guest portal — its own domain later). */
  href?: string;
}
export interface NavModule {
  key: string; label: string; icon: string;
  phase?: 'Phase 2' | 'Future';
  /** Draw its doors under it even when there is only one (Guest Services → CRM, whose count sits on the door). */
  alwaysSub?: boolean;
  /** What a planned module will hold — its empty page lists these, nothing else. */
  plan?: string[];
  links: NavLink[];
}

export const MODULES: NavModule[] = [
  // Owner 2026-11-17: Home is the main door — named Home, not Leadership.
  { key: 'leadership', label: 'Home', icon: 'home', links: [
    { key: 'home', label: 'Home', tab: 'home' }] },
  // Owner 2026-11-17: the Inbox is the CRM; the claims shortcut is gone (claims and upsells live in Operations → To-do and in
  // each conversation). One door, still drawn under the module: the CRM carries the count, the module only a dot.
  { key: 'guests', label: 'Guest Services', icon: 'inbox', alwaysSub: true, links: [
    { key: 'inbox', label: 'CRM', tab: 'inbox' }] },
  { key: 'operations', label: 'Operations', icon: 'operations', links: [
    { key: 'board', label: 'Movements', tab: 'operations', view: 'board' },
    { key: 'todos', label: 'To-do', tab: 'operations', view: 'todos', perms: ['todos'] },
    { key: 'inspections', label: 'Inspections', tab: 'operations', view: 'inspections' },
    { key: 'inventory', label: 'Inventory', tab: 'operations', view: 'inventory' },
    { key: 'notes', label: 'Notes log', tab: 'operations', view: 'notes' },
    { key: 'blocks', label: 'Calendar log', tab: 'operations', view: 'blocks' },
    { key: 'rates', label: 'Rates & rules', tab: 'operations', view: 'rates' },
    { key: 'setup', label: 'Setup', tab: 'operations', view: 'setup', perms: ['operations.setup'] }] },
  { key: 'experience', label: 'Guest Experience', icon: 'experience', phase: 'Phase 2',
    plan: ['Listing audit', 'Listing Health', 'Check-in guides', 'Guest verification'],
    links: [{ key: 'experience', label: 'Guest Experience', tab: 'experience' }] },
  { key: 'finance', label: 'Finance, Data & Tech', icon: 'revenue', links: [
    { key: 'units', label: 'Units', tab: 'units' },
    { key: 'revenue', label: 'Revenue', tab: 'revenue' },
    { key: 'costs', label: 'Costs', tab: 'costs' },
    { key: 'analytics', label: 'Analytics', tab: 'analytics' }] },
  { key: 'sales', label: 'Sales & Growth', icon: 'sales', phase: 'Future',
    plan: ['New properties pipeline', 'Landlord relations'],
    links: [{ key: 'sales', label: 'Sales & Growth', tab: 'sales' }] },
  { key: 'schedules', label: 'Schedules', icon: 'schedules', phase: 'Future',
    plan: ['Shifts', 'Coverage'],
    links: [{ key: 'schedules', label: 'Schedules', tab: 'schedules' }] },
  { key: 'shared', label: 'Shared tools', icon: 'sops', links: [
    { key: 'sops', label: 'SOPs', tab: 'sops' }] },
  // The team's side of the vendors' pages: still Operations' views, grouped as the one portal they will become.
  { key: 'vendors', label: 'Vendor portal', icon: 'vendors', links: [
    { key: 'crew', label: 'Cleaners', tab: 'operations', view: 'crew' },
    { key: 'vendors', label: 'Handymen', tab: 'operations', view: 'vendors' }] },
  { key: 'portal', label: 'Guest portal', icon: 'portal', links: [
    { key: 'portal', label: 'Preview', tab: 'repository', href: '/crew/guest-demo' }] },
  { key: 'core', label: 'Core', icon: 'repository', links: [
    { key: 'repository', label: 'Repository', tab: 'repository' },
    { key: 'settings', label: 'Settings', tab: 'settings' }] },
];

/** The tabs that are a planned module's empty page — not from the server: drawn for whoever can open Settings. */
export const PLANNED_TABS = MODULES.filter(m => m.phase).map(m => m.links[0]!.tab);

const can = (permissions: string[], key: string) => permissions.includes('*') || permissions.includes(key);

/** The modules this person sees, each cut to the doors they may open; a module with none is not drawn. */
export function navFor(tabs: string[], permissions: string[]): NavModule[] {
  const admin = can(permissions, 'settings');
  return MODULES.map(m => ({
    ...m,
    links: m.links.filter(l => (m.phase ? admin : tabs.includes(l.tab)) && (l.perms ?? []).every(p => can(permissions, p))),
  })).filter(m => m.links.length > 0);
}

/** Operations' Cleaners view also shows its calendar (`calendar`) — the same door. */
const sameView = (link: NavLink, view?: string) => link.view === view || (link.view === 'crew' && view === 'calendar');

/** Does this door lead to what is on screen? An alias or an outside link never does. */
export function isActive(link: NavLink, tab: string | null, view?: string): boolean {
  if (link.alias || link.href || link.tab !== tab) return false;
  return link.tab !== 'operations' || sameView(link, view ?? 'board');
}

export const moduleOf = (mods: NavModule[], tab: string | null, view?: string): NavModule | undefined =>
  mods.find(m => m.links.some(l => isActive(l, tab, view)));

/** The phone's bottom bar: the first screen of each module, in order — the doors a thumb needs most. */
export function barLinks(mods: NavModule[], max = 4): NavLink[] {
  const out: NavLink[] = [];
  for (const m of mods) {
    const l = m.links.find(x => !x.alias && !x.href);
    if (l && !m.phase && !out.some(o => o.tab === l.tab)) out.push(l);
  }
  return out.slice(0, max);
}

/** "Operations › Movements" — where a bug report was sent from, and the phone header's label. */
export function whereLabel(mods: NavModule[], tab: string | null, view?: string): string {
  const m = moduleOf(mods, tab, view);
  const l = m?.links.find(x => isActive(x, tab, view));
  if (!m || !l) return tab ?? 'Kaizen';
  return m.links.length > 1 || m.label !== l.label ? `${m.label} › ${l.label}` : m.label;
}
