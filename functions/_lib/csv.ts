/**
 * CSV parsing for spreadsheet imports.
 *
 * Hand-written rather than a dependency because the input is a Google
 * Sheets export, and the only hard parts are quoted fields containing
 * commas, newlines, and escaped quotes — which is about thirty lines.
 *
 * Deliberately tolerant: a costs spreadsheet maintained by hand for years
 * will have trailing blank rows, a stray total line, and inconsistent
 * capitalisation in its headers. Rejecting the whole file over one of
 * those makes the import useless for exactly the people who need it.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header) return [];
  return toRecords(header, rows);
}

/**
 * The same, for a sheet whose header is not on the first line.
 *
 * Tabs drawn for people carry a banner above the table — the Inspection
 * Log opens with a merged title row — and reading that banner as the
 * header turns every real column into an unnamed one, which parses to
 * zero usable rows and reads as "nothing logged". The header is the
 * first row that names every column asked for.
 */
export function parseCsvFrom(text: string, required: string[]): Record<string, string>[] | null {
  const rows = parseCsvRows(text);
  const want = required.map(normKey);
  const at = rows.findIndex(r => {
    const keys = new Set(r.map(normKey));
    return want.every(k => keys.has(k));
  });
  if (at < 0) return null;
  return toRecords(rows[at]!, rows.slice(at + 1));
}

/**
 * Rows read against a header supplied by the caller, the file's own first
 * line dropped. Only for a layout that is fixed by its producer and whose
 * header row has been lost — see readCleaningsLog.
 */
export function parseCsvWithHeader(text: string, header: string[]): Record<string, string>[] {
  const rows = parseCsvRows(text);
  rows.shift();
  return toRecords(header, rows);
}

/** How many cells the first line of a CSV has. */
export function firstRowWidth(text: string): number {
  return parseCsvRows(text.split('\n', 1)[0] ?? '')[0]?.length ?? 0;
}

function normKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toRecords(header: string[], rows: string[][]): Record<string, string>[] {
  // Headers are normalised so "Start Date", "start_date" and "START DATE"
  // are the same column. A person exporting a sheet should not have to
  // guess our capitalisation.
  //
  // Everything that is not a letter or digit goes, which matters more
  // than it sounds: real sheets label columns "💲 Price" and "🧽 Deep".
  // Stripping only whitespace leaves the key as "💲price", so a lookup
  // for "price" misses and the column reads as empty — an import that
  // reports zero matches rather than an error.
  const keys = header.map(normKey);

  return rows
    .filter(r => r.some(cell => cell.trim() !== ''))   // drop blank lines
    .map(r => {
      const o: Record<string, string> = {};
      keys.forEach((k, i) => { if (k) o[k] = (r[i] ?? '').trim(); });
      return o;
    });
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') pushField();
    else if (c === '\n') pushRow();
    else field += c;
  }
  if (field || row.length) pushRow();
  return rows;
}

/** Reads the first header that matches any of the given aliases. */
export function pick(row: Record<string, string>, ...aliases: string[]): string {
  for (const a of aliases) {
    const key = a.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

/** "$1,234.56" and "(45.00)" both appear in real sheets. */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw.trim());
  const n = Number(raw.replace(/[()$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Accepts yyyy-mm-dd, dd/mm/yyyy and mm/dd/yyyy; returns ISO or ''. */
export function parseDate(raw: string, dayFirst = false): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = m[3];
    // Ambiguous by nature. If one part is over 12 it decides itself;
    // otherwise the caller's locale hint breaks the tie, because guessing
    // silently turns 03/04 into the wrong month for half the year.
    const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : (dayFirst ? [a, b] : [b, a]);
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return '';
}
