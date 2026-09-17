/**
 * Identity, courtesy of Cloudflare Access.
 *
 * Access sits in front of the app at the edge, so an authenticated
 * request arrives carrying `Cf-Access-Authenticated-User-Email`, set by
 * Cloudflare AFTER it validates the JWT. It cannot be spoofed from
 * outside, because a spoofed request never gets past Access to be
 * spoofed.
 *
 * THIS FAILS CLOSED, and an earlier version did not. It used to fall
 * back to a placeholder email when the header was absent, on the
 * assumption that Access would always be in front. It was not — the app
 * was deployed before Access was configured, and every endpoint answered
 * the open internet with live account data. An unauthenticated `curl`
 * returned the account row, the Hostaway account id, and would have
 * accepted writes.
 *
 * The lesson is the ordering, not the header: a permission check whose
 * failure mode is "allow" is not a permission check. Missing identity is
 * now a refusal, and local development has to opt out explicitly through
 * an environment variable that production never sets.
 */
export interface AuthEnv {
  /** Set ONLY in local dev (.dev.vars). Never in Cloudflare. */
  ALLOW_UNAUTHENTICATED?: string;
}

export interface Identity { email: string; local: boolean }

export function identify(request: Request, env: AuthEnv): Identity | null {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (email) return { email, local: false };

  // `wrangler pages dev` has no Access in front of it. The opt-out is
  // explicit and the resulting identity is visibly fake, so a row written
  // in dev says so in created_by rather than impersonating anyone.
  if (env.ALLOW_UNAUTHENTICATED === 'true') {
    return { email: 'local-dev@unauthenticated', local: true };
  }
  return null;
}

/** The 403 every route returns when Access has not vouched for the caller. */
export function unauthorised(): Response {
  return Response.json({
    ok: false,
    error: 'unauthenticated',
    message:
      'This deployment is not protected by Cloudflare Access, or you are not signed in. ' +
      'Configure Access for this hostname before using it.'
  }, { status: 403 });
}
