/**
 * Repository — the Data Repository, run from Kaizen OS.
 *
 * Its Sheet is still the database and its Drive folders still hold the
 * files; its engine still validates every write, builds each record's
 * folders and encrypts secrets. This screen is where people read and
 * change it, and Kaizen's roles decide who may (§66):
 *
 *   repository            read, search, open documents
 *   repository.reveal     show a password (logged, re-masks in 30 s)
 *   repository.edit       records and their documents
 *   repository.structure  sections, tables, columns
 *
 * The sections, tables and columns are whatever the repository says they
 * are today; nothing about its structure is known here in advance.
 *
 * Editing is in place: click a cell, type, Enter. Records open under
 * their row, never in a dialog over the list they belong to (§22).
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  getRepoMeta, getRepoRows, getRepoDocs, searchRepo, revealRepoSecret, repoEdit, repoStructure,
  type RepoColumn, type RepoFile, type RepoHit, type RepoRow, type RepoSection, type RepoTable
} from '../api.ts';

/** Maintained by the engine; shown in the record, never in the grid. */
const SYSTEM = new Set(['id', 'folder', 'auto']);
const USER_TYPES: [string, string][] = [
  ['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['date', 'Date'],
  ['checkbox', 'Checkbox'], ['select', 'Dropdown'], ['email', 'E-mail'], ['url', 'Link'],
  ['secret', 'Secret (encrypted)'], ['doc', 'Documents (Drive folder)']
];
/** Types the engine can convert between; the rest are fixed once created. */
const CONVERTIBLE = new Set(['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'email', 'url']);
const REMASK_MS = 30_000;
const MAX_UPLOAD = 10 * 1024 * 1024;

interface Can { reveal: boolean; edit: boolean; structure: boolean }

export function Repository({ canReveal, canEdit, canStructure }: {
  canReveal: boolean; canEdit: boolean; canStructure: boolean;
}) {
  const can: Can = { reveal: canReveal, edit: canEdit, structure: canStructure };
  const [sections, setSections] = useState<RepoSection[] | null>(null);
  const [err, setErr] = useState('');
  const [tableKey, setTableKey] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ q: string; results: RepoHit[]; searched: number } | null>(null);
  const [searching, setSearching] = useState(false);

  const loadMeta = () => getRepoMeta().then(r => {
    if (!r.ok) { setErr(r.message ?? 'Could not read the repository.'); return; }
    setSections(r.meta.sections);
    setTableKey(k => k ?? r.meta.sections.flatMap(s => s.tables)[0]?.key ?? null);
  }).catch(e => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void loadMeta(); }, []);

  const byKey = useMemo(() => new Map((sections ?? []).flatMap(s => s.tables).map(t => [t.key, t])), [sections]);
  const table = tableKey ? byKey.get(tableKey) ?? null : null;

  const runSearch = () => {
    const needle = q.trim();
    if (needle.length < 2) return;
    setSearching(true);
    searchRepo(needle)
      .then(r => r.ok ? setHits(r) : setErr(r.message ?? 'Search failed.'))
      .catch(e => setErr(String(e)))
      .finally(() => setSearching(false));
  };

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
            <div className="repo-section-title">
              <Rename enabled={can.structure} value={s.title}
                      onSave={t => repoStructure({ op: 'sections.rename', section: s.key, title: t }).then(r => { if (r.ok) void loadMeta(); return r; })} />
            </div>
            {s.tables.map(t => (
              <button key={t.key} className={!hits && tableKey === t.key ? 'repo-table active' : 'repo-table'}
                      onClick={() => { setHits(null); setTableKey(t.key); }}>
                {t.title}
              </button>
            ))}
            {can.structure && <NewTable section={s.key} onDone={k => { void loadMeta().then(() => { setHits(null); setTableKey(k); }); }} />}
          </div>
        ))}
        {can.structure && <NewSection onDone={() => void loadMeta()} />}
      </aside>

      <div className="repo-main">
        {err && <p className="banner warn">▲ {err}</p>}
        {searching && <p className="note loading-dot">Searching every table…</p>}
        {hits && !searching && (
          <SearchResults hits={hits} byKey={byKey} can={can}
                         onOpen={t => { setHits(null); setTableKey(t.key); }} />
        )}
        {!hits && table && <TableView key={table.key} table={table} can={can} byKey={byKey}
                                      onStructure={() => void loadMeta()} />}
      </div>
    </section>
  );
}

/* ── sidebar: structure ───────────────────────────────────────────── */

function NewSection({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState('');
  if (!open) return <button className="link tiny" onClick={() => setOpen(true)}>+ section</button>;
  return (
    <form className="repo-inline-form" onSubmit={async e => {
      e.preventDefault();
      const r = await repoStructure({ op: 'sections.create', title });
      if (!r.ok) { setMsg(r.message ?? 'Failed.'); return; }
      setOpen(false); setTitle(''); onDone();
    }}>
      <input autoFocus placeholder="Section name" value={title} onChange={e => setTitle(e.target.value)} />
      <button className="small" disabled={!title.trim()}>Add</button>
      {msg && <span className="breach">{msg}</span>}
    </form>
  );
}

function NewTable({ section, onDone }: { section: string; onDone: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [prefix, setPrefix] = useState('');
  const [msg, setMsg] = useState('');
  if (!open) return <button className="link tiny" onClick={() => setOpen(true)}>+ table</button>;
  return (
    <form className="repo-inline-form" onSubmit={async e => {
      e.preventDefault();
      const r = await repoStructure({ op: 'tables.create', section, title, idPrefix: prefix });
      if (!r.ok) { setMsg(r.message ?? 'Failed.'); return; }
      setOpen(false); setTitle(''); setPrefix(''); onDone(r.data?.key ?? '');
    }}>
      <input autoFocus placeholder="Table name" value={title} onChange={e => setTitle(e.target.value)} />
      <input placeholder="ID prefix, e.g. UNI (optional)" value={prefix} onChange={e => setPrefix(e.target.value)} />
      <button className="small" disabled={!title.trim()}>Create</button>
      {msg && <span className="breach">{msg}</span>}
    </form>
  );
}

/** A title that becomes an input on click, for those allowed to rename. */
function Rename({ enabled, value, onSave }: {
  enabled: boolean; value: string; onSave: (v: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [msg, setMsg] = useState('');
  if (!enabled || !editing) {
    return <span onDoubleClick={() => enabled && setEditing(true)} title={enabled ? 'Double-click to rename' : undefined}>{value}</span>;
  }
  const commit = async () => {
    if (!v.trim() || v === value) { setEditing(false); return; }
    const r = await onSave(v.trim());
    if (r.ok) setEditing(false); else setMsg(r.message ?? 'Failed.');
  };
  return (
    <>
      <input autoFocus value={v} onChange={e => setV(e.target.value)} onBlur={() => void commit()}
             onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setV(value); setEditing(false); } }} />
      {msg && <span className="breach"> {msg}</span>}
    </>
  );
}

/* ── search ───────────────────────────────────────────────────────── */

function SearchResults({ hits, byKey, can, onOpen }: {
  hits: { q: string; results: RepoHit[]; searched: number };
  byKey: Map<string, RepoTable>; can: Can; onOpen: (t: RepoTable) => void;
}) {
  const found = hits.results.filter(r => r.total > 0);
  const failed = hits.results.filter(r => r.problem);
  return (
    <>
      <h2 className="screen-title">“{hits.q}”</h2>
      <p className="note">
        {found.reduce((a, r) => a + r.total, 0)} match(es) across {hits.searched} table(s).
        Encrypted passwords are never searched — they arrive masked.
      </p>
      {/* A table that could not be read was NOT searched, and "no results"
          must not be allowed to mean both. */}
      {failed.map(f => <p key={f.table} className="banner warn">▲ {f.title} could not be searched: {f.problem}</p>)}
      {found.map(h => {
        const t = byKey.get(h.table);
        if (!t) return null;
        return (
          <div className="group" key={h.table}>
            <h3>{h.section} · {h.title} <span className="count">{h.total}</span>{' '}
              <button className="link" onClick={() => onOpen(t)}>open the table</button></h3>
            <Grid table={t} rows={h.rows} can={{ ...can, edit: false }} byKey={byKey} onRows={() => {}} />
            {h.total > h.rows.length && <p className="note">First {h.rows.length} of {h.total} — open the table for the rest.</p>}
          </div>
        );
      })}
      {!found.length && !failed.length && <p className="note">Nothing matches.</p>}
    </>
  );
}

/* ── a table ──────────────────────────────────────────────────────── */

function TableView({ table, can, byKey, onStructure }: {
  table: RepoTable; can: Can; byKey: Map<string, RepoTable>; onStructure: () => void;
}) {
  const [rows, setRows] = useState<RepoRow[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [columns, setColumns] = useState(false);

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
        <h2 className="screen-title">
          <Rename enabled={can.structure} value={table.title}
                  onSave={t => repoStructure({ op: 'tables.rename', table: table.key, title: t }).then(r => { if (r.ok) onStructure(); return r; })} />
        </h2>
        {rows && <span className="note">{shown.length === rows.length ? rows.length : `${shown.length} of ${rows.length}`} record(s)</span>}
        <input className="date-in" placeholder={`Filter ${table.title}`} value={filter} onChange={e => setFilter(e.target.value)} />
        {can.edit && <button className="chip" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ New record'}</button>}
        {can.structure && <button className={columns ? 'chip active' : 'chip'} onClick={() => setColumns(c => !c)}>Columns</button>}
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
      {columns && <ColumnsPanel table={table} onChanged={onStructure} />}
      {adding && rows && (
        <NewRecord table={table} byKey={byKey} onCreated={row => { setRows([row, ...rows]); setAdding(false); }} />
      )}
      {!rows && !err && <p className="note loading-dot">Loading…</p>}
      {rows && <Grid table={table} rows={shown} can={can} byKey={byKey}
                     onRows={f => setRows(rs => rs ? f(rs) : rs)} />}
      {rows && !rows.length && <p className="note">No records yet.</p>}
    </>
  );
}

function Grid({ table, rows, can, byKey, onRows }: {
  table: RepoTable; rows: RepoRow[]; can: Can; byKey: Map<string, RepoTable>;
  onRows: (f: (rs: RepoRow[]) => RepoRow[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const cols = table.columns.filter(c => !SYSTEM.has(c.type) && c.type !== 'doc');
  const idCol = table.columns.find(c => c.type === 'id');
  const replace = (id: string, row: RepoRow | null) =>
    onRows(rs => row ? rs.map(r => String(r.id) === id ? row : r) : rs.filter(r => String(r.id) !== id));

  return (
    <div className="grid-scroll">
      <table className="units compact repo-grid">
        <thead><tr>{idCol && <th>ID</th>}{cols.map(c => <th key={c.key}>{c.title}</th>)}<th></th></tr></thead>
        <tbody>
          {rows.map(r => {
            const id = String(r.id);
            const isOpen = open === id;
            return (
              <Fragment key={id}>
                <tr className={isOpen ? 'repo-row open' : 'repo-row'}>
                  {idCol && <td className="sub-n" onClick={() => setOpen(isOpen ? null : id)}>{id}</td>}
                  {cols.map(c => (
                    <td key={c.key}>
                      <Cell table={table} col={c} row={r} can={can} byKey={byKey} onSaved={row => replace(id, row)} />
                    </td>
                  ))}
                  <td className="n"><button className="link" onClick={() => setOpen(isOpen ? null : id)}>{isOpen ? '▾' : '›'}</button></td>
                </tr>
                {isOpen && (
                  <tr className="repo-detail-row">
                    <td colSpan={cols.length + 2}>
                      <Record table={table} row={r} can={can} byKey={byKey}
                              onSaved={row => replace(id, row)} onDeleted={() => { setOpen(null); replace(id, null); }} />
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

/* ── values: show and edit ────────────────────────────────────────── */

const asText = (v: RepoRow[string] | undefined) => v == null ? '' : String(v);
/** Dates come back as ISO timestamps from the sheet; a field wants the day. */
const asDay = (v: RepoRow[string] | undefined) => {
  const s = asText(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
};
const isChecked = (v: RepoRow[string] | undefined) => v === true || /^(true|yes|1)$/i.test(asText(v));

function Show({ col, value }: { col: RepoColumn; value: RepoRow[string] | undefined }) {
  const v = asText(value);
  if (col.type === 'checkbox') return <>{isChecked(value) ? '✓' : ''}</>;
  if (!v) return null;
  if (col.type === 'secret') return <span className="mono">••••••••</span>;
  if (col.type === 'url' || col.type === 'folder' || col.type === 'doc') {
    return <a href={v} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
      {col.type === 'url' ? v.replace(/^https?:\/\//, '').slice(0, 40) : 'open ↗'}</a>;
  }
  if (col.type === 'email') return <a href={`mailto:${v}`} onClick={e => e.stopPropagation()}>{v}</a>;
  if (col.type === 'select') return <span className="repo-pill">{v}</span>;
  if (col.type === 'date') return <>{asDay(value)}</>;
  if (col.type === 'longtext') return <span className="repo-long">{v}</span>;
  return <>{v}</>;
}

/** Only the field that changed is ever sent — see the mask rule in /api/repository-edit. */
async function saveField(table: RepoTable, row: RepoRow, col: RepoColumn, value: unknown) {
  return repoEdit({ op: 'update', table: table.key, id: String(row.id), values: { [col.key]: value } });
}

/** One grid cell: shows the value; a click turns it into the right input for its type. */
function Cell({ table, col, row, can, byKey, onSaved }: {
  table: RepoTable; col: RepoColumn; row: RepoRow; can: Can; byKey: Map<string, RepoTable>;
  onSaved: (row: RepoRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Secrets are changed from the record, where "set a new password" is
  // said in words; a grid cell is too easy to type into by accident.
  const editable = can.edit && col.editable && col.type !== 'secret';

  const commit = async (value: unknown) => {
    setEditing(false);
    if (asText(value as RepoRow[string]) === asText(row[col.key])) return;
    setBusy(true); setMsg('');
    const r = await saveField(table, row, col, value).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) onSaved(r.data as RepoRow); else setMsg(r.message ?? 'Not saved.');
  };

  if (editable && col.type === 'checkbox') {
    return <input type="checkbox" disabled={busy} checked={isChecked(row[col.key])} onChange={e => void commit(e.target.checked)} />;
  }
  if (editing) return <Editor col={col} value={row[col.key]} byKey={byKey} onCommit={v => void commit(v)} onCancel={() => setEditing(false)} />;
  return (
    <span className={editable ? 'repo-cell editable' : 'repo-cell'} onClick={() => editable && setEditing(true)}
          title={msg || (editable ? 'Click to edit' : undefined)}>
      {busy ? <span className="note loading-dot">saving</span> : <Show col={col} value={row[col.key]} />}
      {msg && <span className="breach"> ▲ {msg}</span>}
    </span>
  );
}

/** The input for a type. Enter or leaving the field saves; Escape cancels. */
function Editor({ col, value, byKey, onCommit, onCancel }: {
  col: RepoColumn; value: RepoRow[string] | undefined; byKey: Map<string, RepoTable>;
  onCommit: (v: unknown) => void; onCancel: () => void;
}) {
  const [v, setV] = useState(col.type === 'date' ? asDay(value) : asText(value));
  const [refOptions, setRefOptions] = useState<string[] | null>(null);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(col.type === 'number' ? (v === '' ? '' : Number(v)) : v);
  };
  const keys = (e: { key: string }) => {
    if (e.key === 'Escape') { done.current = true; onCancel(); }
    if (e.key === 'Enter' && col.type !== 'longtext') commit();
  };
  useEffect(() => {
    if (col.type !== 'ref' || !col.reference) return;
    getRepoRows(col.reference.table).then(r => {
      if (r.ok) setRefOptions([...new Set(r.rows.map(x => asText(x[col.reference!.column])).filter(Boolean))].sort());
    });
  }, [col]);

  if (col.type === 'select' || col.type === 'ref') {
    const opts = col.type === 'select' ? (col.options ?? []) : (refOptions ?? []);
    return (
      <select autoFocus value={v} onChange={e => { setV(e.target.value); done.current = true; onCommit(e.target.value); }}
              onBlur={() => { if (!done.current) onCancel(); }} onKeyDown={keys}>
        <option value="">—</option>
        {v && !opts.includes(v) && <option value={v}>{v}</option>}
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
        {col.type === 'ref' && !refOptions && <option disabled>loading {byKey.get(col.reference?.table ?? '')?.title ?? ''}…</option>}
      </select>
    );
  }
  if (col.type === 'longtext') {
    return <textarea autoFocus rows={3} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={keys} />;
  }
  const type = col.type === 'number' ? 'number' : col.type === 'date' ? 'date'
    : col.type === 'email' ? 'email' : col.type === 'url' ? 'url' : 'text';
  return <input autoFocus type={type} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={keys} />;
}

/* ── a new record ─────────────────────────────────────────────────── */

function NewRecord({ table, byKey, onCreated }: {
  table: RepoTable; byKey: Map<string, RepoTable>; onCreated: (row: RepoRow) => void;
}) {
  // The fields that name the record, plus anything required — the rest
  // are filled in on the record itself afterwards.
  const fields = table.columns.filter(c => c.editable && c.type !== 'doc' && c.type !== 'secret' &&
    (c.required || table.nameFields.includes(c.key)));
  const first = fields.length ? fields : table.columns.filter(c => c.editable && c.type === 'text').slice(0, 1);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true); setMsg('');
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== undefined));
    const r = await repoEdit({ op: 'create', table: table.key, values: clean }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not created.'); return; }
    onCreated(r.data as RepoRow);
  };

  return (
    <div className="card repo-new">
      <div className="row">
        {first.map(c => (
          <label key={c.key}>{c.title}{c.required ? ' *' : ''}
            {c.type === 'select'
              ? <select value={String(values[c.key] ?? '')} onChange={e => setValues(v => ({ ...v, [c.key]: e.target.value }))}>
                  <option value="">—</option>{(c.options ?? []).map(o => <option key={o}>{o}</option>)}</select>
              : <input value={String(values[c.key] ?? '')} onChange={e => setValues(v => ({ ...v, [c.key]: e.target.value }))} />}
          </label>
        ))}
        <button disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
      <p className="note">Creates the record with its ID and its Drive folders. Everything else is filled in on the record.</p>
      {msg && <p className="banner error">{msg}</p>}
    </div>
  );
}

/* ── a record, opened ─────────────────────────────────────────────── */

function Record({ table, row, can, byKey, onSaved, onDeleted }: {
  table: RepoTable; row: RepoRow; can: Can; byKey: Map<string, RepoTable>;
  onSaved: (row: RepoRow) => void; onDeleted: () => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, RepoColumn[]>();
    table.columns.filter(c => c.type !== 'doc').forEach(c => m.set(c.group || 'Details', [...(m.get(c.group || 'Details') ?? []), c]));
    // The engine's own bookkeeping reads last: it is looked up least.
    return [...m.entries()].sort((a, b) => Number(a[0] === 'System') - Number(b[0] === 'System'));
  }, [table]);
  const docCols = table.columns.filter(c => c.type === 'doc');
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState('');

  const remove = async () => {
    const r = await repoEdit({ op: 'delete', table: table.key, id: String(row.id) }).catch(e => ({ ok: false as const, message: String(e) }));
    if (r.ok) onDeleted(); else setMsg(r.message ?? 'Not deleted.');
  };

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
                  {c.type === 'secret'
                    ? <Secret table={table} row={row} col={c} can={can} onSaved={onSaved} />
                    : <Cell table={table} col={c} row={row} can={can} byKey={byKey} onSaved={onSaved} />}
                </span>
              </div>
            ))}
          </dl>
        ))}
      </div>
      {docCols.map(c => <Docs key={c.key} table={table} id={String(row.id)} column={c} can={can} />)}
      {can.edit && (
        <div className="button-row">
          {!confirm
            ? <button className="link danger" onClick={() => setConfirm(true)}>Delete record…</button>
            : <>
                <span className="note">Removes the row; its Drive folder moves to the table's _Archive, nothing is erased.</span>
                <button className="small danger-btn" onClick={() => void remove()}>Delete {String(row.id)}</button>
                <button className="link" onClick={() => setConfirm(false)}>keep it</button>
              </>}
          {msg && <span className="breach">{msg}</span>}
        </div>
      )}
    </div>
  );
}

/** Loaded when the record opens, not with the table: Drive is the slow part. */
function Docs({ table, id, column, can }: { table: RepoTable; id: string; column: RepoColumn; can: Can }) {
  const [files, setFiles] = useState<RepoFile[] | null>(null);
  const [folderUrl, setFolderUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [drag, setDrag] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = () => getRepoDocs(table.key, id, column.key)
    .then(r => { if (r.ok) { setFiles(r.files); setFolderUrl(r.folderUrl); } else setErr(r.message ?? 'Could not list.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [table.key, id, column.key]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setErr('');
    const all = [...list];
    for (const [i, f] of all.entries()) {
      if (f.size > MAX_UPLOAD) { setErr(`${f.name} is over 10 MB.`); continue; }
      setBusy(`Uploading ${i + 1} of ${all.length}…`);
      const data = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1] ?? '');
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(f);
      });
      const r = await repoEdit({ op: 'docs.upload', table: table.key, id, column: column.key,
                                 name: f.name, mimeType: f.type || 'application/octet-stream', data })
        .catch(e => ({ ok: false as const, message: String(e) }));
      if (!r.ok) setErr(`${f.name}: ${r.message ?? 'failed'}`);
    }
    setBusy(''); void load();
  };
  const act = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    const r = await repoEdit(body).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(''); setConfirmDel(null);
    if (!r.ok) setErr(r.message ?? 'Failed.'); else void load();
  };

  return (
    <div className={`repo-docs ${drag ? 'dragging' : ''}`}
         onDragOver={e => { if (can.edit) { e.preventDefault(); setDrag(true); } }}
         onDragLeave={() => setDrag(false)}
         onDrop={e => { e.preventDefault(); setDrag(false); if (can.edit) void upload(e.dataTransfer.files); }}>
      <div className="repo-group-title">
        {column.title}{' '}
        {folderUrl && <a href={folderUrl} target="_blank" rel="noreferrer">folder ↗</a>}
      </div>
      {err && <div className="breach">▲ {err}</div>}
      {busy && <div className="note loading-dot">{busy}</div>}
      {!files && !err && <span className="note loading-dot">Listing files…</span>}
      {files && !files.length && <span className="note">No files yet.{can.edit ? ' Drop files here.' : ''}</span>}
      {files?.map(f => (
        <div key={f.fileId} className="repo-file">
          <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a>
          <span className="sub-n"> · {Math.max(1, Math.round(f.size / 1024))} KB · {f.updatedAt.slice(0, 10)}</span>
          {can.edit && (confirmDel === f.fileId
            ? <> <button className="link tiny danger" onClick={() => void act({ op: 'docs.delete', fileId: f.fileId }, 'Moving to Drive\'s trash…')}>to trash (30 days)</button>
                 <button className="link tiny" onClick={() => setConfirmDel(null)}>keep</button></>
            : <> <button className="link tiny" onClick={() => {
                   const name = window.prompt('New name', f.name);
                   if (name && name !== f.name) void act({ op: 'docs.rename', fileId: f.fileId, name }, 'Renaming…');
                 }}>rename</button>
                 <button className="link tiny danger" onClick={() => setConfirmDel(f.fileId)}>remove</button></>)}
        </div>
      ))}
      {can.edit && (
        <div className="button-row">
          <label className="chip file-chip">Upload files<input type="file" multiple hidden onChange={e => void upload(e.target.files)} /></label>
          <button className="link tiny" onClick={() => void act({ op: 'docs.create', table: table.key, id, column: column.key, kind: 'doc' }, 'Creating a Google Doc…')}>+ Google Doc</button>
          <button className="link tiny" onClick={() => void act({ op: 'docs.create', table: table.key, id, column: column.key, kind: 'sheet' }, 'Creating a Google Sheet…')}>+ Google Sheet</button>
        </div>
      )}
    </div>
  );
}

/**
 * A password: masked, revealed on request (logged), and SET, never
 * edited — the field starts empty and only a typed value is ever sent,
 * so the mask can never be written back as the password.
 */
function Secret({ table, row, col, can, onSaved }: {
  table: RepoTable; row: RepoRow; col: RepoColumn; can: Can; onSaved: (row: RepoRow) => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [setting, setSetting] = useState(false);
  const [next, setNext] = useState('');
  const has = !!asText(row[col.key]);

  useEffect(() => {
    if (value === null) return;
    const t = window.setTimeout(() => { setValue(null); setCopied(false); }, REMASK_MS);
    return () => window.clearTimeout(t);
  }, [value]);

  const reveal = () => {
    setBusy(true); setErr('');
    revealRepoSecret(table.key, String(row.id), col.key)
      .then(r => r.ok ? setValue(r.value) : setErr(r.message ?? 'Refused.'))
      .catch(e => setErr(String(e)))
      .finally(() => setBusy(false));
  };
  const save = async () => {
    setBusy(true); setErr('');
    const r = await saveField(table, row, col, next).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? 'Not saved.'); return; }
    setSetting(false); setNext(''); setValue(null); onSaved(r.data as RepoRow);
  };

  if (setting) {
    return (
      <span className="repo-secret">
        <input type="password" autoFocus autoComplete="new-password" value={next} placeholder="New value"
               onChange={e => setNext(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && next) void save(); }} />{' '}
        <button className="link tiny" disabled={!next || busy} onClick={() => void save()}>save</button>{' '}
        <button className="link tiny" onClick={() => { setSetting(false); setNext(''); }}>cancel</button>
        {err && <span className="breach"> {err}</span>}
      </span>
    );
  }
  if (value !== null) {
    return (
      <span className="repo-secret">
        <code>{value}</code>{' '}
        <button className="link tiny" onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true))}>{copied ? 'copied' : 'copy'}</button>{' '}
        <button className="link tiny" onClick={() => setValue(null)}>hide</button>
        <span className="sub-n"> · hides itself in 30s · this reveal was logged</span>
      </span>
    );
  }
  return (
    <span className="repo-secret">
      {has ? <span className="mono">••••••••</span> : <span className="note">not set</span>}{' '}
      {has && can.reveal && <button className="link tiny" disabled={busy} onClick={reveal}>{busy ? 'decrypting…' : 'reveal'}</button>}
      {can.edit && <> <button className="link tiny" onClick={() => setSetting(true)}>{has ? 'change' : 'set'}</button></>}
      {err && <span className="breach"> {err}</span>}
    </span>
  );
}

/* ── columns (structure) ──────────────────────────────────────────── */

function ColumnsPanel({ table, onChanged }: { table: RepoTable; onChanged: () => void }) {
  const cols = table.columns.filter(c => !SYSTEM.has(c.type));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('text');
  const [options, setOptions] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    const r = await repoStructure({ table: table.key, ...body }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: done } : { ok: false, text: r.message ?? 'Failed.' });
    if (r.ok) onChanged();
  };
  const split = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);

  return (
    <div className="card repo-columns">
      <h2>Columns of {table.title}</h2>
      <table className="units compact">
        <thead><tr><th>Name</th><th>Type</th><th>Dropdown options</th><th></th></tr></thead>
        <tbody>
          {cols.map((c, i) => (
            <tr key={c.key}>
              <td><Rename enabled value={c.title} onSave={t => repoStructure({ op: 'columns.update', table: table.key, columnKey: c.key, changes: { title: t } })
                  .then(r => { if (r.ok) onChanged(); return r; })} /></td>
              <td>
                {CONVERTIBLE.has(c.type)
                  ? <select value={c.type} disabled={busy} onChange={e => void run({ op: 'columns.update', columnKey: c.key, changes: { type: e.target.value } }, `${c.title} is now ${e.target.value}.`)}>
                      {USER_TYPES.filter(([k]) => CONVERTIBLE.has(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  : <span className="sub-n">{USER_TYPES.find(([k]) => k === c.type)?.[1] ?? c.type} · fixed</span>}
              </td>
              <td>{c.type === 'select' && (
                <input defaultValue={(c.options ?? []).join(', ')} disabled={busy}
                       onBlur={e => {
                         const next = split(e.target.value);
                         if (next.join('|') !== (c.options ?? []).join('|')) void run({ op: 'columns.update', columnKey: c.key, changes: { options: next } }, `${c.title}: options saved.`);
                       }} />
              )}</td>
              <td className="n">
                <button className="link tiny" disabled={busy || i === 0} onClick={() => void run({ op: 'columns.move', columnKey: c.key, direction: 'left' }, 'Moved.')}>←</button>
                <button className="link tiny" disabled={busy || i === cols.length - 1} onClick={() => void run({ op: 'columns.move', columnKey: c.key, direction: 'right' }, 'Moved.')}>→</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <label>New column<input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Insurance expiry" /></label>
        <label>Type<select value={type} onChange={e => setType(e.target.value)}>
          {USER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {type === 'select' && <label>Options (comma-separated)<input value={options} onChange={e => setOptions(e.target.value)} /></label>}
        <button disabled={busy || !title.trim()} onClick={() => void run({ op: 'columns.add', column: { title, type, options: split(options) } }, `${title} added.`).then(() => { setTitle(''); setOptions(''); })}>Add</button>
      </div>
      <p className="note">
        Double-click a name to rename it. Text, numbers, dates, links and dropdowns convert into one another; secret,
        document and reference columns are fixed once created. Deleting a column erases its data from the sheet, so it is
        not offered here.
      </p>
      {msg && <p className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}
    </div>
  );
}
