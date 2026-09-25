/**
 * GET  /api/settings — what this account looks like, safe for a browser
 * POST /api/settings — save credentials and targets
 *
 * This is the onboarding surface: a new host enters their own Hostaway
 * credentials here rather than someone editing a deployment's
 * environment. That is the whole difference between one installation and
 * a product.
 */
import { accessOf, getAccount, getCredentials, saveCredentials, type SqlFn } from '../_lib/accounts.ts';
import { getAccessToken, fetchListings } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { PERMISSIONS, can, tabsFor } from '../_lib/roles.ts';
import { encrypt } from '../_lib/crypto.ts';
import { repoCall, type RepoMeta } from '../_lib/repository.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account) return Response.json({ ok: false, error: 'no_account' }, { status: 404 });

  const access = await accessOf(sql, who);
  const tabs = tabsFor(access.permissions);
  if (!can(access.permissions, 'settings')) {
    // Their identity, their role and what it opens. Not the credential
    // flags, the allow-list or the targets — none of which they can act
    // on, and all of which describe the business rather than their job.
    return Response.json({
      ok: true, user: who.email, role: access.role, permissions: access.permissions, tabs,
      account: null, connection: null
    });
  }

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

  const [members, audit, roles] = await Promise.all([
    sql`SELECT email, role, is_primary, added_at FROM members
         WHERE account_id = 1 ORDER BY is_primary DESC, role, email`,
    sql`SELECT actor, action, email, detail, at FROM member_audit
         WHERE account_id = 1 ORDER BY at DESC LIMIT 20`,
    sql`SELECT r.key, r.name, r.permissions, r.builtin,
               (SELECT COUNT(*)::int FROM members m WHERE m.account_id = r.account_id AND m.role = r.key) AS members
          FROM roles r WHERE r.account_id = 1 ORDER BY r.builtin DESC, r.name`
  ]);

  return Response.json({
    ok: true, user: who.email, role: access.role, permissions: access.permissions, tabs,
    account, connection, members, audit, roles,
    catalog: PERMISSIONS.map(p => ({ key: p.key, label: p.label }))
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
          role: String(m.role ?? '')
        }))
        .filter(m => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.email));

      // Only roles that exist. The foreign key would refuse it anyway, but
      // halfway through a save, after the old list was already deleted.
      const known = new Set(((await sql`SELECT key FROM roles WHERE account_id = 1`) as { key: string }[]).map(r => r.key));
      const unknown = rows.find(m => !known.has(m.role));
      if (unknown) {
        return Response.json({ ok: false, error: `"${unknown.role}" is not a role. Define it in Roles first.` }, { status: 400 });
      }

      // Refused rather than explained afterwards: saving a list with no
      // owner leaves an account nobody can administer, and no screen
      // left that could fix it.
      if (rows.length && !rows.some(m => m.role === 'admin')) {
        return Response.json({ ok: false,
          error: 'An account needs at least one admin.' }, { status: 400 });
      }

      const before = (await sql`
        SELECT email, role, is_primary FROM members WHERE account_id = 1
      `) as { email: string; role: string; is_primary: boolean }[];
      const primary = before.find(m => m.is_primary) ?? null;
      const actor = who.email.trim().toLowerCase();

      // The primary admin cannot be removed or demoted by anyone else.
      // They can do either to themselves — this is a floor under the
      // account, not a lock on a person.
      if (primary && primary.email !== actor) {
        const stillThere = rows.find(m => m.email === primary.email);
        if (!stillThere || stillThere.role !== 'admin') {
          return Response.json({
            ok: false, error: 'primary_owner',
            message: `${primary.email} is the primary admin of this account and cannot be ` +
                     'removed or demoted by another member. They can change their own role, ' +
                     'or transfer the primary role first.'
          }, { status: 403 });
        }
      }

      // Bootstrap: with no primary yet, the admin doing this save becomes
      // it. Without this nobody could ever be primary — the flag only
      // preserved an existing one, so an empty table stayed flat forever
      // and the protection was unreachable.
      //
      // The person setting the account up is the one administering it,
      // and they can transfer it afterwards.
      const primaryEmail = primary
        ? primary.email
        : (rows.some(m => m.email === actor && m.role === 'admin') ? actor : null);

      await sql`DELETE FROM members WHERE account_id = 1`;
      for (const m of rows) {
        await sql`
          INSERT INTO members (account_id, email, role, added_by, is_primary)
          VALUES (1, ${m.email}, ${m.role}, ${who.email}, ${m.email === primaryEmail})
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

    if (typeof body.cleaningsSheetUrl === 'string') {
      await sql`UPDATE accounts SET cleanings_sheet_url = ${body.cleaningsSheetUrl.trim() || null} WHERE id = 1`;
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

    // The daily file's other logs. Blank clears a link; anything else must
    // at least be a Google link — the board reads them server-side, and a
    // stray URL here would be fetched on every page load.
    const dailyLinks = [
      ['dailyNotesCsvUrl', 'notes'], ['dailyInspectionsCsvUrl', 'inspections'],
      ['dailySettingsCsvUrl', 'settings']
    ] as const;
    for (const [field, which] of dailyLinks) {
      if (typeof body[field] !== 'string') continue;
      const u = (body[field] as string).trim();
      if (u && !/^https:\/\/docs\.google\.com\//.test(u)) {
        return Response.json({ ok: false,
          error: `The ${which} link must be a published docs.google.com CSV link.` }, { status: 400 });
      }
      // Column names come from this fixed list, never from the request.
      if (which === 'notes')       await sql`UPDATE accounts SET daily_notes_csv_url = ${u || null} WHERE id = 1`;
      if (which === 'inspections') await sql`UPDATE accounts SET daily_inspections_csv_url = ${u || null} WHERE id = 1`;
      if (which === 'settings')    await sql`UPDATE accounts SET daily_settings_csv_url = ${u || null} WHERE id = 1`;
    }

    // The Data Repository. The link and the key are verified TOGETHER
    // before either is stored, the same rule as Hostaway: a credential
    // that does not work should fail on the form someone is looking at,
    // not later as an empty screen.
    if (typeof body.repoApiUrl === 'string' || typeof body.repoApiKey === 'string') {
      const current = (await sql`SELECT repo_api_url FROM accounts WHERE id = 1`) as
        { repo_api_url: string | null }[];
      const apiUrl = typeof body.repoApiUrl === 'string' ? body.repoApiUrl.trim()
        : (current[0]?.repo_api_url ?? '');
      const apiKey = typeof body.repoApiKey === 'string' ? body.repoApiKey.trim() : '';

      if (!apiUrl) {
        await sql`UPDATE accounts SET repo_api_url = NULL, repo_api_key_enc = NULL WHERE id = 1`;
      } else {
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(apiUrl)) {
          return Response.json({ ok: false, error:
            'The repository API link should look like https://script.google.com/macros/s/…/exec.' },
            { status: 400 });
        }
        if (apiKey) {
          const meta = await repoCall<RepoMeta>({ url: apiUrl, key: apiKey }, 'meta');
          if (!Array.isArray(meta?.sections)) throw new Error('The repository answered, but not with its structure.');
          await sql`UPDATE accounts SET repo_api_url = ${apiUrl},
                           repo_api_key_enc = ${await encrypt(apiKey, env.ENCRYPTION_KEY)} WHERE id = 1`;
        } else if (apiUrl !== current[0]?.repo_api_url) {
          // A new link with the old key is a new pairing, and it is
          // verified like one — otherwise a pasted wrong link would sit
          // behind a "connected" label until someone opened the tab.
          return Response.json({ ok: false,
            error: 'Changing the repository link needs its API key re-entered, so the pair can be checked.' },
            { status: 400 });
        }
      }
    }
    if (typeof body.repoAppUrl === 'string') {
      await sql`UPDATE accounts SET repo_app_url = ${body.repoAppUrl.trim() || null} WHERE id = 1`;
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
