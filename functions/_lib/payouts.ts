/**
 * Paying cleaners and handymen through Wise (owner, 2026-10-28 — Stripe Connect asked too much of each payee).
 *
 *  - Kaizen's Wise business profile pays from its USD balance. The token and
 *    the environment (sandbox / live) are in Settings → Payments, encrypted.
 *  - Moving money from the balance must be signed (Wise's strong customer
 *    authentication): Wise answers 403 with a one-time token, Kaizen signs it
 *    with its private key and repeats the call. The owner uploads the public
 *    key to Wise once (API tokens → Manage public keys).
 *  - Each payee types their own bank (routing + account) on Kaizen's link
 *    (`/api/report-link?bank=<signed>`, the public door already open). Kaizen
 *    hands it to Wise as a recipient and keeps only its id and the last 4.
 *    Wise cannot pay a recipient known only by email through the API (tried
 *    in the sandbox, 2026-10-28), so the bank is asked for once.
 *  - Paying an invoice = quote → transfer (its id derived from the invoice
 *    and amount, so a retry finds the same one) → paid from the balance → one
 *    `payouts` row. Or "Mark paid" for cash / Zelle / check, method 'manual'.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import { sha256 } from './crew.ts';
import { routingValid, accountNumberValid, toCents, transferUuid, WISE_FINAL, type Payout, type WiseEnv } from '../../src/lib/payouts.ts';

export type PayeeKind = 'cleaner' | 'vendor';

const row = (r: Record<string, unknown>): Payout => ({
  id: String(r.id), invoiceNumber: String(r.invoice_number), amount: Number(r.amount), method: r.method as Payout['method'],
  env: (r.wise_env ?? null) as WiseEnv | null, transferId: r.wise_transfer_id == null ? null : String(r.wise_transfer_id),
  status: (r.wise_status ?? null) as string | null, fee: r.fee == null ? null : Number(r.fee),
  note: (r.note ?? null) as string | null, by: String(r.created_by), at: String(r.at)
});

export async function payoutOf(sql: SqlFn, invoiceNumber: string): Promise<Payout | null> {
  const [r] = await sql`SELECT *, to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS at
                          FROM payouts WHERE account_id = 1 AND invoice_number = ${invoiceNumber}` as Record<string, unknown>[];
  return r ? row(r) : null;
}

/* ── Wise ─────────────────────────────────────────────────────────── */

const HOST: Record<WiseEnv, string> = { sandbox: 'https://api.wise-sandbox.com', live: 'https://api.wise.com' };

export interface Wise { token: string; env: WiseEnv; profile: number | null; privateKey: string | null }

export async function wiseOf(sql: SqlFn, encryptionKey: string): Promise<Wise | null> {
  const [a] = await sql`SELECT wise_token_enc, wise_env, wise_profile_id, wise_private_key_enc FROM accounts WHERE id = 1` as
    { wise_token_enc: string | null; wise_env: WiseEnv | null; wise_profile_id: string | null; wise_private_key_enc: string | null }[];
  if (!a?.wise_token_enc || !a.wise_env) return null;
  return { token: await decrypt(a.wise_token_enc, encryptionKey), env: a.wise_env, profile: a.wise_profile_id ? Number(a.wise_profile_id) : null,
           privateKey: a.wise_private_key_enc ? await decrypt(a.wise_private_key_enc, encryptionKey) : null };
}

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** A new key pair for signing: the private half (PKCS#8, base64) stays with Kaizen, the public half (PEM) goes to Wise. */
export async function newKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const k = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
                                            true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = b64(await crypto.subtle.exportKey('spki', k.publicKey) as ArrayBuffer);
  return { privateKey: b64(await crypto.subtle.exportKey('pkcs8', k.privateKey) as ArrayBuffer),
           publicKey: `-----BEGIN PUBLIC KEY-----\n${pub.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n` };
}

async function sign(privateKey: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(privateKey), c => c.charCodeAt(0)),
                                          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(text)));
}

/** Wise's own words for a refusal, from whichever of its error shapes came back. */
function wiseError(j: unknown, status: number): string {
  const e = j as { errors?: { message?: string }[]; message?: string; error?: string; errorCode?: string } | null;
  if (e?.errorCode === 'balance.payment-option-unavailable') return 'the Wise USD balance does not cover it — add money in Wise first';
  return e?.errors?.[0]?.message ?? e?.message ?? e?.errorCode ?? e?.error ?? `HTTP ${status}`;
}

/** One Wise call. A 403 that asks for a signature is signed and sent again, once. Throws Wise's own message. */
export async function wiseCall<T>(w: Wise, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const send = (extra: Record<string, string> = {}) => fetch(HOST[w.env] + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json', ...extra } });
  let res = await send();
  const ott = res.headers.get('x-2fa-approval');
  if (res.status === 403 && ott) {
    if (!w.privateKey) throw new Error('Wise asks for a signature — make the key in Settings → Payments and upload it to Wise.');
    res = await send({ 'x-2fa-approval': ott, 'X-Signature': await sign(w.privateKey, ott) });
    if (res.status === 403) throw new Error('Wise refused the signature — upload Kaizen\'s public key (Settings → Payments) in Wise → API tokens → Manage public keys.');
  }
  const text = await res.text();
  let j: unknown = null; try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`Wise: ${wiseError(j, res.status)}`);
  return j as T;
}

export interface Profile { id: number; name: string; country: string | null }

/** The business profiles this token reaches — Kaizen pays from one of them. */
export async function businessProfiles(w: Wise): Promise<Profile[]> {
  const ps = await wiseCall<{ id: number; type: string; businessName?: string; fullName?: string; address?: { countryIso2Code?: string } }[]>(w, 'GET', '/v2/profiles');
  return ps.filter(p => p.type?.toUpperCase() === 'BUSINESS')
           .map(p => ({ id: p.id, name: p.businessName ?? p.fullName ?? String(p.id), country: p.address?.countryIso2Code ?? null }));
}

/** What the USD balance holds now — what can be paid out. */
export async function usdBalance(w: Wise): Promise<number> {
  const bs = await wiseCall<{ currency: string; amount: { value: number } }[]>(w, 'GET', `/v4/profiles/${w.profile}/balances?types=STANDARD`);
  return bs.find(b => b.currency === 'USD')?.amount.value ?? 0;
}

/* ── payees ───────────────────────────────────────────────────────── */

export interface Payee { kind: PayeeKind; name: string; email: string | null; recipient: string | null; env: string | null; last4: string | null }

export async function payeeOf(sql: SqlFn, kind: PayeeKind, name: string): Promise<Payee | null> {
  const [p] = kind === 'cleaner'
    ? await sql`SELECT name, email, wise_recipient_id::text AS recipient, wise_env AS env, bank_last4 AS last4 FROM cleaners WHERE account_id = 1 AND name = ${name}` as Payee[]
    : await sql`SELECT name, email, wise_recipient_id::text AS recipient, wise_env AS env, bank_last4 AS last4 FROM vendors WHERE account_id = 1 AND lower(name) = lower(btrim(${name}))` as Payee[];
  return p ? { ...p, kind } : null;
}

/** A name typed on a work order joins the directory the first time it needs a row of its own (its period, its bank). */
export async function ensureVendor(sql: SqlFn, name: string): Promise<string> {
  const n = name.trim().slice(0, 120);
  await sql`INSERT INTO vendors (account_id, name, notes) VALUES (1, ${n}, 'Added from Operations → Handymen (a name typed on a work order).')
            ON CONFLICT (account_id, lower(name)) DO NOTHING`;
  const [v] = await sql`SELECT name FROM vendors WHERE account_id = 1 AND lower(name) = lower(${n})` as { name: string }[];
  return v!.name;
}

export interface Bank { holder: string; routing: string; account: string; type: 'CHECKING' | 'SAVINGS'; line: string; city: string; state: string; zip: string }

/** What is wrong with a bank form, in both languages; empty = fine. */
export function bankProblems(b: Bank): string[] {
  const out: string[] = [];
  if (b.holder.trim().split(/\s+/).length < 2) out.push('Full name, first and last. / Nombre completo, nombre y apellido.');
  if (!routingValid(b.routing)) out.push('The routing number is 9 digits — check it. / El routing number tiene 9 dígitos — revísalo.');
  if (!accountNumberValid(b.account)) out.push('The account number is 4 to 17 digits. / El número de cuenta tiene de 4 a 17 dígitos.');
  if (!b.line.trim() || !b.city.trim() || !/^[A-Z]{2}$/.test(b.state) || !/^\d{5}$/.test(b.zip)) out.push('Your address: street, city, state (TX) and ZIP. / Tu dirección: calle, ciudad, estado (TX) y ZIP.');
  return out;
}

/** The payee's bank becomes a Wise recipient; the one before it is closed. Kaizen keeps the id and the last 4 digits only. */
export async function saveBank(sql: SqlFn, w: Wise, p: Payee, b: Bank): Promise<string> {
  const r = await wiseCall<{ id: number }>(w, 'POST', '/v1/accounts', {
    profile: w.profile, accountHolderName: b.holder.trim(), currency: 'USD', type: 'aba',
    details: { legalType: 'PRIVATE', ...(p.email ? { email: p.email } : {}), abartn: b.routing, accountNumber: b.account, accountType: b.type,
               address: { country: 'US', state: b.state, city: b.city.trim(), postCode: b.zip, firstLine: b.line.trim() } } });
  const last4 = b.account.slice(-4);
  if (p.kind === 'cleaner') await sql`UPDATE cleaners SET wise_recipient_id = ${r.id}, wise_env = ${w.env}, bank_last4 = ${last4} WHERE account_id = 1 AND name = ${p.name}`;
  else await sql`UPDATE vendors SET wise_recipient_id = ${r.id}, wise_env = ${w.env}, bank_last4 = ${last4} WHERE account_id = 1 AND lower(name) = lower(${p.name})`;
  if (p.recipient && p.env === w.env && p.recipient !== String(r.id)) await wiseCall(w, 'DELETE', `/v1/accounts/${p.recipient}`).catch(() => null);
  return last4;
}

/* ── the link the team sends: signed, no table ────────────────────── */

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function hmac(encryptionKey: string, text: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', unb64u(encryptionKey.replace(/=+$/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`bank-form:${text}`)));
}
/** Good for 30 days; it only ever saves that payee's own bank. */
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
 * Wise: quote → transfer → paid from the balance. Manual: only the record. Throws a plain message.
 */
export async function payInvoice(sql: SqlFn, encryptionKey: string, inv: ToPay, method: 'wise' | 'manual', note: string | null, by: string): Promise<Payout> {
  if (await payoutOf(sql, inv.number)) throw new Error('This invoice is already paid — reload.');
  let env: string | null = null, transfer: number | null = null, status: string | null = null, fee: number | null = null;
  if (method === 'wise') {
    const w = await wiseOf(sql, encryptionKey);
    if (!w?.profile) throw new Error('Wise is not set up — Settings → Payments.');
    const p = await payeeOf(sql, inv.kind, inv.name);
    if (!p?.recipient || p.env !== w.env) throw new Error(`${inv.name} has no bank on file${w.env === 'sandbox' ? ' in the sandbox' : ''} yet — send them the bank link first.`);
    const q = await wiseCall<{ id: string; payOut: string; paymentOptions?: { payIn: string; payOut: string; fee?: { total?: number } }[] }>(
      w, 'POST', `/v3/profiles/${w.profile}/quotes`, { sourceCurrency: 'USD', targetCurrency: 'USD', targetAmount: inv.total, targetAccount: Number(p.recipient) });
    fee = q.paymentOptions?.find(o => o.payIn === 'BALANCE' && o.payOut === q.payOut)?.fee?.total ?? null;
    // Same invoice, same amount → same id: Wise hands back the transfer it already made instead of a second one.
    const t = await wiseCall<{ id: number; status: string }>(w, 'POST', '/v1/transfers', {
      targetAccount: Number(p.recipient), quoteUuid: q.id,
      customerTransactionId: transferUuid(await sha256(`${w.env}:${inv.number}:${toCents(inv.total)}`)),
      details: { reference: inv.number.slice(0, 35) } });
    if (t.status === 'incoming_payment_waiting') {
      try { await wiseCall(w, 'POST', `/v3/profiles/${w.profile}/transfers/${t.id}/payments`, { type: 'BALANCE' }); }
      catch (e) {
        // A retry of a transfer already paid: Wise says invalid state, and the transfer has moved on — that is fine.
        const now = await wiseCall<{ status: string }>(w, 'GET', `/v1/transfers/${t.id}`).catch(() => null);
        if (!now || now.status === 'incoming_payment_waiting') throw e;
      }
    }
    status = (await wiseCall<{ status: string }>(w, 'GET', `/v1/transfers/${t.id}`).catch(() => ({ status: t.status }))).status;
    env = w.env; transfer = t.id;
  }
  const [r] = await sql`INSERT INTO payouts (account_id, payee_kind, payee, invoice_number, period_from, period_to, amount, method, wise_env, wise_transfer_id, wise_status, fee, note, created_by)
                        VALUES (1, ${inv.kind}, ${inv.name}, ${inv.number}, ${inv.from}, ${inv.to}, ${inv.total}, ${method}, ${env}, ${transfer}, ${status}, ${fee}, ${note}, ${by})
                        ON CONFLICT (account_id, invoice_number) DO NOTHING RETURNING id` as { id: string }[];
  // Two clicks at once: the transfer id gave both the same Wise transfer; the second row is the one refused.
  if (!r) throw new Error('This invoice is already paid — reload.');
  return (await payoutOf(sql, inv.number))!;
}

/** Wise's state of the payee's transfers still moving, asked again when their card opens. */
export async function refreshStatuses(sql: SqlFn, w: Wise, kind: PayeeKind, name: string): Promise<void> {
  const open = await sql`SELECT id, wise_transfer_id::text AS t FROM payouts
                          WHERE account_id = 1 AND payee_kind = ${kind} AND lower(payee) = lower(${name}) AND method = 'wise'
                            AND wise_env = ${w.env} AND NOT (coalesce(wise_status, '') = ANY(${WISE_FINAL}))` as { id: string; t: string }[];
  for (const o of open) {
    const t = await wiseCall<{ status: string }>(w, 'GET', `/v1/transfers/${o.t}`).catch(() => null);
    if (t) await sql`UPDATE payouts SET wise_status = ${t.status} WHERE id = ${o.id}`;
  }
}

/** Only a payout marked by hand can be taken back here; a Wise transfer is cancelled in Wise, if it has not gone out. */
export async function undoPayout(sql: SqlFn, id: string): Promise<void> {
  const done = await sql`DELETE FROM payouts WHERE account_id = 1 AND id = ${Number(id) || 0} AND method = 'manual' RETURNING id`;
  if (!done.length) throw new Error('Only a payment marked by hand can be undone here — a Wise transfer is cancelled in Wise, if it has not gone out.');
}

/* ── the payee opens the link ─────────────────────────────────────── */

const esc = (t: string) => t.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kaizen — ${title}</title>` +
  `<style>label{display:block;margin:.6rem 0}input,select{display:block;width:100%;box-sizing:border-box;font:inherit;padding:.45rem;margin-top:.2rem}` +
  `.row{display:flex;gap:.5rem}.row label{flex:1}button{font:inherit;padding:.6rem 1rem;margin-top:.8rem}.bad{color:#b00020}small{color:#555}</style>` +
  `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px"><h1 style="font-size:1.3rem">${title}</h1>${body}</body>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

function form(p: Payee, b: Partial<Bank>, problems: string[]): string {
  const v = (k: keyof Bank) => esc(String(b[k] ?? ''));
  return (p.last4 ? `<p>Bank on file: account ending ${esc(p.last4)}. Sending this replaces it.<br><small>Cuenta guardada: termina en ${esc(p.last4)}. Si envías esto, la reemplaza.</small></p>` : '') +
    problems.map(x => `<p class="bad">${esc(x)}</p>`).join('') +
    `<form method="post">
      <label>Full name on the account / Nombre completo del titular<input name="holder" required value="${v('holder')}" autocomplete="name"></label>
      <label>Routing number (9 digits / 9 dígitos)<input name="routing" required inputmode="numeric" pattern="\\d{9}" value="${v('routing')}"></label>
      <label>Account number / Número de cuenta<input name="account" required inputmode="numeric" pattern="\\d{4,17}" value="${v('account')}"></label>
      <label>Type / Tipo<select name="type"><option value="CHECKING">Checking</option><option value="SAVINGS"${b.type === 'SAVINGS' ? ' selected' : ''}>Savings</option></select></label>
      <label>Street address / Dirección<input name="line" required value="${v('line')}" autocomplete="address-line1"></label>
      <div class="row"><label>City / Ciudad<input name="city" required value="${v('city')}"></label>
      <label>State<input name="state" required maxlength="2" value="${v('state') || 'TX'}"></label>
      <label>ZIP<input name="zip" required inputmode="numeric" pattern="\\d{5}" value="${v('zip')}"></label></div>
      <button type="submit">Save / Guardar</button>
    </form>
    <p><small>Kaizen pays you by bank transfer through Wise. Your bank details go to Wise; Kaizen keeps only the last 4 digits.<br>
    Kaizen te paga por transferencia bancaria con Wise. Tus datos van a Wise; Kaizen solo guarda los últimos 4 dígitos.</small></p>`;
}

/**
 * `/api/report-link?bank=<signed>` — public (the door already behind Access's bypass).
 * GET shows the payee a form for their bank; POST hands it to Wise and keeps the recipient id and last 4.
 */
export async function bankLink(sql: SqlFn, encryptionKey: string, request: Request): Promise<Response> {
  const bad = () => page('Link not valid / Enlace no válido', '<p>Ask Kaizen for a new link.<br>Pide a Kaizen un enlace nuevo.</p>', 403);
  const who = await verifyPayee(encryptionKey, new URL(request.url).searchParams.get('bank') ?? '');
  if (!who) return bad();
  const w = await wiseOf(sql, encryptionKey).catch(() => null);
  const p = await payeeOf(sql, who.kind, who.name);
  if (!w?.profile || !p) return bad();
  const title = `${esc(p.name)} — where Kaizen pays you / dónde te paga Kaizen`;
  if (request.method !== 'POST') return page(title, form(p, {}, []));
  const f = await request.formData();
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const b: Bank = { holder: s('holder').slice(0, 80), routing: s('routing').replace(/\D/g, ''), account: s('account').replace(/\D/g, ''),
                    type: s('type') === 'SAVINGS' ? 'SAVINGS' : 'CHECKING', line: s('line').slice(0, 120), city: s('city').slice(0, 60),
                    state: s('state').toUpperCase(), zip: s('zip') };
  const problems = bankProblems(b);
  if (problems.length) return page(title, form(p, b, problems), 400);
  try {
    const last4 = await saveBank(sql, w, p, b);
    return page('Saved / Guardado', `<p>Thanks, ${esc(p.name)}. Kaizen will pay to the account ending ${esc(last4)}.</p><p>Gracias, ${esc(p.name)}. Kaizen te pagará a la cuenta que termina en ${esc(last4)}.</p>`);
  } catch (e) {
    return page(title, form(p, b, [`Wise did not accept it: ${e instanceof Error ? e.message.replace(/^Wise: /, '') : String(e)} / Wise no lo aceptó — revisa los datos.`]), 400);
  }
}
