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
  { key: 'operations', label: 'Operations — see the board, the cleanings calendar, inspections and notes', tab: 'operations', routes: [
    { path: '/api/operations', methods: ['GET'] },
    // The crew pages as each cleaner sees them, and what is waiting on the team (§122).
    { path: '/api/crew-admin', methods: ['GET'] },
    // A handyman's page for the team, as a cleaner's (owner, 2026-10-25).
    { path: '/api/vendor-admin', methods: ['GET'] },
    // Inspections as a checklist, its template, and the vendor directory (§133).
    { path: '/api/inspection-run', methods: ['GET'] }, { path: '/api/inspection-items', methods: ['GET'] },
    { path: '/api/vendors', methods: ['GET'] },
    // Supplies per unit and in storage (§134).
    { path: '/api/inventory', methods: ['GET'] },
    // The cleanings calendar lives in Operations; it reads the record.
    { path: '/api/cleaning-log', methods: ['GET'] }] },
  { key: 'operations.edit', label: 'Operations — assign cleaners, times, notes, log inspections', routes: [
    { path: '/api/turnover', methods: ['POST'] }, { path: '/api/inspections', methods: ['POST', 'DELETE'] },
    { path: '/api/manual-clean', methods: ['GET', 'POST'] }, { path: '/api/stays', methods: ['GET'] },
    // Approve or deny a cleaner's extra, flag a clean (§122).
    { path: '/api/crew-admin', methods: ['POST'] },
    // Flag, correct, not paid, add a job on a handyman's page (owner, 2026-10-25).
    { path: '/api/vendor-admin', methods: ['POST'] },
    // Walk an inspection: answers, photos, and the work it makes (§133).
    { path: '/api/inspection-run', methods: ['POST'] },
    // Counts, moves and orders of supplies (§134).
    { path: '/api/inventory', methods: ['POST'] }] },
  { key: 'operations.setup', label: 'Operations — roster, pay, rules and the live switch', routes: [
    { path: '/api/ops-settings', methods: ['GET', 'POST'] },
    // The inspection checklist and the vendor directory (§133).
    { path: '/api/inspection-items', methods: ['POST'] }, { path: '/api/vendors', methods: ['POST'] },
    // The supplies catalog (§134).
    { path: '/api/inventory-items', methods: ['POST'] }] },
  { key: 'todos', label: 'To-do list — see, add and tick off the team\'s to-dos', routes: [
    { path: '/api/todos', methods: ['GET', 'POST'] }, { path: '/api/stays', methods: ['GET'] },
    // A to-do's files (owner, Oct 2026).
    { path: '/api/todo-files', methods: ['GET', 'POST'] },
    // A photo inside a comment (§162).
    { path: '/api/comment-image', methods: ['GET'] },
    // A repair's vendor is picked from the directory (§133).
    { path: '/api/vendors', methods: ['GET'] }] },
  { key: 'guests.documents', label: 'Guest documents — see and upload IDs and rental agreements', routes: [
    { path: '/api/guest-docs', methods: ['POST'] }, { path: '/api/guest-docs-upload', methods: ['POST'] }] },
  { key: 'repository', label: 'Repository — look up records and documents', tab: 'repository', routes: [
    { path: '/api/repository', methods: ['GET'] }, { path: '/api/repository-check', methods: ['GET'] }] },
  { key: 'repository.reveal', label: 'Repository — reveal passwords (each reveal is logged)', routes: [
    { path: '/api/repository-reveal', methods: ['POST'] }] },
  { key: 'repository.edit', label: 'Repository — add and edit records, upload and remove documents', routes: [
    { path: '/api/repository-edit', methods: ['POST'] }, { path: '/api/repository-upload', methods: ['POST'] },
    { path: '/api/repository-check', methods: ['POST'] }] },
  { key: 'repository.structure', label: 'Repository — sections, tables and columns', routes: [
    { path: '/api/repository-structure', methods: ['POST'] }, { path: '/api/repository-import', methods: ['POST'] }] },
  { key: 'costs', label: 'Costs — record expenses, see cleaning costs', tab: 'costs', routes: [
    { path: '/api/expenses', methods: ['GET', 'POST', 'DELETE'] }, { path: '/api/cleaning-log', methods: ['GET'] }] },
  // Owner, 2026-10-25: money leaves Kaizen — its own permission, not part of Operations' edits.
  { key: 'payouts', label: 'Payouts — pay cleaners\' and handymen\'s invoices (Stripe) or mark them paid', routes: [
    { path: '/api/payouts', methods: ['GET', 'POST'] }] },
  // §162: the cases are followed in Operations → To-do (Claims & upselling tab); their money is Finance's, below.
  { key: 'claims', label: 'Claims & upselling — record and follow guest claims and upsells (no figures)', routes: [
    { path: '/api/claims', methods: ['GET', 'POST', 'DELETE'] }, { path: '/api/stays', methods: ['GET'] },
    { path: '/api/comment-image', methods: ['GET'] }] },
  { key: 'claims.money', label: 'Claims & upselling — money: requested, received, upsell revenue (Revenue tab)', routes: [
    { path: '/api/claims-money', methods: ['GET', 'POST'] }] },
  // SOPs (§92): the library tab, and each screen's "SOPs" button. Drafts are for editors only.
  { key: 'sops', label: 'SOPs — read the procedures and articles', tab: 'sops', routes: [
    { path: '/api/sops', methods: ['GET'] }] },
  { key: 'sops.edit', label: 'SOPs — write, publish, review and archive procedures and sections', routes: [
    { path: '/api/sops', methods: ['POST'] }] },
  { key: 'settings', label: 'Settings — credentials, members, roles, integrations', tab: 'settings', routes: [
    { path: '/api/settings', methods: ['POST'] }, { path: '/api/roles', methods: ['GET', 'POST', 'DELETE'] },
    { path: '/api/sync-units', methods: ['POST'] }, { path: '/api/import', methods: ['POST'] },
    { path: '/api/cleanings', methods: ['POST'] }, { path: '/api/feed', methods: ['POST'] },
    { path: '/api/cron', methods: ['POST'] }, { path: '/api/units', methods: ['POST'] },
    { path: '/api/google-drive', methods: ['GET', 'POST'] }, { path: '/api/google-callback', methods: ['GET'] },
    { path: '/api/slack-settings', methods: ['GET', 'POST'] }] }
];

/** The permission that means "everything", held by the admin role only. */
export const ALL = '*';
/**
 * A cleaner's own page (§122). Not in PERMISSIONS, so no role can be given
 * it: only a roster email earns it (accessOf), and it opens nothing else —
 * not even the routes every member reaches.
 */
export const CREW = 'crew';
const CREW_ROUTES = [{ path: '/api/crew', methods: ['GET', 'POST'] }, { path: '/api/settings', methods: ['GET'] }];
/** A handyman's own work orders (§137): only an email in the vendor directory earns it, like a cleaner's page. */
export const VENDOR = 'vendor';
const VENDOR_ROUTES = [{ path: '/api/vendor', methods: ['GET', 'POST'] }, { path: '/api/settings', methods: ['GET'] }];

/**
 * Routes every signed-in member reaches: who they are and which tabs to
 * draw, and the unit names every form needs. Nothing here describes the
 * business beyond a list of apartments.
 */
const ALWAYS: { path: string; methods: string[] }[] = [
  { path: '/api/settings', methods: ['GET'] },
  { path: '/api/units', methods: ['GET'] },
  // Reports (owner, 2026-10-15): anyone reports a bug or asks for something; the handler limits who sees all.
  { path: '/api/reports', methods: ['GET', 'POST'] }
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

export function mayAccess(permissions: string[], pathname: string, method: string): boolean {
  if (permissions.includes(ALL)) return true;
  const m = method.toUpperCase();
  const hit = (r: { path: string; methods: string[] }) => r.path === pathname && r.methods.includes(m);
  if (permissions.includes(CREW)) return CREW_ROUTES.some(hit);
  if (permissions.includes(VENDOR)) return VENDOR_ROUTES.some(hit);
  if (ALWAYS.some(hit)) return true;
  return PERMISSIONS.some(p => permissions.includes(p.key) && p.routes.some(hit));
}

/**
 * Tabs to draw, in the app's order. The same module decides routes and
 * tabs, so they cannot drift. Home is everyone's: it opens no route of
 * its own and shows only the parts of the day the role can already see.
 */
export function tabsFor(permissions: string[]): string[] {
  const all = permissions.includes(ALL);
  if (!all && permissions.includes(CREW)) return ['crew'];
  if (!all && permissions.includes(VENDOR)) return ['vendor'];
  return ['home', ...PERMISSIONS.filter(p => p.tab && (all || permissions.includes(p.key))).map(p => p.tab!)];
}

export function can(permissions: string[], key: string): boolean {
  return permissions.includes(ALL) || permissions.includes(key);
}

/** The roles a new account starts with. `admin` is fixed; the rest are editable examples. */
export const SEED_ROLES = [
  { key: 'admin', name: 'Admin', permissions: [ALL], builtin: true },
  { key: 'manager', name: 'Manager', permissions: ['units', 'revenue', 'money', 'operations', 'operations.edit',
    'operations.setup', 'repository', 'repository.reveal', 'repository.edit', 'repository.structure',
    'costs', 'claims', 'sops', 'sops.edit'], builtin: false },
  { key: 'ops', name: 'Operations', permissions: ['operations', 'operations.edit', 'repository',
    'repository.reveal', 'repository.edit', 'costs', 'claims', 'sops'], builtin: false }
];
