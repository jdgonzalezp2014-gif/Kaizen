/**
 * Paying cleaners and handymen (owner, 2026-10-25): Stripe Connect, test keys first.
 *
 *  - Kaizen is the platform: its secret key (Settings → Payments, encrypted)
 *    holds the balance the invoices are paid from.
 *  - Each payee gets an Express connected account the first time the team
 *    asks for their setup link. The payee opens the link (WhatsApp / SMS — the
 *    team sends it), gives Stripe their bank and tax details, and Stripe pays
 *    their bank. Kaizen never sees a bank number.
 *  - Stripe's onboarding links last minutes, so the link the team sends is
 *    Kaizen's own (`/api/report-link?stripe=<signed>`, already public): each
 *    open asks Stripe for a fresh one and redirects.
 *  - Paying an invoice = one transfer to the payee's account, idempotent on
 *    the invoice number and amount, then one `payouts` row. Or "Mark paid"
 *    for cash / Zelle / check — the same row, method 'manual'.
 * A key's mode (test / live) is kept with each connected account: a test
 * account is never paid with a live key, nor the other way.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import { stripeMode, toCents, type Payout } from '../../src/lib/payouts.ts';

export type PayeeKind = 'cleaner' | 'vendor';

const row = (r: Record<string, unknown>): Payout => ({
  id: String(r.id), invoiceNumber: String(r.invoice_number), amount: Number(r.amount), method: r.method as Payout['method'],
  stripeMode: (r.stripe_mode ?? null) as Payout['stripeMode'], transferId: (r.stripe_transfer_id ?? null) as string | null,
  note: (r.note ?? null) as string | null, by: String(r.created_by), at: String(r.at)
});

export async function payoutOf(sql: SqlFn, invoiceNumber: string): Promise<Payout | null> {
  const [r] = await sql`SELECT *, to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS at
                          FROM payouts WHERE account_id = 1 AND invoice_number = ${invoiceNumber}` as Record<string, unknown>[];
  return r ? row(r) : null;
}

/* ── Stripe ───────────────────────────────────────────────────────── */

export async function stripeKey(sql: SqlFn, encryptionKey: string): Promise<{ key: string; mode: 'test' | 'live' } | null> {
  const [a] = await sql`SELECT stripe_secret_key_enc FROM accounts WHERE id = 1` as { stripe_secret_key_enc: string | null }[];
  if (!a?.stripe_secret_key_enc) return null;
  const key = await decrypt(a.stripe_secret_key_enc, encryptionKey);
  const mode = stripeMode(key);
  return mode ? { key, mode } : null;
}

/** One Stripe call, form-encoded as its API wants. Throws Stripe's own message. */
export async function stripeCall<T>(key: string, method: 'GET' | 'POST', path: string,
                                    params: Record<string, string | number | boolean | undefined | null> = {}, idempotencyKey?: string): Promise<T> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && [...form].length ? `?${form}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded',
               ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: method === 'POST' ? form : undefined
  });
  const j = await res.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !j) throw new Error(`Stripe: ${j?.error?.message ?? `HTTP ${res.status}`}`);
  return j;
}

/** The platform's balance in dollars — what can be paid out now. */
export async function platformBalance(key: string): Promise<{ available: number; pending: number }> {
  const b = await stripeCall<{ available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[] }>(key, 'GET', '/balance');
  const usd = (l: { amount: number; currency: string }[]) => l.filter(x => x.currency === 'usd').reduce((a, x) => a + x.amount, 0) / 100;
  return { available: usd(b.available), pending: usd(b.pending) };
}

/* ── payees ───────────────────────────────────────────────────────── */

export interface Payee { kind: PayeeKind; name: string; email: string | null; account: string | null; mode: string | null }

export async function payeeOf(sql: SqlFn, kind: PayeeKind, name: string): Promise<Payee | null> {
  const [p] = kind === 'cleaner'
    ? await sql`SELECT name, email, stripe_account_id AS account, stripe_mode AS mode FROM cleaners WHERE account_id = 1 AND name = ${name}` as Payee[]
    : await sql`SELECT name, email, stripe_account_id AS account, stripe_mode AS mode FROM vendors WHERE account_id = 1 AND lower(name) = lower(btrim(${name}))` as Payee[];
  return p ? { ...p, kind } : null;
}

/** A name typed on a work order joins the directory the first time it needs a row of its own (its period, its Stripe account). */
export async function ensureVendor(sql: SqlFn, name: string): Promise<string> {
  const n = name.trim().slice(0, 120);
  await sql`INSERT INTO vendors (account_id, name, notes) VALUES (1, ${n}, 'Added from Operations → Handymen (a name typed on a work order).')
            ON CONFLICT (account_id, lower(name)) DO NOTHING`;
  const [v] = await sql`SELECT name FROM vendors WHERE account_id = 1 AND lower(name) = lower(${n})` as { name: string }[];
  return v!.name;
}

export interface AccountState { id: string; ready: boolean; detailsSubmitted: boolean; payoutsEnabled: boolean; transfers: string; due: string[] }

export async function accountState(key: string, account: string): Promise<AccountState> {
  const a = await stripeCall<{ id: string; details_submitted: boolean; payouts_enabled: boolean;
                               capabilities?: { transfers?: string }; requirements?: { currently_due?: string[] } }>(key, 'GET', `/accounts/${encodeURIComponent(account)}`);
  const transfers = a.capabilities?.transfers ?? 'inactive';
  return { id: a.id, ready: transfers === 'active' && a.payouts_enabled, detailsSubmitted: a.details_submitted,
           payoutsEnabled: a.payouts_enabled, transfers, due: a.requirements?.currently_due ?? [] };
}

/** The payee's connected account in this key's mode — made now if they have none (or only one of the other mode). */
export async function connectAccount(sql: SqlFn, s: { key: string; mode: string }, p: Payee): Promise<string> {
  if (p.account && p.mode === s.mode) return p.account;
  const a = await stripeCall<{ id: string }>(s.key, 'POST', '/accounts', {
    type: 'express', country: 'US', business_type: 'individual', email: p.email ?? undefined,
    'capabilities[transfers][requested]': true,
    'metadata[kaizen_kind]': p.kind, 'metadata[kaizen_payee]': p.name
  }, `kaizen-acct-${s.mode}-${p.kind}-${p.name.toLowerCase()}`);
  if (p.kind === 'cleaner') await sql`UPDATE cleaners SET stripe_account_id = ${a.id}, stripe_mode = ${s.mode} WHERE account_id = 1 AND name = ${p.name}`;
  else await sql`UPDATE vendors SET stripe_account_id = ${a.id}, stripe_mode = ${s.mode} WHERE account_id = 1 AND lower(name) = lower(${p.name})`;
  return a.id;
}

/** Stripe's own onboarding page — single use, minutes long; Kaizen's link asks for a new one on each open. */
export async function onboardingUrl(key: string, account: string, back: string): Promise<string> {
  const l = await stripeCall<{ url: string }>(key, 'POST', '/account_links', {
    account, type: 'account_onboarding', refresh_url: back, return_url: `${back}&done=1`
  });
  return l.url;
}

/* ── the link the team sends: signed, no table ────────────────────── */

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function hmac(encryptionKey: string, text: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', unb64u(encryptionKey.replace(/=+$/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`stripe-onboard:${text}`)));
}
/** Good for 30 days; it only ever opens Stripe's form for that payee's own account. */
export async function signPayee(encryptionKey: string, kind: PayeeKind, name: string, now = Date.now()): Promise<string> {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ k: kind, n: name, e: Math.floor(now / 1000) + 30 * 86400 })));
  return `${body}.${b64u(await hmac(encryptionKey, body))}`;
}
export async function verifyPayee(encryptionKey: string, token: string, now = Date.now()): Promise<{ kind: PayeeKind; name: string } | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64u(await hmac(encryptionKey, body));
  if (want.length !== sig.length || [...want].reduce((d, c, i) => d | (c.charCodeAt(0) ^ sig.charCodeAt(i)), 0) !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body))) as { k: string; n: string; e: number };
    if (p.e * 1000 < now || (p.k !== 'cleaner' && p.k !== 'vendor') || !p.n) return null;
    return { kind: p.k, name: p.n };
  } catch { return null; }
}

/* ── paying ───────────────────────────────────────────────────────── */

export interface ToPay { kind: PayeeKind; name: string; number: string; from: string; to: string; total: number }

/**
 * Pays an invoice the caller has just rebuilt on the server (never an amount from the browser).
 * Stripe: a transfer to the payee's ready account. Manual: only the record. Throws a plain message.
 */
export async function payInvoice(sql: SqlFn, encryptionKey: string, inv: ToPay, method: 'stripe' | 'manual', note: string | null, by: string): Promise<Payout> {
  if (await payoutOf(sql, inv.number)) throw new Error('This invoice is already paid — reload.');
  let mode: string | null = null, transfer: string | null = null;
  if (method === 'stripe') {
    const s = await stripeKey(sql, encryptionKey);
    if (!s) throw new Error('Stripe is not set up — add the secret key in Settings → Payments.');
    const p = await payeeOf(sql, inv.kind, inv.name);
    if (!p?.account || p.mode !== s.mode) throw new Error(`${inv.name} has no Stripe account in ${s.mode} mode yet — send them the setup link first.`);
    const st = await accountState(s.key, p.account);
    if (!st.ready) throw new Error(`${inv.name}'s Stripe setup is not finished (${st.due.length ? `missing: ${st.due.slice(0, 3).join(', ')}` : 'transfers not active yet'}).`);
    const t = await stripeCall<{ id: string }>(s.key, 'POST', '/transfers', {
      amount: toCents(inv.total), currency: 'usd', destination: p.account, description: `Kaizen invoice ${inv.number} — ${inv.name}`,
      transfer_group: inv.number, 'metadata[invoice]': inv.number, 'metadata[period]': `${inv.from}..${inv.to}`
    }, `kaizen-pay-${inv.number}-${toCents(inv.total)}`);
    mode = s.mode; transfer = t.id;
  }
  const [r] = await sql`INSERT INTO payouts (account_id, payee_kind, payee, invoice_number, period_from, period_to, amount, method, stripe_mode, stripe_transfer_id, note, created_by)
                        VALUES (1, ${inv.kind}, ${inv.name}, ${inv.number}, ${inv.from}, ${inv.to}, ${inv.total}, ${method}, ${mode}, ${transfer}, ${note}, ${by})
                        ON CONFLICT (account_id, invoice_number) DO NOTHING RETURNING id` as { id: string }[];
  // Two clicks at once: Stripe's idempotency gave both the same transfer; the second row is the one refused.
  if (!r) throw new Error('This invoice is already paid — reload.');
  return (await payoutOf(sql, inv.number))!;
}

/** Only a payout marked by hand can be taken back here; a Stripe transfer is reversed in Stripe. */
export async function undoPayout(sql: SqlFn, id: string): Promise<void> {
  const done = await sql`DELETE FROM payouts WHERE account_id = 1 AND id = ${Number(id) || 0} AND method = 'manual' RETURNING id`;
  if (!done.length) throw new Error('Only a payment marked by hand can be undone here — a Stripe transfer is reversed in Stripe’s dashboard.');
}

/* ── the payee opens the link ─────────────────────────────────────── */

const esc = (t: string) => t.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kaizen — ${title}</title>` +
  `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 16px"><h1 style="font-size:1.3rem">${title}</h1>${body}</body>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

/**
 * `GET /api/report-link?stripe=<signed>[&done=1]` — public (the door already behind Access's bypass).
 * Each open asks Stripe for a fresh onboarding page for that payee's own account and redirects;
 * Stripe sends them back with `done=1` and the page says what is left, in English and Spanish.
 */
export async function stripeOnboard(sql: SqlFn, encryptionKey: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const p = await verifyPayee(encryptionKey, url.searchParams.get('stripe') ?? '');
  if (!p) return page('Link not valid / Enlace no válido', '<p>Ask Kaizen for a new link.<br>Pide a Kaizen un enlace nuevo.</p>', 403);
  const s = await stripeKey(sql, encryptionKey);
  const payee = await payeeOf(sql, p.kind, p.name);
  if (!s || !payee?.account || payee.mode !== s.mode) return page('Link not valid / Enlace no válido', '<p>Ask Kaizen for a new link.<br>Pide a Kaizen un enlace nuevo.</p>', 410);
  try {
    if (url.searchParams.get('done') === '1') {
      const st = await accountState(s.key, payee.account);
      return st.ready
        ? page('You are set / Listo', `<p>Thanks, ${esc(payee.name)}. Kaizen can pay you now — Stripe sends it to your bank.</p><p>Gracias, ${esc(payee.name)}. Kaizen ya puede pagarte — Stripe lo envía a tu banco.</p>`)
        : page('Almost there / Casi listo', `<p>Stripe still needs a few details.<br>Stripe aún necesita algunos datos.</p><p><a href="${url.pathname}?stripe=${encodeURIComponent(url.searchParams.get('stripe')!)}">Continue / Continuar</a></p>`);
    }
    const back = `${url.origin}${url.pathname}?stripe=${encodeURIComponent(url.searchParams.get('stripe')!)}`;
    return Response.redirect(await onboardingUrl(s.key, payee.account, back), 303);
  } catch {
    return page('Try again later / Intenta más tarde', '<p>Stripe did not answer. / Stripe no respondió.</p>', 502);
  }
}
