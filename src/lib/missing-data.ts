/**
 * Missing data (§170) — what an active unit's record or listing still lacks, and how much it hurts.
 * Pure: the API brings the Repository record, which secret / document columns hold something, and
 * the live Hostaway listing; this decides.
 *
 * Read-only on purpose (owner, 2026-10-27): it audits, it never fills. Repository gaps are filled in
 * the record; Hostaway gaps in Hostaway, or sent from the record by ⇄ Check against Hostaway.
 *
 * Severity is what breaks without it, not how hard it is to find:
 *   critical — a clean or a stay goes wrong (no way in, no Wi-Fi, no address);
 *   high     — money, compliance or a service outage (insurance, AT&T account, fees, guest rules);
 *   medium   — slows someone down (POC, admin code, closet code, lost-fob fee);
 *   low      — paperwork (lease copy, house manual, backup code, fields not copied from Hostaway).
 * A new rule = one entry in REPO_RULES or HOSTAWAY_RULES.
 */
import { kindOf, supplyPlace, hasCloset, type RepoRow } from './unit-access.ts';
import { CHECKS, runCheck } from './repo-checks.ts';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
export const rank = (s: Severity) => SEVERITIES.indexOf(s);

export interface Gap {
  key: string; label: string; severity: Severity; why: string;
  /** Where it is filled. */
  where: 'repository' | 'hostaway';
  /** A short how-to when it is not just "type it in". */
  fix?: string;
}
export interface UnitGaps {
  unitId: string; unit: string;
  table: string | null; recordId: string | null;
  /** Hostaway's listing was read for this unit (false = only the Repository was audited). */
  hostaway: boolean;
  gaps: Gap[];
}

export interface AuditInput {
  rec: RepoRow | null;
  /** Every Units record — a storage is looked up across tables. */
  records: RepoRow[];
  /** Secret and document columns of this record that hold something (they are not in `vals`). */
  stored: Set<string>;
  listing: Record<string, unknown> | null;
  /** The record's column order (composed texts). */
  order?: string[];
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== false && String(v).trim() !== '' && !/^none$/i.test(String(v).trim());
const isHouse = (rec: RepoRow) => /house/i.test(String(rec.vals.property_type ?? '')) || (!rec.vals.property_type && rec.table === 'houses');

interface RepoRule { key: string; label: string; severity: Severity; why: string; fix?: string;
  /** The gap's label when it depends on the record; null = nothing missing. */
  missing: (rec: RepoRow, x: AuditInput, has: (k: string) => boolean) => boolean | string }

export const REPO_RULES: RepoRule[] = [
  { key: 'access', label: 'Cleaner access', severity: 'critical', why: 'Cleaners get no way in.',
    missing: (rec, _x, has) => {
      const kind = kindOf(filled(rec.vals.lock_type) ? String(rec.vals.lock_type) : null);
      if (!kind) return 'Lock type';
      if (kind === 'smart' && !has('cleaner_code')) return 'Cleaner code';
      if ((kind === 'fob' || kind === 'keys') && !has('lockbox')) return 'Lockbox';
      return false;
    } },
  { key: 'storage', label: 'Supplies place (Storage)', severity: 'high', why: 'Inventory and cleaners do not know where this unit\'s supplies are.',
    missing: (rec, x) => !supplyPlace(rec, x.records) },
  { key: 'insurance', label: 'Insurance', severity: 'high', why: 'No proof of insurance on file for this unit.',
    missing: (_r, _x, has) => !has('insurance') },
  { key: 'internet_account', label: 'Internet account # (AT&T)', severity: 'high', why: 'An outage cannot be reported to AT&T without it.',
    missing: (_r, _x, has) => !has('internet_account') },
  { key: 'property_type', label: 'Property type', severity: 'high', why: 'The inspection checklist cannot pick house or apartment items.',
    missing: (_r, _x, has) => !has('property_type') },
  { key: 'contract', label: 'Contract (Lease / Management)', severity: 'medium', why: 'Costs and renewals do not know how this unit is held.',
    missing: (_r, _x, has) => !has('contract') },
  { key: 'poc', label: 'Point of contact', severity: 'medium', why: 'Nobody to call when something breaks.',
    missing: (rec, _x, has) => isHouse(rec)
      ? (!has('manager_contact') && !has('landlord_contact') ? 'Property manager or landlord (POC)' : false)
      : (!has('maintenance') && !has('maintenance_portal') ? 'Maintenance # or portal' : false) },
  { key: 'admin_code', label: 'Admin code', severity: 'medium', why: 'No master code if the cleaner code fails.',
    missing: (_r, _x, has) => !has('admin_code') },
  { key: 'closet_code', label: 'Closet code', severity: 'medium', why: 'Cleaners cannot open the supply closet.',
    // Houses only: the P2 closets are not locked (owner's open item 4 asks for the houses).
    missing: (rec, _x, has) => isHouse(rec) && hasCloset(rec) && !has('closet_code') },
  { key: 'fob_replacement_fee', label: 'Lost fob/key fee', severity: 'medium', why: 'A lost fob or key cannot be charged to the guest.',
    missing: (rec, _x, has) => (/fob|key/i.test(String(rec.vals.keys_fobs ?? '')) || /fob|key/i.test(String(rec.vals.lock_type ?? ''))) && !has('fob_replacement_fee') },
  { key: 'lease', label: 'Lease copy', severity: 'low', why: 'The lease is not on file.',
    missing: (rec, _x, has) => /lease/i.test(String(rec.vals.contract ?? '')) && !has('lease') },
  { key: 'backup_code', label: 'Backup code', severity: 'low', why: 'No second code if the admin code fails.',
    missing: (_r, _x, has) => !has('backup_code') },
  { key: 'parking', label: 'Parking notes', severity: 'low', why: 'Guests and cleaners are not told where to park.',
    missing: (_r, _x, has) => !has('parking') },
  { key: 'house_manual', label: 'House manual', severity: 'low', why: 'No manual to send a guest who asks.',
    missing: (_r, _x, has) => !has('house_manual') },
];

/** Hostaway fields that matter, by CHECKS key — read from the live listing, never written from here. */
export const HOSTAWAY_RULES: { check: string; severity: Severity; why: string }[] = [
  { check: 'wifi', severity: 'critical', why: 'Guests and cleaners get no Wi-Fi.' },
  { check: 'hw_address', severity: 'critical', why: 'Guests and cleaners get no address.' },
  { check: 'checkin_from', severity: 'high', why: 'Guests are not told when they can arrive.' },
  { check: 'checkout_time', severity: 'high', why: 'Guests are not told when to leave; the clean has no start.' },
  { check: 'max_guests', severity: 'high', why: 'Channels cannot cap the party size.' },
  { check: 'listing_title', severity: 'high', why: 'The listing has no public title.' },
  { check: 'description', severity: 'high', why: 'Guests read no description.' },
  { check: 'house_rules', severity: 'high', why: 'Guests agree to no house rules.' },
  { check: 'cleaning_fee', severity: 'high', why: 'Guests are not charged for the clean.' },
  { check: 'checkin_until', severity: 'medium', why: 'No latest check-in time for guests.' },
  { check: 'insurance_fee', severity: 'medium', why: 'No insurance fee charged per night.' },
  { check: 'hw_contact_phone', severity: 'medium', why: 'Channels show no contact phone.' },
];

export function auditUnit(unitId: string, unit: string, x: AuditInput): UnitGaps {
  const out: UnitGaps = { unitId, unit, table: x.rec?.table ?? null, recordId: x.rec?.id ?? null, hostaway: !!x.listing, gaps: [] };
  const rec = x.rec;
  if (!rec) {
    out.gaps.push({ key: 'record', label: 'No Repository record', severity: 'critical', where: 'repository',
      why: 'Cleaners get no codes and nothing here can be checked.', fix: 'Add the unit to a Units table, named as in Hostaway.' });
  } else {
    const has = (k: string) => x.stored.has(k) || filled(rec.vals[k]);
    for (const r of REPO_RULES) {
      const m = r.missing(rec, x, has);
      if (m) out.gaps.push({ key: r.key, label: typeof m === 'string' ? m : r.label, severity: r.severity, why: r.why, where: 'repository', ...(r.fix ? { fix: r.fix } : {}) });
    }
  }
  if (x.listing) {
    const vals = rec?.vals ?? {};
    for (const h of HOSTAWAY_RULES) {
      const def = CHECKS.find(c => c.key === h.check);
      if (!def) continue;
      const empty = runCheck(def, vals, x.listing, x.order).fields.filter(f => !f.hostaway);
      if (!empty.length) continue;
      const inRepo = empty.every(f => !!f.repo);
      out.gaps.push({ key: `hw:${def.key}`, label: def.fields.length > 1 ? `${def.label}: ${empty.map(f => f.label).join(', ')}` : def.label,
        severity: h.severity, why: h.why, where: 'hostaway',
        fix: inRepo && def.send ? 'The Repository has it: send it with ⇄ Check against Hostaway.' : 'Fill it in Hostaway.' });
    }
    // Hostaway has it and the record does not: the team's copy is behind (owner: fill Repository from Hostaway first).
    if (rec) {
      const behind = CHECKS.filter(c => runCheck(c, vals, x.listing!, x.order).status === 'no-repository');
      if (behind.length) out.gaps.push({ key: 'copy', label: `${behind.length} field${behind.length === 1 ? '' : 's'} not copied from Hostaway`,
        severity: 'low', where: 'repository', why: behind.slice(0, 5).map(c => c.label).join(', ') + (behind.length > 5 ? ` and ${behind.length - 5} more.` : '.'),
        fix: 'Copy them with ⇄ Check against Hostaway → "← Use Hostaway\'s".' });
    }
  }
  out.gaps.sort((a, b) => rank(a.severity) - rank(b.severity));
  return out;
}

/** Worst first: by the worst gap, then by how many critical/high, then by name. */
export function worstFirst(list: UnitGaps[]): UnitGaps[] {
  const worst = (u: UnitGaps) => u.gaps.length ? rank(u.gaps[0]!.severity) : SEVERITIES.length;
  const heavy = (u: UnitGaps) => u.gaps.filter(g => rank(g.severity) <= 1).length;
  return [...list].sort((a, b) => worst(a) - worst(b) || heavy(b) - heavy(a) || a.unit.localeCompare(b.unit));
}

export function countBy(list: UnitGaps[]): Record<Severity, number> {
  const out = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
  for (const u of list) for (const g of u.gaps) out[g.severity]++;
  return out;
}
