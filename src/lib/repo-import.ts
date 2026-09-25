/**
 * Reading a Monday board export into a Repository table (§74).
 *
 * Pure — the file arrives as rows of text (the server converts .xlsx
 * through Drive). Ported from the old repository's Import.js
 * (guessHeaderRow_, guessType_, distinctOptions_) and taught what a
 * Monday export actually looks like, seen on this account's own exports:
 *
 *   Services,,,,            ← the board's name
 *   Log Ins,,,,             ← a group (or, on some boards, a description)
 *   Name,Subitems,Details…  ← the header
 *   Netflix,,…              ← items
 *   ,,,,                    ← a blank line between groups
 *   Streaming,,,,           ← the next group…
 *   Name,Subitems,Details…  ← …and the header again
 *
 * The old importer took the repeated headers and group names in as
 * records. Here they are recognised: groups become a "Group" column,
 * repeated headers are dropped.
 */
import type { ColumnType } from './repo.ts';

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const filled = (r: string[]) => r.filter(v => String(v ?? '').trim() !== '').length;
const same = (a: string[], b: string[]) =>
  b.every((v, i) => String(a[i] ?? '').trim() === String(v ?? '').trim()) && filled(a) === filled(b);

export interface Board {
  title: string;
  header: string[];
  /** Each item, with the group it sat under ('' when the board has none). */
  items: { group: string; cells: string[] }[];
  groups: string[];
  /** Text above the header that is not a group name — kept for the preview. */
  note: string;
}

/** A board from its rows. */
export function readBoard(rows: string[][], fallbackTitle = 'Imported'): Board {
  const probe = rows.slice(0, 10);
  // The original rule: the header is the fullest of the first ten rows.
  let h = 0;
  probe.forEach((r, i) => { if (filled(r) > filled(rows[h] ?? [])) h = i; });
  const header = (rows[h] ?? []).map(v => String(v ?? '').trim());

  const single = (r: string[]) => filled(r) === 1 && String(r[0] ?? '').trim() !== '';
  const isGroupName = (v: string) => v.length <= 60;
  const above = rows.slice(0, h).filter(single).map(r => String(r[0]).trim());
  const title = h > 0 && above.length ? above[0]! : fallbackTitle;
  const lead = above.slice(h > 0 ? 1 : 0);
  let group = lead.length && isGroupName(lead[lead.length - 1]!) ? lead[lead.length - 1]! : '';
  const note = lead.filter(v => v !== group).join(' ');

  const items: Board['items'] = [];
  const groups = group ? [group] : [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (!filled(r) || same(r, header)) continue;
    // A lone first cell with the header right after it is the next group.
    const next = rows.slice(i + 1).find(x => filled(x) > 0);
    if (single(r) && next && same(next, header)) {
      group = String(r[0]).trim();
      if (!groups.includes(group)) groups.push(group);
      continue;
    }
    items.push({ group, cells: header.map((_, c) => String(r[c] ?? '').trim()) });
  }
  return { title, header, items, groups, note };
}

/** Few enough distinct short values to be a status-style column? */
export function distinctOptions(values: string[]): string[] | null {
  const seen: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (v === '' || v.length > 30) return null;
    if (!seen.includes(v)) seen.push(v);
    if (seen.length > 8) return null;
  }
  return seen.length ? seen.sort() : null;
}

/** A column that holds passwords is imported encrypted unless someone says otherwise. */
export const SECRET_TITLE = /pass(word|code)?\b|password|\bpin\b|contraseña|clave/i;

export function guessType(title: string, values: string[]): ColumnType {
  if (SECRET_TITLE.test(title)) return 'secret';
  const v = values.map(x => x.trim()).filter(Boolean);
  if (!v.length) return 'text';
  const all = (t: (s: string) => boolean) => v.every(t);
  if (all(s => /^(true|false)$/i.test(s))) return 'checkbox';
  if (all(s => /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s))) return 'date';
  if (all(s => s !== '' && !Number.isNaN(Number(s.replace(/,/g, ''))))) return 'number';
  if (all(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))) return 'email';
  if (all(s => /^https?:\/\//i.test(s))) return 'url';
  const longest = Math.max(...v.map(s => s.length));
  if (distinctOptions(v) && v.length >= 5 && longest <= 30) return 'select';
  if (longest > 80) return 'longtext';
  return 'text';
}

export interface ProposedColumn {
  /** Index in the board's header; -1 for the Group column. */
  index: number; title: string; type: ColumnType; options: string[] | null;
  include: boolean; samples: string[]; filled: number;
}

/**
 * A column per header, typed by what it holds. Columns nobody ever filled
 * are proposed but left out. A secret's samples are never shown.
 */
export function proposeColumns(b: Board): ProposedColumn[] {
  const cols: ProposedColumn[] = b.header.map((title, index) => {
    const values = b.items.map(it => it.cells[index] ?? '').filter(v => v.trim() !== '');
    const type = guessType(title, values);
    return {
      index, title: title || `Column ${index + 1}`, type,
      options: type === 'select' ? distinctOptions(values) : null,
      include: !!title && values.length > 0, filled: values.length,
      samples: type === 'secret' ? values.slice(0, 3).map(() => '••••••••') : values.slice(0, 3).map(s => s.slice(0, 60))
    };
  });
  if (b.groups.length > 1) {
    cols.push({ index: -1, title: 'Group', type: 'select', options: [...b.groups], include: true,
                samples: b.groups.slice(0, 3), filled: b.items.length });
  }
  return cols;
}
