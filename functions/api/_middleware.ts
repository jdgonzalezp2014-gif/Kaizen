/**
 * One gate in front of every /api route.
 *
 * Each endpoint still calls `identify()` itself — that is deliberate
 * duplication, so a route stays safe even if this file is ever moved or
 * renamed. What this adds is the second check that no endpoint was
 * doing: whether the person Access vouched for is someone THIS account
 * allows.
 *
 * Why that matters now. With one-time-PIN login the Access policy names
 * the individual addresses, so Access and the app agreed by
 * construction. Point Access at a public identity provider — Google,
 * say — and the policy becomes a rule like "any @gmail.com", which is
 * one careless edit away from "anyone with a Google account". Access
 * decides WHETHER you may reach the app; this decides whether you are
 * one of ours. They are different questions and should not share a
 * single point of failure.
 *
 * Scoped to `functions/api/` on purpose: a middleware at the functions
 * root also intercepts static asset requests, and a 403 there serves a
 * blank page instead of a sign-in.
 *
 * An EMPTY allow-list permits any Access-authenticated caller. That is
 * the deliberate default — turning this on should not lock out the only
 * person who could add themselves to it — and Settings says so.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { mayAccess, type Role } from '../_lib/roles.ts';

/**
 * Routes that carry their own credential and must not be gated on a
 * browser sign-in. Listed explicitly, never pattern-matched: a prefix
 * rule here is one typo away from exempting everything beneath it.
 */
const SELF_AUTHENTICATING = new Set(['/api/observations']);

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (SELF_AUTHENTICATING.has(new URL(ctx.request.url).pathname)) return ctx.next();

  const who = identify(ctx.request, ctx.env);
  if (!who) return unauthorised();

  // Local dev never has Access in front of it; the opt-out is already
  // explicit in identify(), and re-checking an allow-list against a
  // visibly fake address would only make dev harder for no security.
  if (who.local) return ctx.next();

  const email = who.email.trim().toLowerCase();
  let allowed: string[] = [];
  let role: Role = 'owner';
  try {
    const sql = db(ctx.env);
    const [acc, member] = await Promise.all([
      sql`SELECT allowed_emails FROM accounts WHERE id = 1`,
      sql`SELECT role FROM members WHERE account_id = 1 AND email = ${email}`
    ]) as [{ allowed_emails: string[] | null }[], { role: Role }[]];
    allowed = acc[0]?.allowed_emails ?? [];
    // No member row means no role has been assigned. Defaulting to
    // OWNER preserves what everyone had before roles existed — a
    // migration must not quietly take access away — and the allow-list
    // below is still what decides whether they get in at all.
    role = member[0]?.role ?? 'owner';
  } catch {
    // A database that is down must not become an open door. It also must
    // not become a lock-out with no explanation, so this says which it is.
    return Response.json({
      ok: false, error: 'authz_unavailable',
      message: 'Could not check the account allow-list. Refused rather than assumed.'
    }, { status: 503 });
  }

  if (allowed.length > 0 && !allowed.some(a => a.trim().toLowerCase() === email)) {
    return Response.json({
      ok: false, error: 'not_on_allowlist',
      message: `${who.email} signed in successfully but is not on this account's allow-list.`
    }, { status: 403 });
  }

  // The actual access level. Hiding a tab in the browser is a
  // convenience for the person using it; this is the control, because
  // every one of those endpoints is reachable with a URL and a session.
  const url = new URL(ctx.request.url);
  if (!mayAccess(role, url.pathname, ctx.request.method)) {
    return Response.json({
      ok: false, error: 'forbidden',
      message: `Your account records costs and claims. ${url.pathname} is not part of that.`
    }, { status: 403 });
  }

  return ctx.next();
};
