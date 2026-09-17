import { useState } from 'react';
import { importCsv, type ImportResult } from '../api.ts';

/**
 * Bringing an existing spreadsheet in.
 *
 * A host switching to this has years of costs in a Google Sheet. Asking
 * them to retype it is asking them not to switch, so File → Download →
 * CSV → drop it here has to work.
 *
 * Always previews before writing. Nobody should discover that a column
 * was misread by finding it in their accounts — and an import is the one
 * operation where being wrong is both easy and invisible.
 */
export function ImportPanel({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<'expenses' | 'claims'>('expenses');
  const [csv, setCsv] = useState('');
  const [dayFirst, setDayFirst] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = async (file: File) => setCsv(await file.text());

  const run = async (commit: boolean) => {
    setBusy(true);
    try {
      setResult(await importCsv(kind, csv, { commit, dayFirst }));
      if (commit) onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Import from a spreadsheet</h2>
      <p className="note">
        Export any sheet as CSV and drop it here. Columns are matched by name, so{' '}
        <code>Start Date</code>, <code>start_date</code> and <code>DATE</code> are the same thing.
        Units are matched by the name in the sheet — <code>CL 1446</code> finds <code>CL1446</code>.
      </p>

      <div className="row">
        <label>
          What is this?
          <select value={kind} onChange={e => setKind(e.target.value as 'expenses' | 'claims')}>
            <option value="expenses">Expenses / costs</option>
            <option value="claims">Guest claims</option>
          </select>
        </label>
        <label>
          CSV file
          <input type="file" accept=".csv,text/csv"
                 onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        </label>
      </div>

      <label className="check">
        <input type="checkbox" checked={dayFirst} onChange={e => setDayFirst(e.target.checked)} />
        {/* 03/04 is ambiguous for eleven months of the year, so this is
            asked rather than guessed. */}
        Dates are day/month/year (tick for European format)
      </label>

      <textarea value={csv} onChange={e => setCsv(e.target.value)} rows={6}
                placeholder="…or paste CSV directly" />

      <div className="row">
        <button onClick={() => void run(false)} disabled={!csv.trim() || busy}>
          Preview
        </button>
        <button className="secondary" onClick={() => void run(true)}
                disabled={!result?.dryRun || !result.ready || busy}>
          Import {result?.ready ?? 0} row(s)
        </button>
      </div>

      {result && (
        <div className={`banner ${result.ok ? (result.skipped ? 'warn' : 'ok') : 'error'}`}>
          {result.error ? result.error : result.dryRun
            ? `${result.ready} of ${result.total} row(s) ready${result.skipped ? `, ${result.skipped} need attention` : ''}.`
            : `Imported ${result.written} row(s)${result.skipped ? `, skipped ${result.skipped}` : ''}.`}
        </div>
      )}

      {result?.problems && result.problems.length > 0 && (
        <table>
          <thead><tr><th>Row</th><th>Why it was skipped</th></tr></thead>
          <tbody>
            {result.problems.map(p => (
              <tr key={p.row}><td>{p.row}</td><td>{p.problem}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
