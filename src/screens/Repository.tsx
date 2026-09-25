/**
 * Repository — the Data Repository, looked up from inside Kaizen OS.
 *
 * The sections, tables and columns are whatever the repository says they
 * are today; nothing about its structure is known here in advance, the
 * same way the repository itself builds its forms from its metadata.
 *
 * For LOOKING THINGS UP: units, logins, buildings, and the documents
 * filed against each. Editing, structure, imports and access stay in the
 * repository's own app — it has the validation, the Drive folders and the
 * audit stamps that make those safe — and every record links there.
 *
 * Secrets arrive masked. An admin can reveal one; it is logged against
 * their name here, and masks itself again after thirty seconds, which is
 * the repository's own rule.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  getRepoMeta, getRepoRows, getRepoDocs, searchRepo, revealRepoSecret,
  type RepoColumn, type RepoFile, type RepoHit, type RepoRow, type RepoSection, type RepoTable
} from '../api.ts';

/** Columns the repository maintains itself; shown in the record, not the grid. */
const HIDDEN_IN_GRID = new Set(['folder', 'auto']);
const REMASK_MS = 30_000;

export function Repository({ canReveal }: { canReveal: boolean }) {
  const [sections, setSections] = useState<RepoSection[] | null>(null);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [table, setTable] = useState<RepoTable | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ q: string; results: RepoHit[]; searched: number } | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    getRepoMeta().then(r => {
      if (!r.ok) { setErr(r.message ?? 'Could not read the repository.'); return; }
      setSections(r.meta.sections);
      setAppUrl(r.appUrl);
      // Land on the first table rather than an empty panel.
      const first = r.meta.sections.flatMap(s => s.tables)[0];
      if (first) setTable(first);
    }).catch(e => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const runSearch = () => {
    const needle = q.trim();
    if (needle.length < 2) return;
    setSearching(true);
    searchRepo(needle)
      .then(r => r.ok ? setHits(r) : setErr(r.message ?? 'Search failed.'))
      .catch(e => setErr(String(e)))
      .finally(() => setSearching(false));
  };

  const byKey = useMemo(() => new Map((sections ?? []).flatMap(s => s.tables).map(t => [t.key, t])), [sections]);

  if (err && !sections) return <p className="banner warn">▲ {err}</p>;
  if (!sections) return <p className="note loading-dot">Reading the repository…</p>;

  return (
    <section className="repo">
      <aside className="repo-nav">
        <form onSubmit={e => { e.preventDefault(); runSearch(); }}>
          <input placeholder="Search everything" value={q} onChange={e => setQ(e.target.value)} />
        </form>
        {sections.map(s => (
          <div key={s.key} className="repo-section">
            <div className="repo-section-title">{s.title}</div>
            {s.tables.map(t => (
              <button key={t.key}
                      className={!hits && table?.key === t.key ? 'repo-table active' : 'repo-table'}
                      onClick={() => { setHits(null); setTable(t); }}>
                {t.title}
              </button>
            ))}
          </div>
        ))}
        {appUrl && (
          <a className="chip" href={appUrl} target="_blank" rel="noreferrer">Open the Data Repository ↗</a>
        )}
      </aside>

      <div className="repo-main">
        {err && <p className="banner warn">▲ {err}</p>}
        {searching && <p className="note loading-dot">Searching every table…</p>}
        {hits && !searching && (
          <SearchResults hits={hits} byKey={byKey} canReveal={canReveal} appUrl={appUrl}
                         onOpen={t => { setHits(null); setTable(t); }} />
        )}
        {!hits && table && <TableView key={table.key} table={table} canReveal={canReveal} appUrl={appUrl} />}
      </div>
    </section>
  );
}

function SearchResults({ hits, byKey, canReveal, appUrl, onOpen }: {
  hits: { q: string; results: RepoHit[]; searched: number };
  byKey: Map<string, RepoTable>; canReveal: boolean; appUrl: string | null;
  onOpen: (t: RepoTable) => void;
}) {
  const found = hits.results.filter(r => r.total > 0);
  const failed = hits.results.filter(r => r.problem);
  return (
    <>
      <h2 className="screen-title">“{hits.q}”</h2>
      <p className="note">
        {found.reduce((a, r) => a + r.total, 0)} match(es) across {hits.searched} table(s).
        Passwords are never searched — they arrive masked.
      </p>
      {/* A table that could not be read was NOT searched, and "no results"
          must not be allowed to mean both. */}
      {failed.map(f => (
        <p key={f.table} className="banner warn">▲ {f.title} could not be searched: {f.problem}</p>
      ))}
      {found.map(h => {
        const t = byKey.get(h.table);
        if (!t) return null;
        return (
          <div className="group" key={h.table}>
            <h3>
              {h.section} · {h.title} <span className="count">{h.total}</span>{' '}
              <button className="link" onClick={() => onOpen(t)}>open the table</button>
            </h3>
            <Grid table={t} rows={h.rows} canReveal={canReveal} appUrl={appUrl} />
            {h.total > h.rows.length && (
              <p className="note">First {h.rows.length} of {h.total} shown — open the table to see the rest.</p>
            )}
          </div>
        );
      })}
      {!found.length && !failed.length && <p className="note">Nothing matches.</p>}
    </>
  );
}

function TableView({ table, canReveal, appUrl }: { table: RepoTable; canReveal: boolean; appUrl: string | null }) {
  const [rows, setRows] = useState<RepoRow[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    getRepoRows(table.key)
      .then(r => r.ok ? setRows(r.rows) : setErr(r.message ?? 'Could not read the table.'))
      .catch(e => setErr(String(e)));
  }, [table.key]);

  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return !n ? rows ?? [] : (rows ?? []).filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(n)));
  }, [rows, filter]);

  return (
    <>
      <div className="row-controls">
        <h2 className="screen-title">{table.title}</h2>
        {rows && <span className="note">{shown.length === rows.length ? rows.length : `${shown.length} of ${rows.length}`} record(s)</span>}
        <input className="date-in" placeholder={`Filter ${table.title}`} value={filter}
               onChange={e => setFilter(e.target.value)} />
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
      {!rows && !err && <p className="note loading-dot">Loading…</p>}
      {rows && <Grid table={table} rows={shown} canReveal={canReveal} appUrl={appUrl} />}
      {rows && !rows.length && <p className="note">This table has no records yet.</p>}
    </>
  );
}

/** One record per row; clicking opens it in place — no dialog over the list it came from. */
function Grid({ table, rows, canReveal, appUrl }: {
  table: RepoTable; rows: RepoRow[]; canReveal: boolean; appUrl: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const cols = table.columns.filter(c => !HIDDEN_IN_GRID.has(c.type) && c.type !== 'doc');
  return (
    <div className="grid-scroll">
      <table className="units compact repo-grid">
        <thead><tr>{cols.map(c => <th key={c.key}>{c.title}</th>)}<th></th></tr></thead>
        <tbody>
          {rows.map(r => {
            const id = String(r.id);
            const isOpen = open === id;
            return (
              <Fragment key={id}>
                <tr className={isOpen ? 'repo-row open' : 'repo-row'} onClick={() => setOpen(isOpen ? null : id)}>
                  {cols.map(c => <td key={c.key}><Value col={c} value={r[c.key]} /></td>)}
                  <td className="n">{isOpen ? '▾' : '›'}</td>
                </tr>
                {isOpen && (
                  <tr className="repo-detail-row">
                    <td colSpan={cols.length + 1}>
                      <Record table={table} row={r} canReveal={canReveal} appUrl={appUrl} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Value({ col, value }: { col: RepoColumn; value: RepoRow[string] | undefined }) {
  const v = value == null ? '' : String(value);
  if (!v) return null;
  if (col.type === 'secret') return <span className="mono">••••••••</span>;
  if (col.type === 'checkbox') return <>{value === true || v === 'TRUE' || v === 'true' ? '✓' : ''}</>;
  if (col.type === 'url' || col.type === 'folder' || col.type === 'doc') {
    return <a href={v} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
      {col.type === 'url' ? v.replace(/^https?:\/\//, '').slice(0, 40) : 'open ↗'}</a>;
  }
  if (col.type === 'email') return <a href={`mailto:${v}`} onClick={e => e.stopPropagation()}>{v}</a>;
  if (col.type === 'select') return <span className="repo-pill">{v}</span>;
  if (col.type === 'longtext') return <span className="repo-long">{v}</span>;
  return <>{v}</>;
}

function Record({ table, row, canReveal, appUrl }: {
  table: RepoTable; row: RepoRow; canReveal: boolean; appUrl: string | null;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, RepoColumn[]>();
    table.columns.filter(c => c.type !== 'doc').forEach(c => {
      const g = c.group || 'Details';
      m.set(g, [...(m.get(g) ?? []), c]);
    });
    // The repository's own bookkeeping — id, folder, stamps — reads last:
    // it is what is looked up least.
    return [...m.entries()].sort((a, b) => Number(a[0] === 'System') - Number(b[0] === 'System'));
  }, [table]);
  const docCols = table.columns.filter(c => c.type === 'doc');

  return (
    <div className="repo-record">
      <div className="repo-fields">
        {groups.map(([g, cols]) => (
          <dl key={g} className="repo-group">
            <dt className="repo-group-title">{g}</dt>
            {cols.map(c => (
              <div key={c.key} className="repo-field">
                <span className="repo-label">{c.title}</span>
                <span>
                  {c.type === 'secret' && row[c.key]
                    ? <Secret table={table.key} id={String(row.id)} column={c.key} canReveal={canReveal} />
                    : <Value col={c} value={row[c.key]} />}
                </span>
              </div>
            ))}
          </dl>
        ))}
      </div>
      {docCols.map(c => <Docs key={c.key} table={table.key} id={String(row.id)} column={c} />)}
      {appUrl && (
        <p className="note">
          To change this record, use the <a href={appUrl} target="_blank" rel="noreferrer">Data Repository ↗</a> —
          it keeps the folders, validation and change history that make an edit safe.
        </p>
      )}
    </div>
  );
}

/** Loaded when the record opens, not with the table: Drive is the slow part. */
function Docs({ table, id, column }: { table: string; id: string; column: RepoColumn }) {
  const [files, setFiles] = useState<RepoFile[] | null>(null);
  const [folderUrl, setFolderUrl] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    getRepoDocs(table, id, column.key)
      .then(r => { if (r.ok) { setFiles(r.files); setFolderUrl(r.folderUrl); } else setErr(r.message ?? 'Could not list.'); })
      .catch(e => setErr(String(e)));
  }, [table, id, column.key]);
  return (
    <div className="repo-docs">
      <div className="repo-group-title">
        {column.title}{' '}
        {folderUrl && <a href={folderUrl} target="_blank" rel="noreferrer">open the folder ↗</a>}
      </div>
      {err && <span className="note">▲ {err}</span>}
      {!files && !err && <span className="note loading-dot">Listing files…</span>}
      {files && !files.length && <span className="note">No files yet.</span>}
      {files?.map(f => (
        <div key={f.fileId} className="repo-file">
          <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
          <span className="sub-n"> · {Math.max(1, Math.round(f.size / 1024))} KB · {f.updatedAt.slice(0, 10)}</span>
        </div>
      ))}
    </div>
  );
}

function Secret({ table, id, column, canReveal }: { table: string; id: string; column: string; canReveal: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  // Masks itself again — the repository's own rule, kept here so a
  // password left on screen does not stay on screen.
  useEffect(() => {
    if (value === null) return;
    const t = window.setTimeout(() => { setValue(null); setCopied(false); }, REMASK_MS);
    return () => window.clearTimeout(t);
  }, [value]);

  const reveal = () => {
    setBusy(true); setErr('');
    revealRepoSecret(table, id, column)
      .then(r => r.ok ? setValue(r.value) : setErr(r.message ?? 'Refused.'))
      .catch(e => setErr(String(e)))
      .finally(() => setBusy(false));
  };
  const copy = () => {
    if (value === null) return;
    navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => setErr('Could not copy.'));
  };

  if (value !== null) {
    return (
      <span className="repo-secret">
        <code>{value}</code>{' '}
        <button className="link tiny" onClick={copy}>{copied ? 'copied' : 'copy'}</button>{' '}
        <button className="link tiny" onClick={() => setValue(null)}>hide</button>
        <span className="sub-n"> · hides itself in 30s · this reveal was logged</span>
      </span>
    );
  }
  return (
    <span className="repo-secret">
      <span className="mono">••••••••</span>{' '}
      {canReveal
        ? <button className="link tiny" disabled={busy} onClick={reveal}>{busy ? 'decrypting…' : 'reveal'}</button>
        : <span className="sub-n">admins can reveal</span>}
      {err && <span className="breach"> {err}</span>}
    </span>
  );
}
