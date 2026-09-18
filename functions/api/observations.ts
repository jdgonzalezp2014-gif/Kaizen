/**
 * POST /api/observations — where a scraper sends what it saw.
 *
 * This exists because of one measured fact: Apps Script can read an
 * Airbnb listing page and this app cannot. Not because Apps Script is
 * more capable — it is far less — but because the request leaves from
 * Google's address space, which Airbnb serves, while a Cloudflare Worker
 * and a plain VPS are both turned away. Egress reputation, not power.
 *
 * So the scraper stays where it works and posts its readings here. The
 * app keeps one shape of truth in one database, and nothing has to
 * pretend the block is not there.
 *
 * Authenticated by a shared token, not by Cloudflare Access: a script
 * has no browser to sign in with. The token is its own credential so
 * that revoking it never costs a person their login.
 */
import { db, type Env } from '../_lib/db.ts';
import { decrypt } from '../_lib/crypto.ts';

interface Observation {
  unitId?: string;
  unitName?: string;
  windowStart?: string;
  stayNights?: number;
  hostawayRate?: number | null;
  airbnbRate?: number | null;
  /** The whole stay, as a guest is quoted it — fees and tax included. */
  airbnbTotal?: number | null;
  windowEnd?: string;
  airbnbRating?: number | null;
  airbnbReviews?: number | null;
  source?: string;
  note?: string;
}

/**
 * Compared in constant time. A token checked with `===` leaks its length
 * and its prefix to anyone willing to time the responses, and this one
 * guards write access.
 */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env);

  const rows = (await sql`SELECT ingest_token_enc FROM accounts WHERE id = 1`) as
    { ingest_token_enc: string | null }[];
  if (!rows[0]?.ingest_token_enc) {
    return Response.json({ ok: false, error: 'ingest_disabled',
      message: 'No ingest token is configured for this account.' }, { status: 409 });
  }
  const expected = await decrypt(rows[0].ingest_token_enc, env.ENCRYPTION_KEY);
  const given = request.headers.get('X-Kaizen-Ingest') ?? '';
  if (!given || !sameToken(given, expected)) {
    return Response.json({ ok: false, error: 'bad_token' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { observations?: Observation[] };
  const list = Array.isArray(body.observations) ? body.observations : [];
  if (!list.length) return Response.json({ ok: false, error: 'No observations supplied.' }, { status: 400 });

  // Rows arrive keyed by NAME as often as by id, because a spreadsheet
  // says "CL1339" and has never heard of a Hostaway listing id.
  const units = (await sql`SELECT id, name FROM units WHERE account_id = 1`) as
    { id: string; name: string }[];
  const byId = new Set(units.map(u => u.id));
  const byName = new Map(units.map(u => [u.name.toLowerCase().replace(/\s+/g, ''), u.id]));

  let written = 0;
  const unmatched: string[] = [];

  for (const o of list) {
    const id = o.unitId && byId.has(String(o.unitId))
      ? String(o.unitId)
      : byName.get(String(o.unitName ?? '').toLowerCase().replace(/\s+/g, ''));
    if (!id) {
      const label = String(o.unitName ?? o.unitId ?? '(blank)');
      if (!unmatched.includes(label)) unmatched.push(label);
      continue;
    }
    // A reading with nothing in it is not a reading. Storing it would
    // bury the real series under rows of nulls.
    if (o.airbnbRating == null && o.airbnbRate == null && o.airbnbTotal == null) continue;

    await sql`
      INSERT INTO price_observations
        (account_id, unit_id, window_start, window_end, stay_nights,
         hostaway_rate, airbnb_rate, airbnb_total, airbnb_rating, airbnb_reviews, source, note)
      VALUES (1, ${id}, ${o.windowStart ?? null}, ${o.windowEnd ?? null}, ${o.stayNights ?? null},
              ${o.hostawayRate ?? null}, ${o.airbnbRate ?? null}, ${o.airbnbTotal ?? null},
              ${o.airbnbRating ?? null}, ${o.airbnbReviews ?? null},
              ${o.source ?? 'apps-script'}, ${o.note ?? null})
    `;
    written++;
  }

  return Response.json({ ok: true, written, skipped: list.length - written - unmatched.length, unmatched });
};
