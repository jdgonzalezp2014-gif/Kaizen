/**
 * The guest AI (Guest Services → Inbox, owner 2026-11-16): a draft reply for the conversation on screen, written from
 * the listing's Repository record (the portal's guide + the listing's own text, capacity, fees, policy), Hostaway's amenities
 * and this booking (party, pets, hours, total), the work open on the stay, the company's general facts, the other listings,
 * the published guest-side SOPs that match, and the thread (audit 2026-11-19: src/lib/guest-knowledge.ts).
 * It only drafts — a person reads it and sends. Answering on its own is not built.
 *
 * Unlike ai-chain.ts (whoever answers first), this asks exactly the provider and model the account chose in
 * Settings → Integrations → Guest messages & AI: a guest-facing voice should not change model from one reply to the next.
 * The key is the account's own (the same Claude / Gemini key the rest of Kaizen uses).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SqlFn } from './accounts.ts';
import { askGemini, firstJson } from './ai-chain.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';
import { guestHouse } from '../api/guest-guide.ts';
import { fetchListingAmenities, fetchReservationDetail } from './hostaway.ts';
import type { HostawayCredentials } from './hostaway.ts';
import { aiPrompt, channelLabel, guestAiFrom, guideFacts, planFor, portalLines, question, stageOf, suggestionFromAi, type GuestAi, type Stay, type Suggestion, type ThreadMsg } from '../../src/lib/inbox.ts';
import { nights as stayNights } from '../../src/lib/guest-portal.ts';
import { portalFrom, protectionFor } from '../../src/lib/guest-checkin.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { getCredentials } from './accounts.ts';
import { fetchConversation, fetchMessages } from './hostaway-messages.ts';
import { GUEST_TZ, issuesOf, loadTemplates } from './guest-outbox.ts';
import { amenityLine, listingFacts, portfolioFacts, scrubCodes, stayFacts, workFacts } from '../../src/lib/guest-knowledge.ts';
import { rankSops, type SopDoc } from '../../src/lib/slack-sops.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES } from '../../src/lib/repo-checks.ts';

/**
 * SOP sections a guest reply may draw on. The rest (cleaners' pages, Slack, roles, pricing, costs, inspections) are how the
 * team uses Kaizen — ranked by words they still matched guest messages ("early" → the early-departure clean) and put
 * internal detail in front of a guest-facing voice. An SOP with no section still counts. Section keys are per account
 * (docs/product.md).
 */
const GUEST_SECTIONS = new Set(['guest', 'claims', 'maintenance', 'compliance', 'mod-guest-services', 'mod-experience', 'mod-portal']);

const MS = 30000;

/** The account's settings — the defaults (off) while migration 116 has not run. */
export async function readGuestAi(sql: SqlFn): Promise<GuestAi> {
  const rows = await (sql`SELECT guest_ai FROM accounts WHERE id = 1` as Promise<{ guest_ai: unknown }[]>).catch(() => []);
  return guestAiFrom(rows[0]?.guest_ai);
}

/** Opus 5.5, Sonnet 5.5 and Fable can hand a declined request to another model inside the same call; Haiku cannot. */
const hasFallback = (model: string) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);

async function askClaude(key: string, model: string, system: string, user: string): Promise<{ json?: Record<string, unknown>; error?: string; by?: string }> {
  try {
    const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: MS });
    const r = await client.beta.messages.create({
      model, max_tokens: 4096, system,
      // A short draft with a person waiting: low effort; thinking stays adaptive (the default).
      output_config: { effort: 'low' },
      ...(hasFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as never } : {}),
      messages: [{ role: 'user', content: `${user}\n\nAnswer with the JSON only.` }],
    });
    if (r.stop_reason === 'refusal') return { error: `${model} declined to draft this one` };
    const json = firstJson(r.content.map(b => b.type === 'text' ? b.text : '').join(''));
    return json ? { json, by: r.model } : { error: `${model}: no JSON in the answer` };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: 'Claude refused the API key — check it in Settings → Integrations → AI.' };
    if (e instanceof Anthropic.NotFoundError) return { error: `Claude does not know the model "${model}" — check it in Settings → Integrations.` };
    if (e instanceof Anthropic.RateLimitError) return { error: `${model} is busy (429) — try again in a moment.` };
    if (e instanceof Anthropic.APIError) return { error: `${model}: ${e.status ?? ''} ${e.message.slice(0, 140)}` };
    return { error: `${model}: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}` };
  }
}

type AiStay = Stay & { channel?: string; payment?: string | null; agreement?: string | null; idVerified?: boolean };

export async function suggestReply(sql: SqlFn, env: Env, stay: AiStay, thread: ThreadMsg[], today: string, creds?: HostawayCredentials | null):
  Promise<{ ok: true; suggestion: Suggestion; by: string; sops: string[] } | { ok: false; error: string }> {
  const cfg = await readGuestAi(sql);
  if (cfg.mode === 'off') return { ok: false, error: 'AI suggestions are off — turn them on in Settings → Integrations → Guest messages & AI.' };
  if (!thread.some(m => m.incoming)) return { ok: false, error: 'The guest has not written yet — there is nothing to answer.' };
  const [a] = await sql`SELECT name, gemini_api_key_enc, claude_api_key_enc FROM accounts WHERE id = 1` as
    { name: string; gemini_api_key_enc: string | null; claude_api_key_enc: string | null }[];
  const enc = cfg.provider === 'claude' ? a?.claude_api_key_enc : a?.gemini_api_key_enc;
  const key = enc ? await decrypt(enc, env.ENCRYPTION_KEY).catch(() => null) : null;
  if (!key) return { ok: false, error: `No ${cfg.provider === 'claude' ? 'Claude' : 'Gemini'} key yet — add it in Settings → Integrations → AI.` };

  const booked = !['inquiry', 'cancelled'].includes(stageOf(stay, today));
  const reservation = /^\d+$/.test(stay.reservationId) ? stay.reservationId : null;
  const none = <T,>(v: T) => () => v;
  const [house, docs, recs, units, detail, amenities, todos, done, portalRow, issues, queued, templates] = await Promise.all([
    // No Hostaway key passed: the facts need the record and the builder, not the cover photo or the calendar.
    stay.listingId ? guestHouse(sql, stay.listingId).catch(none(null)) : null,
    sql`SELECT o.id::text, o.title, o.purpose, o.trigger, o.steps, o.body, o.keywords, s.label AS section, o.section_key FROM sops o
          LEFT JOIN sop_sections s ON s.account_id = o.account_id AND s.key = o.section_key
         WHERE o.account_id = 1 AND o.deleted_at IS NULL AND o.status = 'published'`.catch(none([])) as Promise<(SopDoc & { section_key: string | null })[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL`.catch(none([])) as Promise<RepoRow[]>,
    sql`SELECT id::text AS id, name, bedrooms, capacity FROM units WHERE account_id = 1 AND active ORDER BY name`.catch(none([])) as Promise<{ id: string; name: string; bedrooms: unknown; capacity: unknown }[]>,
    creds && reservation ? fetchReservationDetail(creds, reservation).catch(none(null)) : null,
    creds && stay.listingId ? fetchListingAmenities(creds, stay.listingId).catch(none([] as string[])) : [],
    reservation ? sql`SELECT title, status, kind, due_on::text AS "dueOn" FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND done_at IS NULL
                        AND reservation_id = ${reservation} AND parent_id IS NULL ORDER BY created_at DESC LIMIT 6`.catch(none([])) as Promise<{ title: string; status: string; kind: string | null; dueOn: string | null }[]> : [],
    reservation ? sql`SELECT 1 FROM guest_checkins WHERE account_id = 1 AND reservation_id = ${reservation}`.catch(none(null)) as Promise<unknown[] | null> : null,
    sql`SELECT guest_portal_url FROM accounts WHERE id = 1`.catch(none([])) as Promise<{ guest_portal_url: string | null }[]>,
    reservation ? issuesOf(sql, [reservation]) : new Map<string, string>(),
    reservation ? sql`SELECT body, send_at FROM guest_messages WHERE account_id = 1 AND reservation_id = ${reservation} AND status IN ('scheduled', 'staged')
                        AND send_at > now() - interval '1 hour' ORDER BY send_at LIMIT 6`.catch(none([])) as Promise<{ body: string; send_at: string | Date }[]> : [],
    loadTemplates(sql).catch(none([])),
  ]);
  // The portal decides what a booked guest may be told now (owner, 2026-11-23): before the online check-in, no arrival
  // details reach the facts at all — the prompt's rule is backed by what the model is shown.
  const hasLink = !!portalRow[0]?.guest_portal_url;
  const checkinDone = !!done?.length;
  const inHouse = ['staying', 'leaving'].includes(stageOf(stay, today));
  const held = booked && hasLink && cfg.portalFirst && !checkinDone && !inHouse;
  const unitName = house?.unitName ?? stay.listing;
  const rec = repoMatch(unitName, recs);
  const facts = scrubCodes([
    guideFacts(house?.guide ?? null, { unitName, notOffered: house?.notOffered, prices: house?.prices, booked: booked && !held }),
    ...listingFacts(rec?.vals, booked && !held),
    amenityLine(amenities),
  ].filter(Boolean).join('\n'));
  const stayLines = stayFacts(detail, { channel: stay.channel ? channelLabel(stay.channel) : undefined, payment: stay.payment, agreement: stay.agreement,
    idVerified: stay.idVerified, checkinDone: done == null ? undefined : done.length > 0 });
  const portfolio = portfolioFacts(units.map(u => {
    const v = repoMatch(u.name, recs)?.vals ?? {};
    return { name: u.name, title: (v.listing_title ?? v.hw_airbnb_title) as string | undefined, area: (v.hw_public_address ?? v.location) as string | undefined,
      bedrooms: v.hw_bedrooms ?? u.bedrooms, guests: v.max_guests ?? u.capacity };
  }), unitName);
  const sops = rankSops(question(thread), docs.filter(d => !d.section_key || GUEST_SECTIONS.has(d.section_key)), 5);
  const pf = portalFrom(rec?.vals);
  const n = stay.arrival && stay.departure ? stayNights({ arrival: stay.arrival, departure: stay.departure }) : 1;
  const p = protectionFor(pf.unitType ?? 'house', pf.protection, n);
  const protection = /airbnb/i.test(stay.channel ?? '') ? 'Damage protection: covered by Airbnb (AirCover) — no deposit or waiver for this guest.'
    : `Damage protection, chosen in the online check-in: a refundable $${p.deposit.hold} security deposit (a hold, released after check-out) or a non-refundable damage waiver of $${p.waiver.perNight} per night or $${p.waiver.min}, whichever is greater — $${p.waiver.price} for this ${n}-night stay.`;
  const portal = portalLines({ hasLink, checkinDone, oldPortalDone: stay.agreement === 'signed' || stay.idVerified === true, portalFirst: cfg.portalFirst,
    oldNotice: cfg.oldPortalNotice, protection, inHouse });
  // What Kaizen will send this stay: rows already in the outbox, and automations still to come (Hostaway's own are not readable — its API has none).
  const issue = reservation ? issues.get(reservation) ?? null : null;
  const planned = planFor({ ...stay, checkinDoneAt: checkinDone ? 'done' : null, issue: !!issue }, templates, [], new Date(), GUEST_TZ)
    .filter(p => p.state === 'planned' && p.at).slice(0, 6).map(p => `${p.at!.slice(0, 16).replace('T', ' ')} UTC — automation "${p.name}"`);
  const scheduled = [...queued.map(q => `${new Date(q.send_at).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${scrubCodes(q.body).replace(/\s+/g, ' ').slice(0, 160)}`), ...planned];
  const { system, user } = aiPrompt({ stay, today, facts, sops, thread, instructions: cfg.instructions, company: a?.name ?? 'the host',
    business: scrubCodes(cfg.business), stayLines, work: workFacts(todos), portfolio, channel: stay.channel, portal, scheduled, issue });
  const r = cfg.provider === 'claude' ? await askClaude(key, cfg.model, system, user)
    : await askGemini(key, cfg.model, system, user, [], MS).then(x => ({ ...x, by: cfg.model }));
  if (!r.json) return { ok: false, error: r.error ?? 'The model did not answer.' };
  const suggestion = suggestionFromAi(r.json);
  if (!suggestion) return { ok: false, error: 'The model answered without a reply.' };
  return { ok: true, suggestion, by: r.by ?? cfg.model, sops: sops.map(s => s.title) };
}

/** The draft for one conversation, read fresh from Hostaway — the Suggest button and the webhook's automatic draft share it. */
export async function suggestFor(sql: SqlFn, env: Env, conversationId: string):
  Promise<Awaited<ReturnType<typeof suggestReply>> | { ok: false; error: string; gone: true }> {
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const [row, thread, units] = await Promise.all([fetchConversation(creds, conversationId), fetchMessages(creds, conversationId),
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>]);
  if (!row) return { ok: false, error: 'That conversation is not in Hostaway any more.', gone: true };
  const stay = { ...row, listing: units.find(u => u.id === row.listingId)?.name ?? row.listing };
  return suggestReply(sql, env, stay, thread, todayIn(GUEST_TZ), creds);
}
