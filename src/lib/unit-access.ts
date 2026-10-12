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
  const teamCode = text(v.cleaner_code) ?? text(v.clener_code);
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
