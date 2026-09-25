/**
 * Who may do what — as PERMISSIONS, grouped into roles an admin defines.
 *
 * Two fixed roles (admin, ops) were not enough: some people need to see
 * more than ops and less than admin, and almost everyone needs the
 * repository's passwords while almost nobody needs the Hostaway
 * credentials. So a role is now a named set of the permissions below,
 * edited in Settings → Roles, and `admin` is the one fixed role that
 * holds all of them.
 *
 * Enforced HERE, in the middleware, not by hiding tabs. A hidden tab is a
 * convenience; every route is reachable with a URL and a session.
 *
 * Still an ALLOW-list: a route belongs to a permission only by being
 * listed under it, so a route added next month is closed to everyone but
 * admin until somebody deliberately puts it under a permission.
 */

export interface Permission {
  key: string;
  label: string;
  /** The tab this permission draws, if it is the one that opens a screen. */
  tab?: string;
  routes: { path: string; methods: string[] }[];
}

export const PERMISSIONS: Permission[] = [
  { key: 'units', label: 'Units — occupancy, pricing and AI suggestions', tab: 'units', routes: [
    { path: '/api/forward', methods: ['GET'] }, { path: '/api/market', methods: ['GET'] },
    { path: '/api/pricing', methods: ['POST'] }, { path: '/api/suggest', methods: ['POST'] }] },
  { key: 'revenue', label: 'Revenue — what the portfolio earns', tab: 'revenue', routes: [
    { path: '/api/portfolio', methods: ['GET'] }] },
  // No route of its own: it decides what /api/operations includes.
  { key: 'money', label: 'See booking values on the operations board', routes: [] },
  { key: 'operations', label: 'Operations — see the board, inspections and notes', tab: 'operations', routes: [
    { path: '/api/operations', methods: ['GET'] }] },
  { key: 'operations.edit', label: 'Operations — assign cleaners, times, notes, log inspections', routes: [
    { path: '/api/turnover', methods: ['POST'] }, { path: '/api/inspections', methods: ['POST', 'DELETE'] }] },
  { key: 'operations.setup', label: 'Operations — roster, pay, rules and the live switch', routes: [
    { path: '/api/ops-settings', methods: ['GET', 'POST'] }] },
  { key: 'repository', label: 'Repository — look up records and documents', tab: 'repository', routes: [
    { path: '/api/repository', methods: ['GET'] }] },
  { key: 'repository.reveal', label: 'Repository — reveal passwords (each reveal is logged)', routes: [
    { path: '/api/repository-reveal', methods: ['POST'] }] },
  { key: 'repository.edit', label: 'Repository — add and edit records, upload and remove documents', routes: [
    { path: '/api/repository-edit', methods: ['POST'] }] },
  { key: 'repository.structure', label: 'Repository — sections, tables and columns', routes: [
    { path: '/api/repository-structure', methods: ['POST'] }] },
  { key: 'costs', label: 'Costs — record expenses, see cleaning costs', tab: 'costs', routes: [
    { path: '/api/expenses', methods: ['GET', 'POST', 'DELETE'] }, { path: '/api/cleaning-log', methods: ['GET'] }] },
  { key: 'claims', label: 'Claims — record and follow guest claims', tab: 'claims', routes: [
    { path: '/api/claims', methods: ['GET', 'POST', 'DELETE'] }] },
  { key: 'settings', label: 'Settings — credentials, members, roles, integrations', tab: 'settings', routes: [
    { path: '/api/settings', methods: ['POST'] }, { path: '/api/roles', methods: ['GET', 'POST', 'DELETE'] },
    { path: '/api/sync-units', methods: ['POST'] }, { path: '/api/import', methods: ['POST'] },
    { path: '/api/cleanings', methods: ['POST'] }, { path: '/api/feed', methods: ['POST'] },
    { path: '/api/cron', methods: ['POST'] }, { path: '/api/units', methods: ['POST'] }] }
];

/** The permission that means "everything", held by the admin role only. */
export const ALL = '*';

/**
 * Routes every signed-in member reaches: who they are and which tabs to
 * draw, and the unit names every form needs. Nothing here describes the
 * business beyond a list of apartments.
 */
const ALWAYS: { path: string; methods: string[] }[] = [
  { path: '/api/settings', methods: ['GET'] },
  { path: '/api/units', methods: ['GET'] }
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

export function mayAccess(permissions: string[], pathname: string, method: string): boolean {
  if (permissions.includes(ALL)) return true;
  const m = method.toUpperCase();
  const hit = (r: { path: string; methods: string[] }) => r.path === pathname && r.methods.includes(m);
  if (ALWAYS.some(hit)) return true;
  return PERMISSIONS.some(p => permissions.includes(p.key) && p.routes.some(hit));
}

/** Tabs to draw, in the app's order. The same module decides routes and tabs, so they cannot drift. */
export function tabsFor(permissions: string[]): string[] {
  const all = permissions.includes(ALL);
  return PERMISSIONS.filter(p => p.tab && (all || permissions.includes(p.key))).map(p => p.tab!);
}

export function can(permissions: string[], key: string): boolean {
  return permissions.includes(ALL) || permissions.includes(key);
}

/** The roles a new account starts with. `admin` is fixed; the rest are editable examples. */
export const SEED_ROLES = [
  { key: 'admin', name: 'Admin', permissions: [ALL], builtin: true },
  { key: 'manager', name: 'Manager', permissions: ['units', 'revenue', 'money', 'operations', 'operations.edit',
    'operations.setup', 'repository', 'repository.reveal', 'repository.edit', 'repository.structure',
    'costs', 'claims'], builtin: false },
  { key: 'ops', name: 'Operations', permissions: ['operations', 'operations.edit', 'repository',
    'repository.reveal', 'repository.edit', 'costs', 'claims'], builtin: false }
];
