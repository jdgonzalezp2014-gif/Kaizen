/**
 * Who may do what.
 *
 * Enforced HERE, not by hiding tabs. A hidden tab is a convenience for
 * the person using the app; anyone can still call `/api/portfolio`
 * directly, and an access level that lives only in the interface is not
 * an access level at all.
 */
export type Role = 'admin' | 'ops';

/**
 * Routes an `ops` member may reach. Everything not listed is refused.
 *
 * A deny-list would be wrong in the one way that matters: a route added
 * next month would be reachable by everyone until somebody remembered
 * to add it. This way, a new route is closed until it is deliberately
 * opened.
 */
const OPS_ALLOWED: { path: string; methods: string[] }[] = [
  { path: '/api/expenses', methods: ['GET', 'POST', 'DELETE'] },
  { path: '/api/claims',   methods: ['GET', 'POST', 'DELETE'] },
  // Needed to attach a cost or a claim to a unit — names and ids only.
  { path: '/api/units',    methods: ['GET'] },
  // Their own work, and the money in it is cost data they already record.
  { path: '/api/cleaning-log', methods: ['GET'] },
  // Their own identity and role. The response is trimmed for ops; see
  // settings.ts.
  { path: '/api/settings', methods: ['GET'] }
];

export function mayAccess(role: Role, pathname: string, method: string): boolean {
  if (role === 'admin') return true;
  const rule = OPS_ALLOWED.find(r => r.path === pathname);
  return !!rule && rule.methods.includes(method.toUpperCase());
}

/** What the browser needs to decide which tabs to draw. */
export function tabsFor(role: Role): string[] {
  return role === 'admin'
    ? ['units', 'revenue', 'costs', 'claims', 'settings']
    : ['costs', 'claims'];
}
