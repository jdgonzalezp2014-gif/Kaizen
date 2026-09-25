/**
 * Repository — the Data Repository, run from Kaizen OS.
 *
 * The repository lives in Kaizen's database (§71): structure, records and
 * encrypted secrets; Google Drive keeps the files (§72). This is the
 * screen people work in, redesigned from the old repository's own app,
 * which got the hard part right: THE GRID IS THE WORKSPACE.
 *
 *   · Rows are one line, 42px, clipped with an ellipsis. A cell that wraps
 *     turns a table of 21 units into three screens of scrolling.
 *   · The header and the ID/name columns stay put while the rest scrolls,
 *     because 38 columns only make sense next to the name they belong to.
 *   · Everything happens where it is: click a cell to edit it, a dropdown
 *     opens its picker, a documents cell opens its files with a drop zone,
 *     each column header carries its own menu, the "+" at the end adds a
 *     column, and typing in the last, empty row creates a record.
 *   · The record opens BESIDE the grid, not over it (§22): the list stays
 *     in view, because it is what the record is compared against.
 *   · Saves are optimistic and say so; a refused save puts the old value
 *     back and says why.
 *
 * What each person may do comes from Kaizen's roles: repository (read),
 * repository.reveal, repository.edit, repository.structure.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  getRepoMeta, getRepoRows, getRepoDocs, getRepoDocsBatch, searchRepo, revealRepoSecret, repoEdit, repoStructure, uploadRepoFile,
  importReadFile, importReadLink, importCommit,
  type RepoColumn, type RepoFile, type RepoHit, type RepoRow, type RepoSection, type RepoTable
} from '../api.ts';
import { proposeColumns, readBoard, type Board, type ProposedColumn } from '../lib/repo-import.ts';
import { coerce, type ColumnType } from '../lib/repo.ts';

interface Can { reveal: boolean; edit: boolean; structure: boolean }
type DocEntry = { folderUrl: string; files: RepoFile[]; truncated?: boolean };

/** The store's own columns: never typed into. */
const SYSTEM_TYPES = new Set(['id', 'folder', 'auto']);
const TYPE_LABEL: Record<string, string> = {
  text: 'Text', longtext: 'Long text', number: 'Number', date: 'Date', checkbox: 'Checkbox',
  select: 'Dropdown', email: 'E-mail', url: 'Link', ref: 'Reference', secret: 'Secret (encrypted)',
  doc: 'Documents (Drive)', id: 'ID', folder: 'Row folder', auto: 'Audit'
};
/** Types that convert into one another (src/lib/repo.ts). Secret, documents and reference are fixed once made. */
const CONVERTIBLE = ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'email', 'url'];
const NEW_TYPES = [...CONVERTIBLE, 'secret', 'doc'];
/** What a conversion does to the values already there — said before it runs. */
const CONVERSION: Record<string, string> = {
  date: 'Values become dates (yyyy-mm-dd); anything that is not a date is cleared.',
  number: 'Text is stripped to digits; anything left over is cleared.',
  select: 'Only values on the option list are kept; the rest are cleared.',
  checkbox: 'true / yes / 1 / x become ticked, everything else unticked.'
};
const REMASK_MS = 30_000;
const POLL_MS = 60_000;
/** The file passes through Kaizen on its way to Drive (repository-upload.ts). */
const MAX_UPLOAD = 50 * 1024 * 1024;

/* ── small helpers ────────────────────────────────────────────────── */

const text = (v: RepoRow[string] | undefined) => v == null ? '' : String(v);
const isEmpty = (v: RepoRow[string] | undefined) => text(v).trim() === '';
const day = (v: RepoRow[string] | undefined) => { const s = text(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s; };
const ticked = (v: RepoRow[string] | undefined) => v === true || /^(true|yes|1|x)$/i.test(text(v));
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const userColumns = (t: RepoTable) => t.columns.filter(c => !c.system && !SYSTEM_TYPES.has(c.type));
const primaryKey = (t: RepoTable) => t.nameFields[0] ?? userColumns(t).find(c => c.type === 'text')?.key ?? '';
const fileGlyph = (mime: string) => /image\//.test(mime) ? '🖼' : /pdf/.test(mime) ? '📕'
  : /spreadsheet|excel|csv/.test(mime) ? '📊' : /presentation/.test(mime) ? '📽' : /document|word/.test(mime) ? '📝' : '📄';
type Fail = { ok: false; message?: string };
const safe = <T,>(p: Promise<T>) => p.catch(e => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as Fail);

/* ── toast and popover ────────────────────────────────────────────── */

function useToast() {
  const [t, setT] = useState<{ msg: string; bad: boolean; n: number } | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = window.setTimeout(() => setT(null), t.bad ? 6500 : 2200);
    return () => window.clearTimeout(id);
  }, [t]);
  const say = useCallback((msg: string, bad = false) => setT(p => ({ msg, bad, n: (p?.n ?? 0) + 1 })), []);
  const node = t ? <div className={`rb-toast ${t.bad ? 'bad' : ''}`} role="status">{t.bad ? '▲ ' : '✓ '}{t.msg}</div> : null;
  return [say, node] as const;
}

/**
 * A small panel anchored under what opened it. Fixed-positioned and kept
 * inside the window; closes on Escape, a click outside, or the grid
 * scrolling away from it — the three ways people expect a menu to go.
 */
function Popover({ anchor, onClose, width = 280, children }: {
  anchor: DOMRect; onClose: () => void; width?: number; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 6, left: anchor.left });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const h = el.offsetHeight;
      setPos({
        top: anchor.bottom + 6 + h > window.innerHeight - 10 ? Math.max(10, anchor.top - h - 6) : anchor.bottom + 6,
        left: Math.max(10, Math.min(anchor.left, window.innerWidth - width - 10))
      });
    }
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.setTimeout(() => document.addEventListener('mousedown', down), 0);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
    };
  }, []);
  return createPortal(
    <div ref={ref} className="rb-pop" style={{ top: pos.top, left: pos.left, width }}>{children}</div>, document.body);
}

/** A destructive action asks in place; typing the name is required where a click must not be enough. */
function Confirm({ title, message, typed, action, onConfirm, onCancel }: {
  title: string; message: string; typed?: string; action: string;
  onConfirm: (typed: string) => void; onCancel: () => void;
}) {
  const [v, setV] = useState('');
  return (
    <div className="rb-confirm">
      <div className="rb-pop-title">{title}</div>
      <p>{message}</p>
      {typed && <input autoFocus placeholder={`Type “${typed}”`} value={v} onChange={e => setV(e.target.value)} />}
      <div className="rb-pop-actions">
        <button className="secondary small" onClick={onCancel}>Cancel</button>
        <button className="small rb-danger" disabled={!!typed && v.trim() !== typed} onClick={() => onConfirm(v.trim())}>{action}</button>
      </div>
    </div>
  );
}

/* ── the screen ───────────────────────────────────────────────────── */

type Pop =
  | { kind: 'select'; rect: DOMRect; row: RepoRow | null; col: RepoColumn }
  | { kind: 'docs'; rect: DOMRect; row: RepoRow; col: RepoColumn }
  | { kind: 'colmenu'; rect: DOMRect; col: RepoColumn }
  | { kind: 'addcol'; rect: DOMRect }
  | { kind: 'text'; rect: DOMRect; row: RepoRow; col: RepoColumn }
  | { kind: 'table'; rect: DOMRect; table: RepoTable }
  | { kind: 'newtable'; rect: DOMRect; section: RepoSection }
  | { kind: 'newsection'; rect: DOMRect };

export function Repository({ canReveal, canEdit, canStructure }: {
  canReveal: boolean; canEdit: boolean; canStructure: boolean;
}) {
  const can: Can = { reveal: canReveal, edit: canEdit, structure: canStructure };
  const [sections, setSections] = useState<RepoSection[] | null>(null);
  const [err, setErr] = useState('');
  const [tableKey, setTableKey] = useState<string | null>(null);
  const [rowsBy, setRowsBy] = useState<Record<string, RepoRow[]>>({});
  const [docs, setDocs] = useState<Record<string, DocEntry>>({});
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [hits, setHits] = useState<{ q: string; results: RepoHit[]; searched: number } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [editing, setEditing] = useState<string | null>(null);   // `${id}|${col}`
  const [importing, setImporting] = useState<string | null>(null); // section key, while a Monday board is being imported
  const [say, toast] = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  const tables = useMemo(() => (sections ?? []).flatMap(s => s.tables), [sections]);
  const table = tables.find(t => t.key === tableKey) ?? null;
  const rows = tableKey ? rowsBy[tableKey] : undefined;

  const loadMeta = useCallback(async () => {
    const r = await safe(getRepoMeta());
    if (!r.ok) { setErr(r.message ?? 'Could not read the repository.'); return; }
    setSections(r.meta.sections);
    setTableKey(k => k && r.meta.sections.some(s => s.tables.some(t => t.key === k)) ? k
      : r.meta.sections.flatMap(s => s.tables)[0]?.key ?? null);
  }, []);
  const loadRows = useCallback(async (key: string, quiet = false) => {
    if (!quiet) setLoading(true);
    const r = await safe(getRepoRows(key));
    if (!quiet) setLoading(false);
    if (r.ok) setRowsBy(m => ({ ...m, [key]: r.rows }));
    else if (!quiet) say(r.message ?? 'Could not read the table.', true);
  }, [say]);

  useEffect(() => { void loadMeta(); }, [loadMeta]);
  useEffect(() => { if (tableKey) { setOpenId(null); void loadRows(tableKey, !!rowsBy[tableKey]); } }, [tableKey]);

  // Files for every visible row: one call per document column, as the
  // repository's own grid did. The cells show what each record holds
  // without anyone opening it.
  useEffect(() => {
    if (!table || !rows?.length) return;
    for (const col of table.columns.filter(c => c.type === 'doc')) {
      const missing = rows.map(r => String(r.id)).filter(id => !docs[`${table.key}|${col.key}|${id}`]).slice(0, 80);
      if (!missing.length) continue;
      void safe(getRepoDocsBatch(table.key, col.key, missing)).then(r => {
        if (!r.ok) return;
        setDocs(d => ({ ...d, ...Object.fromEntries(Object.entries(r.docs).map(([id, e]) => [`${table.key}|${col.key}|${id}`, e])) }));
      });
    }
  }, [table?.key, rows?.length]);

  // A colleague's edit appears on its own — but never under someone who is
  // typing, choosing, or reading an open menu, and not in a hidden tab.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!tableKey || editing || pop || document.visibilityState !== 'visible') return;
      void loadRows(tableKey, true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [tableKey, editing, pop, loadRows]);

  // "/" searches, Escape closes, as in the repository's app.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape' && !pop && !typing) setOpenId(null);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [pop]);

  const replaceRow = (key: string, id: string, row: RepoRow | null) =>
    setRowsBy(m => ({ ...m, [key]: (m[key] ?? []).flatMap(r => String(r.id) !== id ? [r] : row ? [row] : []) }));

  /** Optimistic: shown at once, put back if the rules refuse. */
  const saveCell = async (row: RepoRow, col: RepoColumn, value: unknown) => {
    if (!table) return;
    const id = String(row.id);
    if (text(value as RepoRow[string]) === text(row[col.key])) return;
    replaceRow(table.key, id, { ...row, [col.key]: value as RepoRow[string] });
    const r = await safe(repoEdit({ op: 'update', table: table.key, id, values: { [col.key]: value } }));
    if (r.ok) { replaceRow(table.key, id, r.data as RepoRow); say('Saved'); }
    else { replaceRow(table.key, id, row); say(r.message ?? 'Not saved.', true); }
  };
  const createRow = async (values: Record<string, unknown>) => {
    if (!table) return;
    const r = await safe(repoEdit({ op: 'create', table: table.key, values }));
    if (!r.ok) { say(r.message ?? 'Not created.', true); return; }
    const row = r.data as RepoRow;
    setRowsBy(m => ({ ...m, [table.key]: [...(m[table.key] ?? []), row] }));
    say(`Created ${row.id}`);
    setOpenId(String(row.id));
  };
  const structure = async (body: Record<string, unknown>, done: string) => {
    const r = await safe(repoStructure(body));
    if (!r.ok) { say(r.message ?? 'Failed.', true); return false; }
    say(done); setPop(null); await loadMeta();
    if (tableKey) void loadRows(tableKey, true);
    return true;
  };
  const refreshDocs = async (row: RepoRow, col: RepoColumn) => {
    if (!table) return;
    const r = await safe(getRepoDocs(table.key, String(row.id), col.key));
    if (r.ok) setDocs(d => ({ ...d, [`${table.key}|${col.key}|${row.id}`]: { folderUrl: r.folderUrl, files: r.files } }));
  };

  const runSearch = async () => {
    const q = filter.trim();
    if (q.length < 2) return;
    setLoading(true);
    const r = await safe(searchRepo(q));
    setLoading(false);
    if (r.ok) setHits(r); else say(r.message ?? 'Search failed.', true);
  };

  if (err && !sections) return <p className="banner warn">▲ {err}</p>;
  if (!sections) return <div className="rb"><div className="rb-skel" /></div>;

  const openRow = openId && rows ? rows.find(r => String(r.id) === openId) ?? null : null;

  return (
    <section className="rb">
      <aside className="rb-nav">
        {sections.map(s => (
          <div key={s.key} className="rb-nav-section">
            <div className="rb-nav-head">
              <span>{s.title}</span>
              {can.structure && <button className="rb-icon" title={`New table in ${s.title}`}
                onClick={e => setPop({ kind: 'newtable', rect: e.currentTarget.getBoundingClientRect(), section: s })}>+</button>}
            </div>
            {s.tables.map(t => (
              <div key={t.key} className={`rb-nav-item ${!hits && tableKey === t.key ? 'active' : ''}`}>
                <button className="rb-nav-link" onClick={() => { setHits(null); setImporting(null); setFilter(''); setTableKey(t.key); }}>
                  {t.title}
                  {rowsBy[t.key] && <span className="rb-nav-count">{rowsBy[t.key]!.length}</span>}
                </button>
                {can.structure && <button className="rb-icon rb-hover" title="Table options"
                  onClick={e => setPop({ kind: 'table', rect: e.currentTarget.getBoundingClientRect(), table: t })}>⋯</button>}
              </div>
            ))}
          </div>
        ))}
        {can.structure && <button className="rb-add-link" onClick={e => setPop({ kind: 'newsection', rect: e.currentTarget.getBoundingClientRect() })}>+ New section</button>}
        {can.structure && <button className="rb-add-link" onClick={() => { setHits(null); setImporting(sections[0]?.key ?? ''); }}>⇪ Import from Monday</button>}
      </aside>

      <div className="rb-main">
        <header className="rb-bar">
          <h2>{hits ? `Search: “${hits.q}”` : table?.title ?? ''}</h2>
          {!hits && rows && <span className="rb-count">{rows.length} record{rows.length === 1 ? '' : 's'}</span>}
          {loading && <span className="rb-count loading-dot">Loading</span>}
          <span className="rb-spacer" />
          <form className="rb-search" onSubmit={e => { e.preventDefault(); void runSearch(); }}>
            <input ref={searchRef} type="search" value={filter} onChange={e => { setFilter(e.target.value); if (!e.target.value) setHits(null); }}
                   placeholder={table ? `Filter ${table.title} · Enter = all tables` : 'Search'} />
          </form>
          {hits && <button className="secondary small" onClick={() => { setHits(null); setFilter(''); }}>Back to {table?.title}</button>}
          {!hits && tableKey && <button className="secondary small" title="Reload" onClick={() => void loadRows(tableKey)}>↻</button>}
        </header>

        {importing !== null ? (
          <MondayImport sections={sections} initial={importing} say={say} onCancel={() => setImporting(null)}
            onDone={async key => { setImporting(null); await loadMeta(); setTableKey(key); }} />
        ) : hits ? (
          <SearchResults hits={hits} tables={tables} onOpen={(t, id) => { setHits(null); setFilter(''); setTableKey(t); setOpenId(id); }} />
        ) : table && (
          <div className={`rb-work ${openRow ? 'with-panel' : ''}`}>
            <Grid table={table} rows={rows} filter={filter} can={can} docs={docs} editing={editing} openId={openId}
                  setEditing={setEditing} setPop={setPop} onOpen={setOpenId} onSave={saveCell} onCreate={createRow}
                  onReorder={(key, to) => void structure({ op: 'columns.reorder', table: table.key, columnKey: key, toIndex: to }, 'Column moved')}
                  say={say} />
            {openRow && (
              <RecordPanel key={openId!} table={table} row={openRow} can={can} docs={docs} setPop={setPop}
                           onClose={() => setOpenId(null)} onSave={saveCell} say={say}
                           onDocs={refreshDocs}
                           onDeleted={() => { replaceRow(table.key, String(openRow.id), null); setOpenId(null); say('Deleted — archived, not erased'); }} />
            )}
          </div>
        )}
      </div>

      {pop && table && pop.kind === 'select' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={240}>
          <SelectPicker col={pop.col} current={pop.row ? text(pop.row[pop.col.key]) : ''} canAdd={can.structure}
            onPick={v => { setPop(null); if (pop.row) void saveCell(pop.row, pop.col, v); else void createRow({ [pop.col.key]: v }); }}
            onAdd={async v => {
              const ok = await structure({ op: 'columns.update', table: table.key, columnKey: pop.col.key,
                                           changes: { options: [...(pop.col.options ?? []), v] } }, `“${v}” added to ${pop.col.title}`);
              if (ok && pop.row) void saveCell(pop.row, { ...pop.col, options: [...(pop.col.options ?? []), v] }, v);
            }} />
        </Popover>
      )}
      {pop && table && pop.kind === 'text' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={360}>
          <LongText col={pop.col} value={text(pop.row[pop.col.key])} onSave={v => { setPop(null); void saveCell(pop.row, pop.col, v); }} />
        </Popover>
      )}
      {pop && table && pop.kind === 'docs' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={340}>
          <DocsBox table={table} row={pop.row} col={pop.col} can={can} say={say}
                   entry={docs[`${table.key}|${pop.col.key}|${pop.row.id}`]} onChanged={() => refreshDocs(pop.row, pop.col)} />
        </Popover>
      )}
      {pop && table && pop.kind === 'colmenu' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={300}>
          <ColumnMenu table={table} col={pop.col} run={structure} />
        </Popover>
      )}
      {pop && table && pop.kind === 'addcol' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={300}>
          <ColumnForm onSubmit={spec => structure({ op: 'columns.add', table: table.key, column: spec }, `${spec.title} added`)} />
        </Popover>
      )}
      {pop && pop.kind === 'table' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={280}>
          <TableMenu table={pop.table} run={structure} />
        </Popover>
      )}
      {pop && pop.kind === 'newtable' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={280}>
          <NameForm title={`New table in ${pop.section.title}`} placeholder="Table name" extra="ID prefix, e.g. UNI (optional)"
            onSubmit={(title, prefix) => structure({ op: 'tables.create', section: pop.section.key, title, idPrefix: prefix }, `${title} created`)} />
          <button className="link tiny" onClick={() => { const k = pop.section.key; setPop(null); setHits(null); setImporting(k); }}>
            ⇪ …or import a Monday board</button>
        </Popover>
      )}
      {pop && pop.kind === 'newsection' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={260}>
          <NameForm title="New section" placeholder="Section name" onSubmit={title => structure({ op: 'sections.create', title }, `${title} created`)} />
        </Popover>
      )}
      {toast}
    </section>
  );
}

/* ── the grid ─────────────────────────────────────────────────────── */

function Grid({ table, rows, filter, can, docs, editing, openId, setEditing, setPop, onOpen, onSave, onCreate, onReorder, say }: {
  table: RepoTable; rows: RepoRow[] | undefined; filter: string; can: Can; docs: Record<string, DocEntry>;
  editing: string | null; openId: string | null; setEditing: (k: string | null) => void; setPop: (p: Pop) => void;
  onOpen: (id: string) => void; onSave: (row: RepoRow, col: RepoColumn, v: unknown) => Promise<void>;
  onCreate: (values: Record<string, unknown>) => Promise<void>; onReorder: (key: string, to: number) => void;
  say: (m: string, bad?: boolean) => void;
}) {
  const cols = userColumns(table);
  const primary = primaryKey(table);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return !n ? rows ?? [] : (rows ?? []).filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(n)));
  }, [rows, filter]);

  if (!rows) return <div className="rb-board"><div className="rb-skel" /></div>;

  return (
    <div className="rb-board">
      <table className="rb-grid">
        <thead>
          <tr>
            <th className="rb-sticky rb-idcol">ID</th>
            {cols.map(c => (
              <th key={c.key} className={`${c.key === primary ? 'rb-sticky rb-primary' : ''} ${dropCol === c.key ? 'rb-drop' : ''}`}
                  draggable={can.structure}
                  onDragStart={() => setDragCol(c.key)}
                  onDragOver={e => { if (dragCol && dragCol !== c.key) { e.preventDefault(); setDropCol(c.key); } }}
                  onDragLeave={() => setDropCol(null)}
                  onDrop={() => { if (dragCol) onReorder(dragCol, cols.findIndex(x => x.key === c.key)); setDragCol(null); setDropCol(null); }}
                  onDragEnd={() => { setDragCol(null); setDropCol(null); }}>
                <span className="rb-th">
                  <span className="rb-th-title" title={`${c.title} · ${TYPE_LABEL[c.type] ?? c.type}`}>{c.title}</span>
                  {can.structure && <button className="rb-th-menu" title="Column options"
                    onClick={e => setPop({ kind: 'colmenu', rect: e.currentTarget.getBoundingClientRect(), col: c })}>▾</button>}
                </span>
              </th>
            ))}
            {can.structure
              ? <th className="rb-addcol"><button className="rb-icon" title="Add a column"
                   onClick={e => setPop({ kind: 'addcol', rect: e.currentTarget.getBoundingClientRect() })}>+</button></th>
              : <th />}
          </tr>
        </thead>
        <tbody>
          {shown.map(row => {
            const id = String(row.id);
            return (
              <tr key={id} className={openId === id ? 'rb-open' : undefined}>
                <td className="rb-sticky rb-idcol"><button className="rb-idlink" onClick={() => onOpen(id)} title="Open the record">{id}</button></td>
                {cols.map(c => (
                  <Cell key={c.key} table={table} row={row} col={c} can={can} primary={c.key === primary}
                        docs={docs[`${table.key}|${c.key}|${id}`]} editing={editing === `${id}|${c.key}`}
                        setEditing={v => setEditing(v ? `${id}|${c.key}` : null)} setPop={setPop}
                        onSave={v => onSave(row, c, v)} say={say} />
                ))}
                <td className="rb-rowend"><button className="rb-open-btn" title="Open the record" onClick={() => onOpen(id)}>›</button></td>
              </tr>
            );
          })}
          {filter && !shown.length && <tr><td className="rb-empty" colSpan={cols.length + 2}>Nothing in {table.title} matches “{filter}”. Press Enter to search every table.</td></tr>}
          {can.edit && !filter && <GhostRow cols={cols} primary={primary} setPop={setPop} onCreate={onCreate} />}
        </tbody>
      </table>
      {!rows.length && !can.edit && <p className="rb-empty">No records yet.</p>}
    </div>
  );
}

/** One cell: the value as it reads, and — for those who may — its editor in place. */
function Cell({ table, row, col, can, primary, docs, editing, setEditing, setPop, onSave, say }: {
  table: RepoTable; row: RepoRow; col: RepoColumn; can: Can; primary: boolean; docs: DocEntry | undefined;
  editing: boolean; setEditing: (on: boolean) => void; setPop: (p: Pop) => void;
  onSave: (v: unknown) => Promise<void>; say: (m: string, bad?: boolean) => void;
}) {
  const v = row[col.key];
  const editable = can.edit && col.editable && !['secret', 'doc', 'ref'].includes(col.type) || (can.edit && col.type === 'ref');
  const cls = ['rb-cell', primary ? 'rb-sticky rb-primary' : '', editable ? 'rb-editable' : '', `t-${col.type}`].join(' ');
  const rect = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();

  if (editing) {
    return <td className={`${cls} rb-editing`}><InlineInput col={col} value={v} onDone={val => { setEditing(false); if (val !== undefined) void onSave(val); }} /></td>;
  }
  const click = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) return;
    if (col.type === 'doc') { setPop({ kind: 'docs', rect: rect(e), row, col }); return; }
    if (!editable) return;
    if (col.type === 'checkbox') { void onSave(!ticked(v)); return; }
    if (col.type === 'select') { setPop({ kind: 'select', rect: rect(e), row, col }); return; }
    if (col.type === 'longtext') { setPop({ kind: 'text', rect: rect(e), row, col }); return; }
    setEditing(true);
  };
  return (
    <td className={cls} onClick={click} title={col.type === 'longtext' || col.type === 'text' ? text(v) : undefined}>
      {col.type === 'secret'
        ? <SecretInline table={table} row={row} col={col} can={can} say={say} />
        : <Value col={col} v={v} docs={docs} editable={editable} />}
    </td>
  );
}

function Pill({ col, value }: { col: RepoColumn; value: string }) {
  const i = (col.options ?? []).indexOf(value);
  return <span className={`rb-pill ${i >= 0 ? `c${i % 6}` : ''}`}>{value}</span>;
}

function Value({ col, v, docs, editable }: { col: RepoColumn; v: RepoRow[string] | undefined; docs?: DocEntry; editable: boolean }) {
  switch (col.type) {
    case 'select':
      // Always drawn as a control: a dropdown must look like one whether
      // it holds a value or not.
      return <span className="rb-selectbox">{isEmpty(v) ? (editable ? <span className="rb-hint">Choose</span> : null) : <Pill col={col} value={text(v)} />}
        {editable && <span className="rb-caret">▾</span>}</span>;
    case 'checkbox': return <span className={`rb-check ${ticked(v) ? 'on' : ''}`}>{ticked(v) ? '✓' : ''}</span>;
    case 'url': return isEmpty(v) ? null
      : <span className="rb-url"><a href={text(v)} target="_blank" rel="noreferrer" title={text(v)}>↗ {host(text(v))}</a></span>;
    case 'email': return isEmpty(v) ? null : <a href={`mailto:${text(v)}`}>{text(v)}</a>;
    case 'date': return <>{day(v)}</>;
    case 'doc': {
      if (!docs) return <span className="rb-hint">…</span>;
      if (!docs.files.length) return editable ? <span className="rb-docadd">+ Add files</span> : <span className="rb-hint">—</span>;
      const first = docs.files.slice(0, 4);
      return <span className="rb-docs">{first.map(f => <span key={f.fileId} title={f.name}>{fileGlyph(f.mimeType)}</span>)}
        <span className="rb-doccount">{docs.files.length}{docs.truncated ? '+' : ''}</span></span>;
    }
    default: return <>{text(v)}</>;
  }
}

/** The in-cell editor for plain values. Enter or leaving saves, Escape puts it back. */
function InlineInput({ col, value, onDone }: { col: RepoColumn; value: RepoRow[string] | undefined; onDone: (v?: unknown) => void }) {
  const [v, setV] = useState(col.type === 'date' ? day(value) : text(value));
  const [refs, setRefs] = useState<string[]>([]);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? (col.type === 'number' && v !== '' ? Number(v) : v) : undefined);
  };
  useEffect(() => {
    if (col.type !== 'ref' || !col.reference) return;
    void safe(getRepoRows(col.reference.table)).then(r => {
      if (r.ok) setRefs([...new Set(r.rows.map(x => text(x[col.reference!.column])).filter(Boolean))].sort());
    });
  }, [col]);
  const type = { number: 'number', date: 'date', email: 'email', url: 'url' }[col.type] ?? 'text';
  return (
    <>
      <input className="rb-input" autoFocus type={type} value={v} list={col.type === 'ref' ? `ref-${col.key}` : undefined}
             onFocus={e => e.currentTarget.select()} onChange={e => setV(e.target.value)} onBlur={() => finish(true)}
             onKeyDown={e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); }} />
      {col.type === 'ref' && <datalist id={`ref-${col.key}`}>{refs.map(r => <option key={r} value={r} />)}</datalist>}
    </>
  );
}

/** The empty last row: typing in it creates the record, with its ID and folders. */
function GhostRow({ cols, primary, setPop, onCreate }: {
  cols: RepoColumn[]; primary: string; setPop: (p: Pop) => void; onCreate: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [at, setAt] = useState<string | null>(null);
  return (
    <tr className="rb-ghost">
      <td className="rb-sticky rb-idcol rb-hint">new</td>
      {cols.map(c => {
        const typable = c.editable && !['secret', 'doc', 'checkbox'].includes(c.type);
        if (at === c.key) {
          return <td key={c.key} className={`rb-editing ${c.key === primary ? 'rb-sticky rb-primary' : ''}`}>
            <InlineInput col={c} value="" onDone={v => { setAt(null); if (v !== undefined && String(v).trim() !== '') void onCreate({ [c.key]: v }); }} />
          </td>;
        }
        return (
          <td key={c.key} className={`${c.key === primary ? 'rb-sticky rb-primary' : ''} ${typable ? 'rb-editable' : ''}`}
              onClick={e => {
                if (!typable) return;
                if (c.type === 'select') setPop({ kind: 'select', rect: (e.currentTarget as HTMLElement).getBoundingClientRect(), row: null, col: c });
                else setAt(c.key);
              }}>
            {c.key === primary && <span className="rb-hint">+ New record</span>}
          </td>
        );
      })}
      <td />
    </tr>
  );
}

/* ── pickers and editors in popovers ──────────────────────────────── */

/**
 * The dropdown, drawn here rather than by the browser: it always opens,
 * filters as you type, and — for those who shape the table — offers to
 * add the value typed when it is not on the list yet.
 */
function SelectPicker({ col, current, canAdd, onPick, onAdd }: {
  col: RepoColumn; current: string; canAdd: boolean; onPick: (v: string) => void; onAdd: (v: string) => void;
}) {
  const [q, setQ] = useState('');
  const opts = (col.options ?? []).filter(o => !q || o.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = (col.options ?? []).some(o => o.toLowerCase() === q.trim().toLowerCase());
  return (
    <div>
      <input className="rb-input" autoFocus placeholder="Filter, or type a new value" value={q} onChange={e => setQ(e.target.value)}
             onKeyDown={e => {
               if (e.key === 'Enter') { if (opts[0]) onPick(opts[0]); else if (q.trim() && canAdd) onAdd(q.trim()); }
             }} />
      <div className="rb-picklist">
        {opts.map(o => (
          <button key={o} className={`rb-pickitem ${o === current ? 'current' : ''}`} onClick={() => onPick(o)}>
            <Pill col={col} value={o} />{o === current && <span className="rb-spacer" />}{o === current && '✓'}
          </button>
        ))}
        {q.trim() && !exact && (canAdd
          ? <button className="rb-pickitem add" onClick={() => onAdd(q.trim())}>+ Add “{q.trim()}” as an option</button>
          : <div className="rb-pickitem muted">Not an option — someone with structure access can add it</div>)}
        {!opts.length && !q && <div className="rb-pickitem muted">No options yet</div>}
        {current && <button className="rb-pickitem clear" onClick={() => onPick('')}>Clear</button>}
      </div>
    </div>
  );
}

function LongText({ col, value, onSave }: { col: RepoColumn; value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div>
      <div className="rb-pop-title">{col.title}</div>
      <textarea className="rb-input" autoFocus rows={6} value={v} onChange={e => setV(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(v); }} />
      <div className="rb-pop-actions"><span className="rb-hint">Ctrl+Enter saves</span><span className="rb-spacer" />
        <button className="small" disabled={v === value} onClick={() => onSave(v)}>Save</button></div>
    </div>
  );
}

/**
 * A documents cell, opened: every file, a drop zone, new Google files, and
 * a pasted link for what already lives elsewhere.
 *
 * Files go to Google Drive, into the record's folder for this column
 * (§72); Kaizen keeps the link. Removing a Drive file sends it to Drive's
 * trash (30 days); removing a pasted link only removes the link.
 */
function DocsBox({ table, row, col, entry, can, say, onChanged, bare = false }: {
  table: RepoTable; row: RepoRow; col: RepoColumn; entry: DocEntry | undefined; can: Can;
  say: (m: string, bad?: boolean) => void; onChanged: () => Promise<void>;
  /** Inside the record, where the section already names the column. */
  bare?: boolean;
}) {
  const [busy, setBusy] = useState('');
  const [confirmDel, setConfirmDel] = useState<RepoFile | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [hot, setHot] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => { void onChanged(); }, []);

  const upload = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    let done = 0;
    for (const f of files) {
      if (f.size > MAX_UPLOAD) { say(`${f.name} is over 50 MB — put it in the Drive folder and paste its link`, true); continue; }
      setBusy(`Uploading ${done + 1} of ${files.length}…`);
      const r = await safe(uploadRepoFile(table.key, String(row.id), col.key, f));
      if (r.ok) done++; else say(`${f.name}: ${r.message ?? 'failed'}`, true);
    }
    setBusy('');
    if (done) say(done === 1 ? 'Uploaded to Drive' : `${done} files uploaded to Drive`);
    await onChanged();
  };

  const act = async (body: Record<string, unknown>, label: string, doneMsg: string) => {
    setBusy(label);
    const r = await safe(repoEdit(body));
    setBusy(''); setConfirmDel(null); setRenaming(null);
    if (r.ok) { say(doneMsg); await onChanged(); return true; }
    say(r.message ?? 'Failed.', true); return false;
  };
  const add = async () => {
    if (!link.trim()) return;
    if (await act({ op: 'docs.link', table: table.key, id: String(row.id), column: col.key, url: link.trim(), name: name.trim() },
                  'Adding…', 'Link added')) { setLink(''); setName(''); }
  };

  if (confirmDel) {
    const inDrive = !!confirmDel.driveFileId;
    return <Confirm title={`Remove “${confirmDel.name}”?`}
      message={inDrive ? "It goes to Drive's trash, where it can be restored for 30 days." : 'Only the link is removed; the file is not touched.'}
      action={inDrive ? 'Move to trash' : 'Remove link'} onCancel={() => setConfirmDel(null)}
      onConfirm={() => void act({ op: 'docs.delete', fileId: confirmDel.fileId }, 'Removing…', inDrive ? "Moved to Drive's trash" : 'Link removed')} />;
  }
  return (
    <div>
      {!bare && <div className="rb-pop-title">{col.title} <span className="rb-hint">· {String(row.id)}</span><span className="rb-spacer" />
        {entry?.folderUrl && <a href={entry.folderUrl} target="_blank" rel="noreferrer">Drive folder ↗</a>}</div>}
      <div className="rb-files">
        {!entry && <div className="rb-hint loading-dot">Listing files</div>}
        {entry && !entry.files.length && <div className="rb-hint">No files linked yet.</div>}
        {entry?.files.map(f => (
          <div key={f.fileId} className="rb-file">
            <span className="rb-glyph">{fileGlyph(f.mimeType)}</span>
            {renaming === f.fileId
              ? <input className="rb-input" autoFocus defaultValue={f.name}
                       onKeyDown={e => {
                         const v = (e.target as HTMLInputElement).value.trim();
                         if (e.key === 'Enter' && v && v !== f.name) void act({ op: 'docs.rename', fileId: f.fileId, name: v }, 'Renaming…', 'Renamed');
                         if (e.key === 'Escape') setRenaming(null);
                       }} onBlur={() => setRenaming(null)} />
              : <a className="rb-file-name" href={f.url} target="_blank" rel="noreferrer" title={f.name}>{f.name}</a>}
            {can.edit && renaming !== f.fileId && <>
              <button className="rb-icon rb-hover" title="Rename" onClick={() => setRenaming(f.fileId)}>✎</button>
              <button className="rb-icon rb-hover danger" title="Remove link" onClick={() => setConfirmDel(f)}>✕</button>
            </>}
          </div>
        ))}
      </div>
      {can.edit && (
        <>
          <div className={`rb-drop-zone ${hot ? 'hot' : ''}`} onClick={() => picker.current?.click()}
               onDragOver={e => { e.preventDefault(); setHot(true); }} onDragLeave={() => setHot(false)}
               onDrop={e => { e.preventDefault(); setHot(false); void upload(e.dataTransfer.files); }}>
            {busy || 'Drop files here, or click to choose — they go to Drive'}
            <input ref={picker} type="file" multiple hidden onChange={e => void upload(e.target.files)} />
          </div>
          <div className="rb-pop-actions">
            <button className="link tiny" onClick={() => void act({ op: 'docs.create', table: table.key, id: String(row.id), column: col.key, kind: 'doc' }, 'Creating…', 'Google Doc created')}>+ Google Doc</button>
            <button className="link tiny" onClick={() => void act({ op: 'docs.create', table: table.key, id: String(row.id), column: col.key, kind: 'sheet' }, 'Creating…', 'Google Sheet created')}>+ Google Sheet</button>
          </div>
        <div className="rb-linkadd">
          <input className="rb-input" placeholder="…or paste a link (https://…)" value={link}
                 onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
          <input className="rb-input" placeholder="Name (optional)" value={name}
                 onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
          <div className="rb-pop-actions">
            <span className="rb-spacer" />
            <button className="secondary small" disabled={!link.trim() || !!busy} onClick={() => void add()}>Add link</button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}

/** Each column's own menu: the whole structure edit, without leaving the grid. */
function ColumnMenu({ table, col, run }: {
  table: RepoTable; col: RepoColumn; run: (body: Record<string, unknown>, done: string) => Promise<boolean>;
}) {
  const [view, setView] = useState<'menu' | 'rename' | 'options' | 'type' | 'delete'>('menu');
  const [title, setTitle] = useState(col.title);
  const [opts, setOpts] = useState((col.options ?? []).join('\n'));
  const [type, setType] = useState(col.type);
  const cols = userColumns(table);
  const at = cols.findIndex(c => c.key === col.key);
  const base = { table: table.key, columnKey: col.key };
  const list = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);

  if (view === 'rename') return (
    <form onSubmit={e => { e.preventDefault(); if (title.trim() && title !== col.title) void run({ op: 'columns.update', ...base, changes: { title } }, 'Renamed'); }}>
      <div className="rb-pop-title">Rename column</div>
      <input className="rb-input" autoFocus value={title} onChange={e => setTitle(e.target.value)} />
      <div className="rb-pop-actions"><span className="rb-spacer" /><button className="small" disabled={!title.trim() || title === col.title}>Rename</button></div>
    </form>
  );
  if (view === 'options') return (
    <div>
      <div className="rb-pop-title">Options · {col.title}</div>
      <textarea className="rb-input" autoFocus rows={7} value={opts} onChange={e => setOpts(e.target.value)} />
      <div className="rb-pop-actions"><span className="rb-hint">One per line</span><span className="rb-spacer" />
        <button className="small" disabled={!list(opts).length} onClick={() => void run({ op: 'columns.update', ...base, changes: { options: list(opts) } }, 'Options saved')}>Save</button></div>
    </div>
  );
  if (view === 'type') return (
    <div>
      <div className="rb-pop-title">Type · {col.title}</div>
      {CONVERTIBLE.includes(col.type) ? (
        <>
          <select className="rb-input" value={type} onChange={e => setType(e.target.value)}>
            {CONVERTIBLE.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
          {type === 'select' && col.type !== 'select' && (
            <textarea className="rb-input" rows={4} placeholder="Options, one per line" value={opts} onChange={e => setOpts(e.target.value)} />
          )}
          <p className="rb-note">{type === col.type ? 'This is the current type.' : (CONVERSION[type] ?? 'Values are kept as they are.')} The count converted and cleared is logged.</p>
          <div className="rb-pop-actions"><span className="rb-spacer" />
            <button className="small" disabled={type === col.type || (type === 'select' && !list(opts).length)}
              onClick={() => void run({ op: 'columns.update', ...base, changes: type === 'select' ? { type, options: list(opts) } : { type } }, `Now ${TYPE_LABEL[type]}`)}>
              Change type</button></div>
        </>
      ) : <p className="rb-note">{TYPE_LABEL[col.type]} columns are fixed once created. To change it, add a new column.</p>}
    </div>
  );
  if (view === 'delete') return (
    <Confirm title={`Delete the column “${col.title}”?`} typed={col.title} action="Delete column" onCancel={() => setView('menu')}
      message="Its values are erased from every record (the audit log keeps what was erased; passwords are not kept). Files stay in Drive."
      onConfirm={v => void run({ op: 'columns.delete', ...base, confirm: v }, 'Column deleted')} />
  );
  return (
    <div className="rb-menu">
      <div className="rb-pop-title">{col.title} <span className="rb-hint">· {TYPE_LABEL[col.type] ?? col.type}</span></div>
      <button onClick={() => setView('rename')}>✎ Rename</button>
      {col.type === 'select' && <button onClick={() => setView('options')}>☰ Edit options</button>}
      <button onClick={() => setView('type')}>⇆ Change type</button>
      <button disabled={at <= 0} onClick={() => void run({ op: 'columns.move', ...base, direction: 'left' }, 'Moved')}>← Move left</button>
      <button disabled={at >= cols.length - 1} onClick={() => void run({ op: 'columns.move', ...base, direction: 'right' }, 'Moved')}>→ Move right</button>
      <button className="danger" onClick={() => setView('delete')}>✕ Delete column…</button>
      <p className="rb-note">Tip: drag a column's header to move it further.</p>
    </div>
  );
}

function ColumnForm({ onSubmit }: { onSubmit: (spec: { title: string; type: string; options?: string[] }) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState('text');
  const [opts, setOpts] = useState('');
  const list = opts.split('\n').map(x => x.trim()).filter(Boolean);
  return (
    <form onSubmit={e => { e.preventDefault(); if (title.trim()) void onSubmit({ title: title.trim(), type, options: type === 'select' ? list : undefined }); }}>
      <div className="rb-pop-title">New column</div>
      <input className="rb-input" autoFocus placeholder="Column name" value={title} onChange={e => setTitle(e.target.value)} />
      <select className="rb-input" value={type} onChange={e => setType(e.target.value)}>
        {NEW_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      {type === 'select' && <textarea className="rb-input" rows={4} placeholder="Options, one per line" value={opts} onChange={e => setOpts(e.target.value)} />}
      {type === 'secret' && <p className="rb-note">Encrypted, masked everywhere, and every reveal is logged.</p>}
      {type === 'doc' && <p className="rb-note">Each record gets a Drive folder for this column, made when its first file arrives.</p>}
      <div className="rb-pop-actions"><span className="rb-spacer" /><button className="small" disabled={!title.trim() || (type === 'select' && !list.length)}>Add column</button></div>
    </form>
  );
}

function TableMenu({ table, run }: { table: RepoTable; run: (body: Record<string, unknown>, done: string) => Promise<boolean> }) {
  const [view, setView] = useState<'menu' | 'rename' | 'archive'>('menu');
  const [title, setTitle] = useState(table.title);
  if (view === 'rename') return (
    <form onSubmit={e => { e.preventDefault(); if (title.trim() && title !== table.title) void run({ op: 'tables.rename', table: table.key, title }, 'Renamed'); }}>
      <div className="rb-pop-title">Rename table</div>
      <input className="rb-input" autoFocus value={title} onChange={e => setTitle(e.target.value)} />
      <div className="rb-pop-actions"><span className="rb-spacer" /><button className="small">Rename</button></div>
    </form>
  );
  if (view === 'archive') return (
    <Confirm title={`Archive “${table.title}”?`} typed={table.title} action="Archive table" onCancel={() => setView('menu')}
      message="The table disappears from here. It is archived — nothing is erased."
      onConfirm={v => void run({ op: 'tables.delete', table: table.key, confirm: v }, 'Table archived')} />
  );
  return (
    <div className="rb-menu">
      <div className="rb-pop-title">{table.title}</div>
      <button onClick={() => setView('rename')}>✎ Rename</button>
      <button className="danger" onClick={() => setView('archive')}>🗄 Archive table…</button>
    </div>
  );
}

/* ── Monday import (§74) ──────────────────────────────────────────── */

const IMPORT_TYPES: ColumnType[] = ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'email', 'url', 'secret'];

/**
 * A Monday board, brought in as a new table — in place, in the main area,
 * not over it. Three steps: read the export, correct what was guessed,
 * import. The board is read by Drive (an .xlsx is converted there) and
 * previewed here, where a person can see every column before anything is
 * written.
 */
function MondayImport({ sections, initial, say, onDone, onCancel }: {
  sections: RepoSection[]; initial: string; say: (m: string, bad?: boolean) => void;
  onDone: (key: string) => Promise<void>; onCancel: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [link, setLink] = useState('');
  const [board, setBoard] = useState<Board | null>(null);
  const [cols, setCols] = useState<ProposedColumn[]>([]);
  const [title, setTitle] = useState('');
  const [prefix, setPrefix] = useState('');
  const [section, setSection] = useState(initial || sections[0]?.key || '');
  const picker = useRef<HTMLInputElement>(null);

  const got = (r: { ok: true; name: string; rows: string[][] } | { ok: false; message?: string }) => {
    setBusy('');
    if (!r.ok) { setErr(r.message ?? 'Could not read it.'); return; }
    // Monday names exports "Board_Name_1777335535.xlsx".
    const name = r.name.replace(/\.(xlsx|xls|csv)$/i, '').replace(/_\d{9,}$/, '').replace(/_/g, ' ').trim();
    const b = readBoard(r.rows, name || 'Imported');
    if (!b.items.length) { setErr('No records were found under a header row.'); return; }
    setErr(''); setBoard(b); setCols(proposeColumns(b)); setTitle(name || b.title);
  };
  const readFile = async (f: File | undefined) => { if (!f) return; setBusy('Reading the board…'); got(await safe(importReadFile(f))); };
  const readLink = async () => { if (!link.trim()) return; setBusy('Reading the board…'); got(await safe(importReadLink(link.trim()))); };

  const chosen = cols.filter(c => c.include);
  const set = (i: number, patch: Partial<ProposedColumn>) => setCols(cs => cs.map((c, j) => j === i ? { ...c, ...patch } : c));
  /** Values a column's type would clear — said before the import, not after. */
  const lost = (c: ProposedColumn) => !board || c.index === -1 || !['number', 'date'].includes(c.type) ? 0
    : board.items.filter(it => (it.cells[c.index] ?? '').trim() !== '' && coerce({ type: c.type, options: c.options }, it.cells[c.index]) === '').length;

  const commit = async () => {
    if (!board || !chosen.length || !title.trim()) return;
    setBusy(`Importing ${board.items.length} records…`); setErr('');
    const r = await safe(importCommit({
      section, title: title.trim(), idPrefix: prefix.trim(),
      columns: chosen.map(c => ({ index: c.index, title: c.title, type: c.type, options: c.options })),
      items: board.items
    }));
    setBusy('');
    if (!r.ok) { setErr(r.message ?? 'The import failed.'); return; }
    say(`${title.trim()}: ${r.records} records imported${r.secrets ? `, ${r.secrets} passwords encrypted` : ''}`);
    await onDone(r.key);
  };

  return (
    <div className="rb-import">
      <div className="rb-import-head">
        <h3>Import a Monday board</h3>
        <span className="rb-spacer" />
        <button className="secondary small" onClick={onCancel}>Cancel</button>
      </div>
      {!board ? (
        <>
          <p className="note">In Monday: the board's ⋯ menu → Export → Export board to Excel. Then drop the file here — or paste
            the Drive link of an export already in Drive.</p>
          <div className="rb-drop-zone" onClick={() => !busy && picker.current?.click()}
               onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void readFile(e.dataTransfer.files[0]); }}>
            {busy || 'Drop the .xlsx (or .csv) here, or click to choose'}
            <input ref={picker} type="file" accept=".xlsx,.xls,.csv" hidden onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <form className="rb-import-link" onSubmit={e => { e.preventDefault(); void readLink(); }}>
            <input className="rb-input" placeholder="…or a Drive link to the export" value={link} onChange={e => setLink(e.target.value)} />
            <button className="secondary small" disabled={!link.trim() || !!busy}>Read</button>
          </form>
        </>
      ) : (
        <>
          <p className="note">
            <b>{board.items.length}</b> record{board.items.length === 1 ? '' : 's'}
            {board.groups.length > 1 ? <> in <b>{board.groups.length}</b> groups ({board.groups.join(', ')}) — kept as a Group column</> : null}
            {board.note && <> · the board says: “{board.note.slice(0, 160)}”</>}
          </p>
          <div className="row">
            <label>Table name <input value={title} onChange={e => setTitle(e.target.value)} /></label>
            <label>Section
              <select value={section} onChange={e => setSection(e.target.value)}>
                {sections.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
              </select>
            </label>
            <label>ID prefix <input value={prefix} placeholder="e.g. SRV (optional)" onChange={e => setPrefix(e.target.value.toUpperCase())} /></label>
          </div>
          <div className="grid-scroll">
            <table className="units compact rb-import-cols">
              <thead><tr><th>Import</th><th>Column</th><th>Type</th><th>Examples</th><th className="n">Filled</th></tr></thead>
              <tbody>
                {cols.map((c, i) => (
                  <tr key={`${c.index}-${i}`} className={c.include ? '' : 'rb-off'}>
                    <td><input type="checkbox" checked={c.include} onChange={e => set(i, { include: e.target.checked })} /></td>
                    <td><input className="rb-input" value={c.title} onChange={e => set(i, { title: e.target.value })} />
                      {chosen[0] === c && <div className="sub-n">names each record</div>}</td>
                    <td>
                      <select value={c.type} onChange={e => set(i, { type: e.target.value as ColumnType })}>
                        {IMPORT_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                      </select>
                      {c.type === 'secret' && <div className="sub-n">encrypted — values never shown</div>}
                      {lost(c) > 0 && <div className="breach">▲ {lost(c)} value{lost(c) === 1 ? '' : 's'} would be cleared</div>}
                    </td>
                    <td className="sub-n">{c.samples.join(' · ') || '—'}</td>
                    <td className="n">{c.filled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button disabled={!!busy || !chosen.length || !title.trim() || !section} onClick={() => void commit()}>
              {busy || `Import ${board.items.length} records`}</button>
            <button className="secondary" disabled={!!busy} onClick={() => { setBoard(null); setCols([]); }}>Choose another file</button>
          </div>
        </>
      )}
      {err && <p className="banner warn">▲ {err}</p>}
    </div>
  );
}

function NameForm({ title, placeholder, extra, onSubmit }: {
  title: string; placeholder: string; extra?: string; onSubmit: (name: string, extra: string) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [x, setX] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); if (name.trim()) void onSubmit(name.trim(), x.trim()); }}>
      <div className="rb-pop-title">{title}</div>
      <input className="rb-input" autoFocus placeholder={placeholder} value={name} onChange={e => setName(e.target.value)} />
      {extra && <input className="rb-input" placeholder={extra} value={x} onChange={e => setX(e.target.value)} />}
      <div className="rb-pop-actions"><span className="rb-spacer" /><button className="small" disabled={!name.trim()}>Create</button></div>
    </form>
  );
}

/* ── secrets ──────────────────────────────────────────────────────── */

/** In the grid: masked; a click reveals it (logged), and it masks itself again. */
function SecretInline({ table, row, col, can, say }: { table: RepoTable; row: RepoRow; col: RepoColumn; can: Can; say: (m: string, bad?: boolean) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (value === null) return;
    const t = window.setTimeout(() => setValue(null), REMASK_MS);
    return () => window.clearTimeout(t);
  }, [value]);
  if (isEmpty(row[col.key])) return null;
  if (value !== null) {
    return <span className="rb-secret-open" onClick={e => e.stopPropagation()}>
      <code>{value}</code>
      <button className="rb-icon" title="Copy" onClick={() => void navigator.clipboard?.writeText(value).then(() => say('Copied'))}>⧉</button>
    </span>;
  }
  return (
    <span className={`rb-secret ${can.reveal ? 'can' : ''}`} title={can.reveal ? 'Click to reveal — logged' : 'Your role cannot reveal passwords'}
          onClick={e => {
            e.stopPropagation();
            if (!can.reveal || busy) return;
            setBusy(true);
            void safe(revealRepoSecret(table.key, String(row.id), col.key)).then(r => {
              setBusy(false);
              if (r.ok) setValue(r.value); else say(r.message ?? 'Refused.', true);
            });
          }}>{busy ? 'decrypting…' : '••••••••'}</span>
  );
}

/* ── the record, beside the grid ──────────────────────────────────── */

function RecordPanel({ table, row, can, docs, setPop, onClose, onSave, onDocs, onDeleted, say }: {
  table: RepoTable; row: RepoRow; can: Can; docs: Record<string, DocEntry>; setPop: (p: Pop) => void;
  onClose: () => void; onSave: (row: RepoRow, col: RepoColumn, v: unknown) => Promise<void>;
  onDocs: (row: RepoRow, col: RepoColumn) => Promise<void>; onDeleted: () => void; say: (m: string, bad?: boolean) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const id = String(row.id);
  const primary = primaryKey(table);
  const fields = table.columns.filter(c => !SYSTEM_TYPES.has(c.type) && c.type !== 'doc');
  const docCols = table.columns.filter(c => c.type === 'doc');
  const groups = useMemo(() => {
    const m = new Map<string, RepoColumn[]>();
    fields.forEach(c => m.set(c.group || 'Details', [...(m.get(c.group || 'Details') ?? []), c]));
    return [...m.entries()];
  }, [table]);
  useEffect(() => { docCols.forEach(c => void onDocs(row, c)); }, [id]);

  const remove = async () => {
    const r = await safe(repoEdit({ op: 'delete', table: table.key, id }));
    if (r.ok) onDeleted(); else say(r.message ?? 'Not deleted.', true);
  };
  const stamp = (k: string) => text(row[k]);

  return (
    <aside className="rb-panel" aria-label={`Record ${id}`}>
      <header className="rb-panel-head">
        <div>
          <div className="rb-hint">{table.title} · {id}</div>
          <h3>{text(row[primary]) || id}</h3>
        </div>
        <span className="rb-spacer" />
        {stamp('folder') && <a className="secondary small rb-btnlink" href={stamp('folder')} target="_blank" rel="noreferrer">Folder ↗</a>}
        <button className="rb-icon" title="Close (Esc)" onClick={onClose}>✕</button>
      </header>
      <div className="rb-panel-body">
        {groups.map(([g, cols]) => (
          <section key={g} className="rb-fieldset">
            {groups.length > 1 && <h4>{g}</h4>}
            {cols.map(c => (
              <div key={c.key} className="rb-field">
                <label>{c.title}{c.required ? ' *' : ''}</label>
                <FieldValue table={table} row={row} col={c} can={can} setPop={setPop} say={say} onSave={v => onSave(row, c, v)} />
              </div>
            ))}
          </section>
        ))}
        {docCols.map(c => (
          <section key={c.key} className="rb-fieldset">
            <h4>{c.title}{docs[`${table.key}|${c.key}|${id}`]?.folderUrl &&
              <> · <a href={docs[`${table.key}|${c.key}|${id}`]!.folderUrl} target="_blank" rel="noreferrer">folder ↗</a></>}</h4>
            <DocsBox bare table={table} row={row} col={c} can={can} say={say} entry={docs[`${table.key}|${c.key}|${id}`]} onChanged={() => onDocs(row, c)} />
          </section>
        ))}
        {(stamp('updated_at') || stamp('created_at')) && (
          <p className="rb-note">
            {stamp('created_at') && <>Created {day(stamp('created_at'))}{stamp('created_by') ? ` by ${stamp('created_by')}` : ''}. </>}
            {stamp('updated_at') && <>Last changed {stamp('updated_at').replace('T', ' ').slice(0, 16)}.</>}
          </p>
        )}
      </div>
      {can.edit && (
        <footer className="rb-panel-foot">
          {!confirm ? <button className="link danger" onClick={() => setConfirm(true)}>Delete record…</button>
            : <Confirm title={`Delete ${id}?`} action="Delete record" onCancel={() => setConfirm(false)} onConfirm={() => void remove()}
                message="The record leaves every view. It is archived, not erased, and its Drive folder stays where it is." />}
        </footer>
      )}
    </aside>
  );
}

/** A field in the record: always shows its value, and edits in place like the grid. */
function FieldValue({ table, row, col, can, setPop, say, onSave }: {
  table: RepoTable; row: RepoRow; col: RepoColumn; can: Can; setPop: (p: Pop) => void;
  say: (m: string, bad?: boolean) => void; onSave: (v: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const v = row[col.key];
  const editable = can.edit && col.editable;

  if (col.type === 'secret') {
    return (
      <div className="rb-fieldval">
        {newSecret === null ? <>
          {isEmpty(v) ? <span className="rb-hint">not set</span> : <SecretInline table={table} row={row} col={col} can={can} say={say} />}
          {editable && <button className="link tiny" onClick={() => setNewSecret('')}>{isEmpty(v) ? 'set' : 'change'}</button>}
        </> : (
          // Set from an empty field, never edited in place: only a typed
          // value is sent, so the mask can never be saved as the password.
          <form className="rb-inline-form" onSubmit={e => { e.preventDefault(); if (newSecret) { void onSave(newSecret); setNewSecret(null); } }}>
            <input className="rb-input" type="password" autoFocus autoComplete="new-password" placeholder="New value"
                   value={newSecret} onChange={e => setNewSecret(e.target.value)} />
            <button className="small" disabled={!newSecret}>Save</button>
            <button type="button" className="link tiny" onClick={() => setNewSecret(null)}>cancel</button>
          </form>
        )}
      </div>
    );
  }
  if (editing) return <div className="rb-fieldval rb-editing"><InlineInput col={col} value={v} onDone={val => { setEditing(false); if (val !== undefined) void onSave(val); }} /></div>;
  const click = (e: React.MouseEvent) => {
    if (!editable || (e.target as HTMLElement).closest('a')) return;
    if (col.type === 'checkbox') { void onSave(!ticked(v)); return; }
    if (col.type === 'select') { setPop({ kind: 'select', rect: (e.currentTarget as HTMLElement).getBoundingClientRect(), row, col }); return; }
    if (col.type === 'longtext') { setPop({ kind: 'text', rect: (e.currentTarget as HTMLElement).getBoundingClientRect(), row, col }); return; }
    setEditing(true);
  };
  return (
    <div className={`rb-fieldval ${editable ? 'rb-editable' : ''} t-${col.type}`} onClick={click}>
      {col.type === 'longtext' ? <span className="rb-longtext">{text(v)}</span> : <Value col={col} v={v} editable={editable} />}
      {editable && isEmpty(v) && !['select', 'checkbox'].includes(col.type) && <span className="rb-hint">Add…</span>}
    </div>
  );
}

/* ── search across tables ─────────────────────────────────────────── */

function SearchResults({ hits, tables, onOpen }: {
  hits: { q: string; results: RepoHit[]; searched: number }; tables: RepoTable[]; onOpen: (table: string, id: string) => void;
}) {
  const found = hits.results.filter(r => r.total > 0);
  const failed = hits.results.filter(r => r.problem);
  return (
    <div className="rb-results">
      <p className="rb-note">{found.reduce((a, r) => a + r.total, 0)} match(es) across {hits.searched} table(s). Encrypted passwords are never searched.</p>
      {/* A table that could not be read was NOT searched; "no results" must not mean both. */}
      {failed.map(f => <p key={f.table} className="banner warn">▲ {f.title} could not be searched: {f.problem}</p>)}
      {found.map(h => {
        const t = tables.find(x => x.key === h.table);
        if (!t) return null;
        const p = primaryKey(t);
        return (
          <div key={h.table} className="rb-hitgroup">
            <h4>{h.section} · {h.title} <span className="rb-count">{h.total}</span></h4>
            {h.rows.map(r => (
              <button key={String(r.id)} className="rb-hit" onClick={() => onOpen(h.table, String(r.id))}>
                <b>{text(r[p]) || String(r.id)}</b>
                <span className="rb-hint">{String(r.id)} · {Object.entries(r).filter(([k, v]) => k !== p && String(v).toLowerCase().includes(hits.q.toLowerCase())).map(([k]) => t.columns.find(c => c.key === k)?.title ?? k).slice(0, 3).join(', ')}</span>
              </button>
            ))}
          </div>
        );
      })}
      {!found.length && !failed.length && <p className="rb-empty">Nothing matches.</p>}
    </div>
  );
}
