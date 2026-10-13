/**
 * Repository ↔ Hostaway checks (§149): does what the team keeps in Repository → Units say the same
 * as the live listing? Pure — the API brings the two sides, this decides.
 *
 * A check is one row of CHECKS: the Repository columns and the Hostaway listing fields that must
 * agree. Adding a check = adding an entry (and, to write it back, its field in HOSTAWAY_FIELD).
 */

export type HostawayKey = 'wifiName' | 'wifiPassword' | 'cleaningFee';
export interface CheckField { label: string; repo: string; hostaway: HostawayKey; kind: 'text' | 'money' }
export interface CheckDef { key: string; label: string; note: string; fields: CheckField[] }

export const CHECKS: CheckDef[] = [
  { key: 'wifi', label: 'Wi-Fi', note: 'What guests and cleaners get comes from Hostaway first.', fields: [
    { label: 'Network', repo: 'wifi_network', hostaway: 'wifiName', kind: 'text' },
    { label: 'Password', repo: 'password_2', hostaway: 'wifiPassword', kind: 'text' }] },
  { key: 'cleaning_fee', label: 'Cleaning fee (guest)', note: 'What the guest is charged to clean — revenue, not the cleaner\'s pay.', fields: [
    { label: 'Fee', repo: 'cleaning_fee', hostaway: 'cleaningFee', kind: 'money' }] },
];

/** The Hostaway listing field a write sends, per side of the comparison. */
export const HOSTAWAY_FIELD: Record<HostawayKey, string> = {
  wifiName: 'wifiUsername', wifiPassword: 'wifiPassword', cleaningFee: 'cleaningFee'
};

/** `case` = equal but for capitals (an SSID is case-sensitive, so it is still shown). */
export type CheckStatus = 'match' | 'case' | 'differ' | 'no-repository' | 'no-hostaway' | 'empty';

export function norm(kind: CheckField['kind'], v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (kind === 'money') {
    const n = Number(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? n.toFixed(2) : '';
  }
  return s;
}

export interface FieldResult { label: string; repo: string; hostaway: string; status: CheckStatus }
export interface CheckResult { key: string; status: CheckStatus; fields: FieldResult[] }

function fieldStatus(repo: string, hostaway: string): CheckStatus {
  if (!repo && !hostaway) return 'empty';
  if (!repo) return 'no-repository';
  if (!hostaway) return 'no-hostaway';
  if (repo === hostaway) return 'match';
  return repo.toLowerCase() === hostaway.toLowerCase() ? 'case' : 'differ';
}

/** The worst field decides the check: a real difference over a missing side over capitals over a match. */
const RANK: CheckStatus[] = ['differ', 'no-repository', 'no-hostaway', 'case', 'match', 'empty'];

export function runCheck(def: CheckDef, repoVals: Record<string, unknown>, listing: Partial<Record<HostawayKey, unknown>>): CheckResult {
  const fields = def.fields.map(f => {
    const repo = norm(f.kind, repoVals[f.repo]), hostaway = norm(f.kind, listing[f.hostaway]);
    return { label: f.label, repo, hostaway, status: fieldStatus(repo, hostaway) };
  });
  const filled = fields.filter(f => f.status !== 'empty');
  const status = filled.length ? RANK.find(s => filled.some(f => f.status === s))! : 'empty';
  return { key: def.key, status, fields };
}

/** What a write sets: Repository columns from Hostaway, or Hostaway fields from the Repository. */
export function writePlan(def: CheckDef, result: CheckResult, to: 'repository' | 'hostaway'): Record<string, string | number> | string {
  const out: Record<string, string | number> = {};
  for (const [i, f] of def.fields.entries()) {
    const v = to === 'repository' ? result.fields[i]!.hostaway : result.fields[i]!.repo;
    if (!v) return `${f.label} is empty in ${to === 'repository' ? 'Hostaway' : 'the Repository'} — nothing to copy.`;
    const val = f.kind === 'money' ? Number(v) : v;
    out[to === 'repository' ? f.repo : HOSTAWAY_FIELD[f.hostaway]] = val;
  }
  return out;
}
