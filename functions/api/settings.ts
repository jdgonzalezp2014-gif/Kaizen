/**
 * GET  /api/settings — what this account looks like, safe for a browser
 * POST /api/settings — save credentials and targets
 *
 * This is the onboarding surface: a new host enters their own Hostaway
 * credentials here rather than someone editing a deployment's
 * environment. That is the whole difference between one installation and
 * a product.
 */
import { getAccount, getCredentials, saveCredentials, type SqlFn } from '../_lib/accounts.ts';
import { getAccessToken, fetchListings } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { tabsFor } from '../_lib/roles.ts';
import { encrypt } from '../_lib/crypto.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account) return Response.json({ ok: false, error: 'no_account' }, { status: 404 });

  // Whether Hostaway actually answers, not just whether a key is stored.
  // "Saved" and "working" are different states and a settings screen that
  // conflates them sends people hunting in the wrong place.
  let connection: { ok: boolean; message: string; units?: number } = {
    ok: false, message: 'No Hostaway credentials yet.'
  };

  if (account.hasHostawayKey) {
    try {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const listings = await fetchListings(creds);
      connection = {
        ok: true,
        message: `Connected — ${listings.filter(l => l.active).length} active of ${listings.length} listing(s).`,
        units: listings.length
      };
    } catch (err) {
      connection = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  const member = (await sql`
    SELECT role FROM members WHERE account_id = 1 AND email = ${who.email.trim().toLowerCase()}
  `) as { role: string }[];
  const role = member[0]?.role ?? 'owner';

  if (role !== 'owner') {
    // An ops member gets their identity and their tabs. Not the
    // credential flags, not the allow-list, not the targets — none of
    // which they can act on, and all of which describe the business
    // rather than their job.
    return Response.json({
      ok: true, user: who.email, role, tabs: tabsFor('ops'), account: null, connection: null
    });
  }

  const [members, audit] = await Promise.all([
    sql`SELECT email, role, is_primary, added_at FROM members
         WHERE account_id = 1 ORDER BY is_primary DESC, role, email`,
    sql`SELECT actor, action, email, detail, at FROM member_audit
         WHERE account_id = 1 ORDER BY at DESC LIMIT 20`
  ]);

  return Response.json({
    ok: true, user: who.email, role, tabs: tabsFor('owner'),
    account, connection, members, audit
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  try {
    if (body.hostawayAccountId && body.hostawayApiKey) {
      const accountId = String(body.hostawayAccountId).trim();
      const apiKey = String(body.hostawayApiKey).trim();

      // Verified before it is stored. Saving a credential that does not
      // work moves the failure to somewhere far less obvious than the
      // form the person is currently looking at.
      await getAccessToken({ accountId, apiKey });
      await saveCredentials(sql, env.ENCRYPTION_KEY, accountId, apiKey);
    }

    // Members. Adding one also puts them on the allow-list: a role with
    // no way in is a role nobody can use, and making that two separate
    // chores is how somebody ends up unable to sign in.
    if (Array.isArray(body.members)) {
      const rows = (body.members as { email?: string; role?: string }[])
        .map(m => ({
          email: String(m.email ?? '').trim().toLowerCase(),
          role: m.role === 'owner' ? 'owner' : 'ops'
        }))
        .filter(m => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.email));

      // Refused rather than explained afterwards: saving a list with no
      // owner leaves an account nobody can administer, and no screen
      // left that could fix it.
      if (rows.length && !rows.some(m => m.role === 'owner')) {
        return Response.json({ ok: false,
          error: 'An account needs at least one owner.' }, { status: 400 });
      }

      const before = (await sql`
        SELECT email, role, is_primary FROM members WHERE account_id = 1
      `) as { email: string; role: string; is_primary: boolean }[];
      const primary = before.find(m => m.is_primary) ?? null;
      const actor = who.email.trim().toLowerCase();

      // The primary owner cannot be removed or demoted by anyone else.
      // They can do either to themselves — this is a floor under the
      // account, not a lock on a person.
      if (primary && primary.email !== actor) {
        const stillThere = rows.find(m => m.email === primary.email);
        if (!stillThere || stillThere.role !== 'owner') {
          return Response.json({
            ok: false, error: 'primary_owner',
            message: `${primary.email} is the primary owner of this account and cannot be ` +
                     'removed or demoted by another member. They can change their own role, ' +
                     'or transfer the primary role first.'
          }, { status: 403 });
        }
      }

      await sql`DELETE FROM members WHERE account_id = 1`;
      for (const m of rows) {
        await sql`
          INSERT INTO members (account_id, email, role, added_by, is_primary)
          VALUES (1, ${m.email}, ${m.role}, ${who.email},
                  ${primary ? m.email === primary.email : false})
          ON CONFLICT (account_id, email) DO UPDATE SET role = EXCLUDED.role
        `;
      }
      await sql`UPDATE accounts SET allowed_emails = ${rows.map(m => m.email)} WHERE id = 1`;

      // The trail. Records grants as readily as removals — that is what
      // makes it an audit log rather than a weapon.
      const wasRole = new Map(before.map(m => [m.email, m.role]));
      for (const m of rows) {
        const prev = wasRole.get(m.email);
        if (prev === undefined) {
          await sql`INSERT INTO member_audit (account_id, actor, action, email, detail)
                    VALUES (1, ${actor}, 'added', ${m.email}, ${m.role})`;
        } else if (prev !== m.role) {
          await sql`INSERT INTO member_audit (account_id, actor, action, email, detail)
                    VALUES (1, ${actor}, 'role_changed', ${m.email}, ${prev + ' → ' + m.role})`;
        }
      }
      for (const b of before) {
        if (!rows.some(m => m.email === b.email)) {
          await sql`INSERT INTO member_audit (account_id, actor, action, email, detail)
                    VALUES (1, ${actor}, 'removed', ${b.email}, ${b.role})`;
        }
      }
    }

    if (Array.isArray(body.allowedEmails)) {
      // Normalised and de-duplicated here rather than trusted: the gate
      // compares lower-cased, and a stored "Me@Gmail.com " that never
      // matches would look like the allow-list is simply broken.
      const list = [...new Set(
        (body.allowedEmails as unknown[])
          .map(e => String(e).trim().toLowerCase())
          .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      )];
      await sql`UPDATE accounts SET allowed_emails = ${list} WHERE id = 1`;
    }

    // Generated server-side and returned ONCE. A token the browser
    // invents is a token whose quality depends on the browser; a token
    // stored in plain text is a token a database dump hands over.
    if (body.newIngestToken === true) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
      await sql`UPDATE accounts SET ingest_token_enc = ${await encrypt(token, env.ENCRYPTION_KEY)} WHERE id = 1`;
      return Response.json({ ok: true, ingestToken: token, account: await getAccount(sql) });
    }

    if (typeof body.quoApiKey === 'string' && body.quoApiKey.trim()) {
      await sql`UPDATE accounts SET quo_api_key_enc = ${await encrypt(body.quoApiKey.trim(), env.ENCRYPTION_KEY)} WHERE id = 1`;
    }
    if (typeof body.quoFrom === 'string') {
      await sql`UPDATE accounts SET quo_from = ${body.quoFrom.trim() || null} WHERE id = 1`;
    }
    if (Array.isArray(body.quoRecipients)) {
      const list = [...new Set((body.quoRecipients as unknown[])
        .map(v => String(v).trim()).filter(Boolean))];
      await sql`UPDATE accounts SET quo_recipients = ${list} WHERE id = 1`;
    }
    if (typeof body.quoLive === 'boolean') {
      await sql`UPDATE accounts SET quo_live = ${body.quoLive} WHERE id = 1`;
    }

    if (typeof body.jinaApiKey === 'string' && body.jinaApiKey.trim()) {
      const enc = await encrypt(body.jinaApiKey.trim(), env.ENCRYPTION_KEY);
      await sql`UPDATE accounts SET jina_api_key_enc = ${enc} WHERE id = 1`;
    }

    if (typeof body.geminiApiKey === 'string' && body.geminiApiKey.trim()) {
      // Encrypted, exactly like the Hostaway key, and never echoed back.
      const enc = await encrypt(body.geminiApiKey.trim(), env.ENCRYPTION_KEY);
      await sql`UPDATE accounts SET gemini_api_key_enc = ${enc} WHERE id = 1`;
    }
    if (typeof body.geminiModel === 'string' && body.geminiModel.trim()) {
      await sql`UPDATE accounts SET gemini_model = ${body.geminiModel.trim()} WHERE id = 1`;
    }

    if (typeof body.cleaningsCsvUrl === 'string') {
      const u = body.cleaningsCsvUrl.trim();
      await sql`UPDATE accounts SET cleanings_csv_url = ${u || null} WHERE id = 1`;
    }

    const targets = ['targetNetPerUnit', 'occFloorPct', 'stayNights', 'fwdStudyDays', 'offlineAfterDays'] as const;
    const cols: Record<typeof targets[number], string> = {
      targetNetPerUnit: 'target_net_per_unit',
      occFloorPct: 'occ_floor_pct',
      stayNights: 'stay_nights',
      fwdStudyDays: 'fwd_study_days',
      offlineAfterDays: 'offline_after_days'
    };
    for (const key of targets) {
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v <= 0) continue;
      // Column name comes from the map above, never from the request.
      if (cols[key] === 'target_net_per_unit') await sql`UPDATE accounts SET target_net_per_unit = ${v} WHERE id = 1`;
      if (cols[key] === 'occ_floor_pct')       await sql`UPDATE accounts SET occ_floor_pct = ${Math.round(v)} WHERE id = 1`;
      if (cols[key] === 'stay_nights')         await sql`UPDATE accounts SET stay_nights = ${Math.round(v)} WHERE id = 1`;
      if (cols[key] === 'fwd_study_days')       await sql`UPDATE accounts SET fwd_study_days = ${Math.round(v)} WHERE id = 1`;
      if (cols[key] === 'offline_after_days')  await sql`UPDATE accounts SET offline_after_days = ${Math.round(v)} WHERE id = 1`;
    }

    return Response.json({ ok: true, account: await getAccount(sql) });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
};
