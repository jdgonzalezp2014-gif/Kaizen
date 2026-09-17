/**
 * Identity, courtesy of Cloudflare Access.
 *
 * There is no auth code in this project and that is the point. Access
 * sits in front of the whole site at the edge: an unauthenticated
 * request never reaches these Functions at all, so every handler can
 * assume a signed-in, allowlisted user.
 *
 * It gives us Google sign-in (which the client asked for), an email
 * allowlist managed in a dashboard rather than in a deploy, and it is
 * free for up to 50 users. Auth.js would have meant a session store, a
 * callback route, secret rotation, and a login page to maintain — all to
 * arrive at the same place.
 *
 * Access forwards the verified identity on every request. `Cf-Access-
 * Authenticated-User-Email` is set by Cloudflare AFTER it validates the
 * JWT, and cannot be spoofed from outside because the request cannot get
 * past Access to be spoofed.
 *
 * LOCAL DEV has no Access in front of it, so the header is absent. That
 * is why the fallback below is a loud placeholder rather than a blank:
 * a row written locally says so in `created_by` instead of pretending to
 * be a real person.
 */
export function userEmail(request: Request): string {
  return request.headers.get('Cf-Access-Authenticated-User-Email') ?? 'local-dev@unauthenticated';
}

export function isLocalDev(request: Request): boolean {
  return !request.headers.get('Cf-Access-Authenticated-User-Email');
}
