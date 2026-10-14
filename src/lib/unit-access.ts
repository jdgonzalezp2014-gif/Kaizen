/**
 * What a cleaner needs to get into a unit (§136) — pure: which Repository
 * record is the unit's, and the access a clean carries.
 *
 * Two sources, each for what it holds best:
 *  - Hostaway (synced into `units`): the address and the Wi-Fi — what guests
 *    get, complete for every listing;
 *  - the Repository's unit tables (the team's): the lock type, the cleaner
 *    code, the lockbox and the fobs.
 * Hostaway's door code is the guests'; it is shown only when the team has no
 * cleaner code, and said to be the guests'. Admin and backup codes never go
 * to a cleaner.
 */

export type AccessKind = 'smart' | 'fob' | 'keys' | 'other';
export interface UnitAccess {
  address: string | null; mapsUrl: string | null;
  lockType: string | null; kind: AccessKind | null;
  code: string | null; codeFrom: 'repository' | 'hostaway' | null;
  lockbox: string | null; fob: string | null;
  wifiName: string | null; wifiPassword: string | null;
  /** §150: where this unit's supplies come from — a storage ("S1105") or the house's own closet — and its code. */
  supplies?: { label: string; self: boolean; code: string | null; skip?: string[] } | null;
  /** What the team still has to fill for cleaners. */
  missing: ('address' | 'access' | 'code' | 'lockbox' | 'wifi')[];
}
export interface UnitRow { id: string; name: string; address: string | null; wifiName: string | null; wifiPassword: string | null; doorCode: string | null }
export interface RepoRow { id: string; table: string; vals: Record<string, unknown> }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lastNumber = (s: unknown) => { const m = String(s ?? '').match(/\d{3,}/g); return m ? m[m.length - 1]! : null; };
const text = (v: unknown) => { const s = String(v ?? '').trim(); return s && !/^none$/i.test(s) ? s : null; };

/**
 * The Repository record of a unit: the same name once punctuation is gone
 * ("CL 1125" = "CL-1125", "Timber Crest" = "Timbercrest"); else the one record
 * with the same unit number ("P2-4308" = "LP-4308" — the same apartment, two
 * names); else a name that contains the other ("Bobcat House" ⊃ "Bobcat").
 */
export function repoMatch(unitName: string, records: RepoRow[]): RepoRow | null {
  const n = norm(unitName);
  const exact = records.find(r => norm(r.vals.name) === n);
  if (exact) return exact;
  const num = lastNumber(unitName);
  if (num) {
    const same = records.filter(r => lastNumber(r.vals.name) === num);
    if (same.length === 1) return same[0]!;
  }
  if (n.length > 3) {
    const part = records.filter(r => { const m = norm(r.vals.name); return m.length > 3 && (m.includes(n) || n.includes(m)); });
    if (part.length === 1) return part[0]!;
  }
  return null;
}

export function kindOf(lockType: string | null): AccessKind | null {
  if (!lockType) return null;
  if (/smart|schlage|yale|keypad|code/i.test(lockType)) return 'smart';
  if (/fob/i.test(lockType)) return 'fob';
  if (/key/i.test(lockType)) return 'keys';
  return 'other';
}

/** The access a clean of this unit carries, and what is still missing for cleaners. */
export function unitAccess(u: UnitRow, rec: RepoRow | null): UnitAccess {
  const v = rec?.vals ?? {};
  const address = text(u.address) ?? text(v.location);
  const lockType = text(v.lock_type);
  const kind = kindOf(lockType);
  const teamCode = text(v.cleaner_code);
  const code = teamCode ?? text(u.doorCode);
  const lockbox = text(v.lockbox);
  const fob = text(v.keys_fobs);
  const wifiName = text(u.wifiName) ?? text(v.wifi_network);
  const wifiPassword = text(u.wifiPassword) ?? text(v.password_2);
  const missing: UnitAccess['missing'] = [];
  if (!address) missing.push('address');
  if (!kind) missing.push('access');
  if ((kind === 'smart' || !kind) && !teamCode) missing.push('code');
  if ((kind === 'fob' || kind === 'keys') && !lockbox) missing.push('lockbox');
  if (!wifiName) missing.push('wifi');
  return {
    address, mapsUrl: address ? `https://maps.google.com/?q=${encodeURIComponent(address)}` : null,
    lockType, kind, code, codeFrom: teamCode ? 'repository' : code ? 'hostaway' : null,
    lockbox, fob, wifiName, wifiPassword, missing
  };
}

/**
 * Where a unit's supplies are kept (§150): the place its Repository `storage`
 * names — a Storage row ("S1105 Storage (stock)"), or the house itself (its
 * own name = its own closet). Looked up in the unit's table first, then in
 * every Units table, so a storage shared across buildings needs no code.
 * Blank, or a name no record has: no place (null) — never guessed.
 */
export interface SupplyPlace { key: string; name: string; self: boolean; code: string | null }
export function supplyPlace(rec: RepoRow | null, records: RepoRow[]): SupplyPlace | null {
  const want = norm(rec?.vals.storage);
  if (!rec || !want) return null;
  const self = norm(rec.vals.name) === want;
  const target = self ? rec : records.find(r => r.table === rec.table && norm(r.vals.name) === want) ?? records.find(r => norm(r.vals.name) === want);
  if (!target) return null;
  // A house's lockbox holds the door keys, not the closet's — only a storage's lockbox opens the storage.
  const code = text(target.vals.closet_code) ?? (self ? null : text(target.vals.lockbox));
  return { key: `${target.table}/${target.id}`, name: String(target.vals.name ?? '').trim(), self, code };
}

/** What a cleaner reads for a place: "S1105" out of "S1105 Storage (stock)"; a house's own is its closet (the caller's word). */
export const placeLabel = (name: string) => /\bS\d+\b/i.exec(name)?.[0].toUpperCase() ?? name;

export interface PlaceRow { key: string; name: string; self: boolean; units: { id: string; name: string; recordId: string | null }[] }
/**
 * The inventory's places, from the Repository (§150): every Storage row and
 * every place an active unit is assigned to (a house's own closet), with the
 * active units each one supplies — and the active units with no place.
 */
export function inventoryPlaces(units: { id: string; name: string; active: boolean }[], records: RepoRow[]) {
  const byUnit = new Map<string, SupplyPlace | null>();
  const places = new Map<string, PlaceRow>();
  for (const r of records) if (/^storage$/i.test(String(r.vals.property_type ?? '').trim()))
    places.set(`${r.table}/${r.id}`, { key: `${r.table}/${r.id}`, name: String(r.vals.name ?? '').trim(), self: false, units: [] });
  const unassigned: { id: string; name: string; recordId: string | null }[] = [];
  for (const u of units) {
    const rec = repoMatch(u.name, records);
    const p = supplyPlace(rec, records);
    byUnit.set(u.id, p);
    if (!u.active) continue;
    const recordId = rec ? `${rec.table}/${rec.id}` : null;
    if (!p) { unassigned.push({ id: u.id, name: u.name, recordId }); continue; }
    const row = places.get(p.key) ?? { key: p.key, name: p.name, self: p.self, units: [] };
    row.units.push({ id: u.id, name: u.name, recordId });
    places.set(p.key, row);
  }
  // Storages first, then the houses' closets.
  const list = [...places.values()].sort((a, b) => Number(a.self) - Number(b.self) || a.name.localeCompare(b.name));
  return { places: list, unassigned, byUnit };
}
