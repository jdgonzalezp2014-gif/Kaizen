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

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const who = identify(ctx.request, ctx.env);
  if (!who) return unauthorised();

  // Local dev never has Access in front of it; the opt-out is already
  // explicit in identify(), and re-checking an allow-list against a
  // visibly fake address would only make dev harder for no security.
  if (who.local) return ctx.next();

  let allowed: string[] = [];
  try {
    const sql = db(ctx.env);
    const rows = (await sql`SELECT allowed_emails FROM accounts WHERE id = 1`) as
      { allowed_emails: string[] | null }[];
    allowed = rows[0]?.allowed_emails ?? [];
  } catch {
    // A database that is down must not become an open door. It also must
    // not become a lock-out with no explanation, so this says which it is.
    return Response.json({
      ok: false, error: 'authz_unavailable',
      message: 'Could not check the account allow-list. Refused rather than assumed.'
    }, { status: 503 });
  }

  if (allowed.length === 0) return ctx.next();

  const email = who.email.trim().toLowerCase();
  if (!allowed.some(a => a.trim().toLowerCase() === email)) {
    return Response.json({
      ok: false, error: 'not_on_allowlist',
      message: `${who.email} signed in successfully but is not on this account's allow-list.`
    }, { status: 403 });
  }

  return ctx.next();
};
