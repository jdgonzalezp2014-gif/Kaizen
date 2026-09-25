/**
 * The Data Repository's rules, native to Kaizen OS (§71).
 *
 * Pure: no fetch, no database. Ported from the repository's Apps Script
 * engine (Repo.js validate_, Import.js coerce_, formatId_) so records
 * behave exactly as they did there — a dropdown still refuses a value that
 * is not an option, a date is still yyyy-mm-dd, IDs still read UNI-0001.
 */

export type ColumnType = 'text' | 'longtext' | 'number' | 'date' | 'checkbox' | 'select'
  | 'email' | 'url' | 'ref' | 'secret' | 'doc';

export interface RepoCol {
  key: string; title: string; type: ColumnType; required: boolean; uniq: boolean;
  options: string[] | null; refTable: string | null; refColumn: string | null;
}

/** Types that convert into one another; the rest are fixed once created. */
export const CONVERTIBLE: ColumnType[] = ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'email', 'url'];
export const EDITABLE: ColumnType[] = [...CONVERTIBLE, 'ref', 'secret'];
export const SECRET_MASK = '••••••••';

/** A key from a title: lowercase words joined by `_`, unique among `taken`. */
export function slug(title: string, taken: Iterable<string> = []): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56) || 'field';
  const used = new Set(taken);
  let key = /^[a-z]/.test(base) ? base : `f_${base}`;
  for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
  return key;
}

/** `UNI` + 7 → UNI-0007; no prefix → "7". */
export function formatId(prefix: string, n: number): string {
  return prefix ? `${prefix}-${String(n).padStart(4, '0')}` : String(n);
}

/** The number at the end of an ID, so a new one continues the series. */
export function idNumber(id: string): number {
  const m = /(\d+)\s*$/.exec(String(id));
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * A value as a column of this type stores it — what a type change does to
 * the values already there, said before it runs. A value that does not
 * fit is cleared rather than guessed at.
 */
export function coerce(col: Pick<RepoCol, 'type' | 'options'>, raw: unknown): unknown {
  if (raw === null || raw === undefined) return '';
  if (col.type === 'checkbox') return raw === true || /^(true|yes|s[ií]|1|x|v|✓)$/i.test(String(raw).trim());
  const text = String(raw).trim();
  if (text === '') return '';
  if (col.type === 'date') {
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    if (iso) return iso[1];
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
    return '';
  }
  if (col.type === 'number') {
    const cleaned = text.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    return cleaned === '' || Number.isNaN(Number(cleaned)) ? '' : Number(cleaned);
  }
  if (col.type === 'select') {
    return (col.options ?? []).find(o => o.toLowerCase() === text.toLowerCase()) ?? '';
  }
  return text;
}

/**
 * Every problem with a record, in words, or none. `others` are the other
 * live records of the table (for uniqueness); `refValues` answers whether
 * a referenced value exists.
 *
 * `only` limits the check to the fields being written. The imported data
 * predates these rules — a date column with dropdown options, a password
 * kept as a select — and a value nobody touched must not block saving
 * the one that was changed.
 */
export function validate(
  cols: RepoCol[], record: Record<string, unknown>, others: Record<string, unknown>[],
  refValues: (table: string, column: string) => Set<string> = () => new Set(),
  only?: Set<string>
): string[] {
  const errors: string[] = [];
  for (const c of cols) {
    if (c.type === 'doc' || (only && !only.has(c.key))) continue;
    const v = record[c.key];
    const empty = v === '' || v === null || v === undefined;
    if (c.required && empty && c.type !== 'checkbox') { errors.push(`${c.title} is required.`); continue; }
    if (empty || c.type === 'checkbox' || c.type === 'secret') continue;
    const s = String(v);
    if (c.type === 'select' && !(c.options ?? []).includes(s)) errors.push(`${c.title} must be one of: ${(c.options ?? []).join(', ')}.`);
    if (c.type === 'number' && Number.isNaN(Number(s))) errors.push(`${c.title} must be a number.`);
    if (c.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors.push(`${c.title} must be a date as yyyy-mm-dd.`);
    if (c.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) errors.push(`${c.title} must be an e-mail address.`);
    if (c.type === 'ref' && c.refTable && c.refColumn && !refValues(c.refTable, c.refColumn).has(s)) {
      errors.push(`${c.title} "${s}" does not exist in the referenced table.`);
    }
    if (c.uniq && others.some(o => String(o[c.key] ?? '') === s)) errors.push(`${c.title} "${s}" is already used.`);
  }
  return errors;
}

/** Search the way a person means it: any value of any column, never a secret. */
export function matches(values: Record<string, unknown>, needle: string, secretKeys: Set<string>): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return Object.entries(values).some(([k, v]) => !secretKeys.has(k) && String(v ?? '').toLowerCase().includes(n));
}
