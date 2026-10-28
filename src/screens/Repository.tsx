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
  getRepoMeta, type RepoArchived, getRepoRows, getRepoDocs, getRepoDocsBatch, searchRepo, revealRepoSecret, repoEdit, repoStructure, uploadRepoFile,
  importReadFile, importReadLink, importCommit,
  type RepoColumn, type RepoFile, type RepoHit, type RepoRow, type RepoSection, type RepoTable
} from '../api.ts';
import { proposeColumns, readBoard, type Board, type ProposedColumn } from '../lib/repo-import.ts';
import { applyView, BLANK, coerce, viewActive, viewValue, type ColumnType, type RepoView } from '../lib/repo.ts';
import { setParams, useUrlState } from '../components/useUrlState.ts';
import { usePhone } from '../components/usePhone.ts';
import { HostawayCheck } from '../components/HostawayCheck.tsx';
import { MissingData } from '../components/MissingData.tsx';
import { COMPOSED, UNIT_TABLES, composeParts, composeText, isSynced, partKeys, partOf } from '../lib/repo-checks.ts';
import { ic, Icon } from '../components/Icon.tsx';

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
  | { kind: 'composed'; row: RepoRow; base: string; focus: string }
  | { kind: 'table'; rect: DOMRect; table: RepoTable }
  | { kind: 'newtable'; rect: DOMRect; section: RepoSection }
  | { kind: 'newsection'; rect: DOMRect };

export function Repository({ canReveal, canEdit, canStructure }: {
  canReveal: boolean; canEdit: boolean; canStructure: boolean;
}) {
  const [sections, setSections] = useState<RepoSection[] | null>(null);
  // §118: archived tables live apart — out of the list and of search, opened read-only from the Archive.
  const [archived, setArchived] = useState<RepoArchived[]>([]);
  const [showArchive, setShowArchive] = useState(false);
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
  // §149: the Hostaway check fills the main pane; §170: so does Missing data (Home links here with ?check=missing).
  const [checking, setChecking] = useState<'' | 'hostaway' | 'missing'>(() => new URLSearchParams(location.search).get('check') === 'missing' ? 'missing' : '');
  useEffect(() => { setParams({ check: null }, { replace: true }); }, []);
  // Sort and filters per table, per browser: how this person looks at it, not the table's order.
  const [views, setViews] = useState<Record<string, RepoView>>(() => {
    try { return JSON.parse(localStorage.getItem(VIEWS) ?? '{}') as Record<string, RepoView>; } catch { return {}; }
  });
  const setView = (key: string, v: RepoView) => setViews(m => {
    const next = { ...m, [key]: v };
    try { localStorage.setItem(VIEWS, JSON.stringify(next)); } catch { /* private window: forgets on reload */ }
    return next;
  });
  const [say, toast] = useToast();
  const searchRef = useRef<HTMLInputElement>(null);
  // ?repo=<table>/<ROW-id> (§150): open that record once, then forget the address.
  const wanted = useRef((([t, id]) => t && id ? { table: t, id } : null)((new URLSearchParams(location.search).get('repo') ?? '').split('/')));

  const tables = useMemo(() => (sections ?? []).flatMap(s => s.tables), [sections]);
  const archivedTable = archived.find(t => t.key === tableKey) ?? null;
  const table = tables.find(t => t.key === tableKey) ?? archivedTable;
  const rows = tableKey ? rowsBy[tableKey] : undefined;
  // An archived table is read, never changed: no edits, no structure; a secret can still be revealed.
  const can: Can = { reveal: canReveal, edit: canEdit && !archivedTable, structure: canStructure && !archivedTable };
  // How many rows of this table the filter keeps — the Grid's own rule — so the bar can say it.
  const here = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return !n ? null : (rows ?? []).filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(n))).length;
  }, [rows, filter]);

  const loadMeta = useCallback(async () => {
    const r = await safe(getRepoMeta());
    if (!r.ok) { setErr(r.message ?? 'Could not read the repository.'); return; }
    setSections(r.meta.sections);
    setArchived(r.meta.archived ?? []);
    const w = wanted.current?.table;
    if (w && r.meta.sections.some(s => s.tables.some(t => t.key === w))) { setTableKey(w); return; }
    setTableKey(k => k && (r.meta.sections.some(s => s.tables.some(t => t.key === k)) || (r.meta.archived ?? []).some(t => t.key === k)) ? k
      : r.meta.sections.flatMap(s => s.tables)[0]?.key ?? null);
  }, []);
  const archivedRef = useRef(new Set<string>());
  archivedRef.current = new Set(archived.map(t => t.key));
  const loadRows = useCallback(async (key: string, quiet = false) => {
    if (!quiet) setLoading(true);
    const r = await safe(getRepoRows(key, archivedRef.current.has(key)));
    if (!quiet) setLoading(false);
    if (r.ok) setRowsBy(m => ({ ...m, [key]: r.rows }));
    else if (!quiet) say(r.message ?? 'Could not read the table.', true);
  }, [say]);

  useEffect(() => { void loadMeta(); }, [loadMeta]);
  // ?table= is a step in history (the first table only settles in); the open record only rewrites the
  // address as ?repo=<table>/<id>, the form the Inventory map already links to (useUrlState.ts).
  useUrlState('table', tableKey, setTableKey);
  useEffect(() => {
    if (wanted.current) return; // a ?repo= link still waiting for its rows
    setParams({ repo: tableKey && openId ? `${tableKey}/${openId}` : null }, { replace: true });
  }, [tableKey, openId]);
  useEffect(() => { if (tableKey) { setOpenId(null); void loadRows(tableKey, !!rowsBy[tableKey]); } }, [tableKey]);
  useEffect(() => {
    const w = wanted.current;
    if (!w || w.table !== tableKey || !rows) return;
    wanted.current = null;
    if (rows.some(r => String(r.id) === w.id)) setOpenId(w.id);
    else setParams({ repo: null }, { replace: true });
  }, [tableKey, rows]);

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
  /** Several columns of one record at once (a composed text's parts, §155). */
  const saveValues = async (row: RepoRow, values: Record<string, unknown>) => {
    if (!table) return false;
    const id = String(row.id);
    const r = await safe(repoEdit({ op: 'update', table: table.key, id, values }));
    if (!r.ok) { say(r.message ?? 'Not saved.', true); return false; }
    replaceRow(table.key, id, r.data as RepoRow); say('Saved');
    return true;
  };
  const createRow = async (values: Record<string, unknown>) => {
    if (!table) return;
    const r = await safe(repoEdit({ op: 'create', table: table.key, values }));
    if (!r.ok) { say(r.message ?? 'Not created.', true); return; }
    const row = r.data as RepoRow;
    setRowsBy(m => ({ ...m, [table.key]: [...(m[table.key] ?? []), row] }));
    say('Created');
    setOpenId(String(row.id));
  };
  /** Optimistic, as a cell: the row moves at once and goes back if the server refuses. */
  const moveRow = async (id: string, to: number) => {
    if (!table) return;
    const before = rowsBy[table.key] ?? [];
    const from = before.findIndex(r => String(r.id) === id);
    if (from < 0 || from === to) return;
    const next = [...before];
    next.splice(to, 0, ...next.splice(from, 1));
    setRowsBy(m => ({ ...m, [table.key]: next }));
    const r = await safe(repoEdit({ op: 'move', table: table.key, id, toIndex: to }));
    if (r.ok) say('Row moved');
    else { setRowsBy(m => ({ ...m, [table.key]: before })); say(r.message ?? 'Not moved.', true); }
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
              {canStructure && <button className="rb-icon" title={`New table in ${s.title}`}
                onClick={e => setPop({ kind: 'newtable', rect: e.currentTarget.getBoundingClientRect(), section: s })}>+</button>}
            </div>
            {s.tables.map(t => (
              <div key={t.key} className={`rb-nav-item ${!checking && !hits && tableKey === t.key ? 'active' : ''}`}>
                <button className="rb-nav-link" onClick={() => { setHits(null); setImporting(null); setChecking(''); setFilter(''); setTableKey(t.key); }}>
                  {t.title}
                  {rowsBy[t.key] && <span className="rb-nav-count">{rowsBy[t.key]!.length}</span>}
                </button>
                {canStructure && <button className="rb-icon rb-hover" title="Table options"
                  onClick={e => setPop({ kind: 'table', rect: e.currentTarget.getBoundingClientRect(), table: t })}>⋯</button>}
              </div>
            ))}
          </div>
        ))}
        {archived.length > 0 && (
          <div className="rb-nav-section rb-archive">
            <button className="rb-nav-head rb-archive-head" onClick={() => setShowArchive(v => !v)} aria-expanded={showArchive}>
              <span>{showArchive ? '▾' : '▸'} Archive · {archived.length}</span>
            </button>
            {showArchive && archived.map(t => (
              <div key={t.key} className={`rb-nav-item ${!checking && !hits && tableKey === t.key ? 'active' : ''}`}>
                <button className="rb-nav-link" title={`${t.sectionTitle} · archived ${t.archivedAt.slice(0, 10)}`}
                        onClick={() => { setHits(null); setImporting(null); setChecking(''); setFilter(''); setTableKey(t.key); }}>
                  {t.title}<span className="rb-nav-count">{t.sectionTitle}</span>
                </button>
              </div>
            ))}
          </div>
        )}
        {canStructure && <button className="rb-add-link" onClick={e => setPop({ kind: 'newsection', rect: e.currentTarget.getBoundingClientRect() })}>+ New section</button>}
        {canStructure && <button className="rb-add-link" onClick={() => { setHits(null); setImporting(sections[0]?.key ?? ''); }}>⇪ Import from Monday</button>}
        <button className="rb-add-link" onClick={() => { setHits(null); setImporting(null); setChecking('hostaway'); }}>⇄ Check against Hostaway</button>
        <button className="rb-add-link" onClick={() => { setHits(null); setImporting(null); setChecking('missing'); }}>▲ Missing data</button>
      </aside>

      <div className="rb-main">
        <header className="rb-bar">
          <h2>{checking === 'missing' ? 'Missing data' : checking ? 'Check against Hostaway' : hits ? `Search: “${hits.q}”` : table?.title ?? ''}</h2>
          {!checking && !hits && rows && <span className="rb-count">{rows.length} record{rows.length === 1 ? '' : 's'}</span>}
          {loading && <span className="rb-count loading-dot">Loading</span>}
          <span className="rb-spacer" />
          {!checking && <form className="rb-search" onSubmit={e => { e.preventDefault(); void runSearch(); }}>
            <input ref={searchRef} type="search" value={filter} onChange={e => { setFilter(e.target.value); if (!e.target.value) setHits(null); }}
                   placeholder={table ? `Filter ${table.title}…` : 'Search'} />
          </form>}
          {hits && <button className="secondary small" onClick={() => { setHits(null); setFilter(''); }}>Back to {table?.title}</button>}
          {!checking && !hits && tableKey && <button className="secondary small" title="Reload" onClick={() => void loadRows(tableKey)}>↻</button>}
        </header>

        {/* §118: typing filters this table; searching everywhere is a visible choice, not a hidden Enter. */}
        {!hits && importing === null && filter.trim().length >= 2 && here !== null && (
          <div className={`rb-searchall ${here === 0 ? 'none' : ''}`}>
            <span>{here === 0 ? `Nothing in ${table?.title ?? 'this table'} matches “${filter.trim()}”.` : `${here} in ${table?.title ?? 'this table'}.`}</span>
            <button className={here === 0 ? '' : 'secondary small'} onClick={() => void runSearch()}><Icon n="search" /> Search all tables for “{filter.trim()}”</button>
          </div>
        )}
        {archivedTable && !hits && importing === null && (
          <div className="banner rb-archived">
            <b>Archived:</b>&nbsp;{archivedTable.title} ({archivedTable.sectionTitle}, {archivedTable.archivedAt.slice(0, 10)}) — read-only, and left out of search.
            {canStructure && <button className="secondary small" onClick={() => void structure({ op: 'tables.restore', table: archivedTable.key }, `${archivedTable.title} restored`)}>↺ Restore</button>}
          </div>
        )}
        {checking === 'missing' ? (
          <MissingData onCheck={() => setChecking('hostaway')} onOpen={(t, id) => {
            // The record opens in its table's grid; a table not loaded yet opens it once its rows arrive.
            setChecking(''); setFilter('');
            if (t === tableKey && rows) setOpenId(id); else { wanted.current = { table: t, id }; setTableKey(t); }
          }} />
        ) : checking ? (
          <HostawayCheck canEdit={canEdit} say={say} onClose={() => setChecking('')} />
        ) : importing !== null ? (
          <MondayImport sections={sections} initial={importing} say={say} onCancel={() => setImporting(null)}
            onDone={async key => { setImporting(null); await loadMeta(); setTableKey(key); }} />
        ) : hits ? (
          <SearchResults hits={hits} tables={tables} onOpen={(t, id) => { setHits(null); setFilter(''); setTableKey(t); setOpenId(id); }} />
        ) : table && (
          <div className={`rb-work ${openRow ? 'with-panel' : ''}`}>
            <Grid table={table} rows={rows} filter={filter} can={can} docs={docs} editing={editing} openId={openId}
                  setEditing={setEditing} setPop={setPop} onOpen={setOpenId} onSave={saveCell} onCreate={createRow}
                  onReorder={(key, to) => void structure({ op: 'columns.reorder', table: table.key, columnKey: key, toIndex: to }, 'Column moved')}
                  view={views[table.key]} onView={v => setView(table.key, v)} onMoveRow={(id, to) => void moveRow(id, to)}
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
      {pop && table && pop.kind === 'composed' && (
        <ComposedEditor table={table} base={pop.base} focus={pop.focus} can={can}
          row={(rowsBy[table.key] ?? []).find(r => String(r.id) === String(pop.row.id)) ?? pop.row}
          onClose={() => setPop(null)} onSave={values => saveValues(pop.row, values)}
          onAddPart={async title => {
            const r = await safe(repoStructure({ op: 'units.addPart', base: pop.base, title }));
            if (!r.ok) { say(r.message ?? 'Not added.', true); return false; }
            say(`Add: ${title} — added to the three Units tables`); await loadMeta(); return true;
          }} />
      )}
      {pop && table && pop.kind === 'docs' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={340}>
          <DocsBox table={table} row={pop.row} col={pop.col} can={can} say={say}
                   entry={docs[`${table.key}|${pop.col.key}|${pop.row.id}`]} onChanged={() => refreshDocs(pop.row, pop.col)} />
        </Popover>
      )}
      {pop && table && pop.kind === 'colmenu' && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={300}>
          <ColumnMenu table={table} col={pop.col} run={structure} canStructure={can.structure} rows={rows ?? []}
                      view={views[table.key]} onView={v => setView(table.key, v)} close={() => setPop(null)} />
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

function Grid({ table, rows, filter, can, docs, editing, openId, setEditing, setPop, onOpen, onSave, onCreate, onReorder, view, onView, onMoveRow, say }: {
  table: RepoTable; rows: RepoRow[] | undefined; filter: string; can: Can; docs: Record<string, DocEntry>;
  editing: string | null; openId: string | null; setEditing: (k: string | null) => void; setPop: (p: Pop) => void;
  onOpen: (id: string) => void; onSave: (row: RepoRow, col: RepoColumn, v: unknown) => Promise<void>;
  onCreate: (values: Record<string, unknown>) => Promise<void>; onReorder: (key: string, to: number) => void;
  view: RepoView | undefined; onView: (v: RepoView) => void; onMoveRow: (id: string, to: number) => void;
  say: (m: string, bad?: boolean) => void;
}) {
  const cols = userColumns(table);
  const primary = primaryKey(table);
  const { slots, runs, isOpen, toggle } = useSections(table, cols);
  const synced = UNIT_TABLES.includes(table.key);
  const order = cols.map(c => c.key);
  // Drag-to-fill, as in a spreadsheet: the handle of a cell copies its value into the rows it is dragged over.
  const [fill, setFill] = useState<{ key: string; from: number; to: number } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return applyView(!n ? rows ?? [] : (rows ?? []).filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(n))), view);
  }, [rows, filter, view]);
  // A dragged row lands at an index of the table's own order, so only when nothing is sorted or hidden.
  const viewing = viewActive(view);
  const dragRows = can.edit && !filter.trim() && !viewing;
  const dragFrom = dragRow ? shown.findIndex(r => String(r.id) === dragRow) : -1;
  const titleOf = (k: string) => cols.find(c => c.key === k)?.title ?? k;

  const phone = usePhone();

  useEffect(() => {
    if (!fill) return;
    const up = () => {
      setFill(null);
      const src = shown[fill.from], col = cols.find(c => c.key === fill.key);
      if (!src || !col || fill.to === fill.from) return;
      const targets = fill.to > fill.from ? shown.slice(fill.from + 1, fill.to + 1) : shown.slice(fill.to, fill.from);
      void (async () => {
        for (const r of targets) await onSave(r, col, src[col.key]);
        say(`${col.title}: copied into ${targets.length} row${targets.length === 1 ? '' : 's'}`);
      })();
    };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [fill]);
  const inFill = (i: number, key: string) => !!fill && fill.key === key && i >= Math.min(fill.from, fill.to) && i <= Math.max(fill.from, fill.to);

  if (!rows) return <div className="rb-board"><div className="rb-skel" /></div>;

  // On a phone the team LOOKS THINGS UP (a lockbox, a wifi password):
  // a list that opens the record on tap, not a grid that edits on tap.
  // Editing is still there, inside the record (§80).
  if (phone) {
    return (
      <ul className="rb-phone-list">
        {shown.map(r => (
          <li key={String(r.id)}>
            <button className="rb-phone-row" onClick={() => onOpen(String(r.id))}>
              <b>{text(r[primary]) || '(no name)'}</b>
              <span className="rb-phone-go" aria-hidden="true">›</span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="rb-hint">No records match.</li>}
      </ul>
    );
  }

  return (
    <div className="rb-board">
      {viewing && view && (
        <div className="rb-viewbar">
          {view.sort && <span className="rb-viewchip">Sorted: {titleOf(view.sort.key)} {view.sort.dir > 0 ? 'A → Z' : 'Z → A'}
            <button className="rb-icon" title="Remove the sort" onClick={() => onView({ ...view, sort: undefined })}>✕</button></span>}
          {Object.entries(view.filters).filter(([, vs]) => vs.length).map(([k, vs]) => (
            <span key={k} className="rb-viewchip"><Icon n="filter" /> {titleOf(k)}: {vs.join(', ')}
              <button className="rb-icon" title="Remove this filter" onClick={() => onView({ ...view, filters: { ...view.filters, [k]: [] } })}>✕</button></span>
          ))}
          <span className="rb-hint">{shown.length} of {rows.length} rows · clear to drag rows</span>
          <button className="secondary small" onClick={() => onView({ filters: {} })}>Clear all</button>
        </div>
      )}
      <table className="rb-grid">
        <thead>
          {runs.some(r => r.section) && (
            <tr className="rb-grouprow">
              <th className="rb-sticky rb-idcol" />
              {runs.map(r => !r.section
                ? r.cols.map(c => <th key={c.key} className={c.key === primary ? 'rb-sticky rb-primary' : ''} />)
                : <th key={r.group} colSpan={isOpen(r.group) ? r.cols.length : 1} className={`rb-sec ${isOpen(r.group) ? 'rb-sec-open' : ''}`}>
                    <button className="rb-sec-btn" onClick={() => toggle(r.group)} title={isOpen(r.group) ? `Fold ${r.group}` : `Show the ${r.cols.length} columns of ${r.group}`}>
                      {isOpen(r.group) ? '◂' : '▸'} {r.group}{!isOpen(r.group) && ` · ${r.cols.length}`}
                    </button>
                  </th>)}
              <th />
            </tr>
          )}
          <tr>
            <th className="rb-sticky rb-idcol" aria-label="Record" />
            {slots.map(c => 'stub' in c
              ? <th key={c.stub} className="rb-stub" onClick={() => toggle(c.stub)}>{c.cols.length} columns</th>
              : (
              <th key={c.key} className={`${c.key === primary ? 'rb-sticky rb-primary' : ''} ${dropCol === c.key ? 'rb-drop' : ''}`}
                  draggable={can.structure}
                  onDragStart={() => setDragCol(c.key)}
                  onDragOver={e => { if (dragCol && dragCol !== c.key) { e.preventDefault(); setDropCol(c.key); } }}
                  onDragLeave={() => setDropCol(null)}
                  onDrop={() => { if (dragCol) onReorder(dragCol, cols.findIndex(x => x.key === c.key)); setDragCol(null); setDropCol(null); }}
                  onDragEnd={() => { setDragCol(null); setDropCol(null); }}>
                <span className="rb-th">
                  <span className="rb-th-title" title={`${c.title} · ${TYPE_LABEL[c.type] ?? c.type}`}>{c.title}</span>
                  {synced && isSynced(c.key) && (AUTO_SYNC.has(c.key)
                    ? <span className="rb-sync" title="Wi-Fi: cleaners get Hostaway's on every sync; compare it here in ⇄ Check against Hostaway">⇄ sync</span>
                    : <span className="rb-sync" title="Never automatic: copied from or sent to Hostaway only with a button in ⇄ Check against Hostaway, after a before → after">⇄ button</span>)}
                  {view?.sort?.key === c.key && <span className="rb-th-mark" title={`Sorted ${view.sort.dir > 0 ? 'A → Z' : 'Z → A'}`}>{view.sort.dir > 0 ? '↑' : '↓'}</span>}
                  {!!view?.filters[c.key]?.length && <span className="rb-th-mark" title="Filtered"><Icon n="filter" /></span>}
                  <button className="rb-th-menu" title={can.structure ? 'Sort, filter and column options' : 'Sort and filter'}
                    onClick={e => setPop({ kind: 'colmenu', rect: e.currentTarget.getBoundingClientRect(), col: c })}>▾</button>
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
          {shown.map((row, i) => {
            const id = String(row.id);
            return (
              <tr key={id} className={[openId === id ? 'rb-open' : '', dropRow === i ? (i < dragFrom ? 'rb-droprow-up' : 'rb-droprow-down') : ''].join(' ')}
                  onDragOver={e => { if (dragRow && dragRow !== id) { e.preventDefault(); setDropRow(i); } }}
                  onDrop={() => { if (dragRow) onMoveRow(dragRow, i); setDragRow(null); setDropRow(null); }}>
                <td className="rb-sticky rb-idcol">
                  {dragRows && <span className="rb-grip" draggable title="Drag to move this row"
                    onDragStart={e => { e.dataTransfer.setData('text/plain', id); setDragRow(id); }}
                    onDragEnd={() => { setDragRow(null); setDropRow(null); }}>⠿</span>}
                  <button className="rb-details" onClick={() => onOpen(id)} title="Open every field of this record">All details</button>
                </td>
                {slots.map(c => 'stub' in c
                  ? <Stub key={c.stub} group={c.stub} cols={c.cols} row={row} order={order} toggle={toggle} setPop={setPop} />
                  : (
                  <Cell key={c.key} table={table} row={row} col={c} can={can} primary={c.key === primary}
                        docs={docs[`${table.key}|${c.key}|${id}`]} editing={editing === `${id}|${c.key}`}
                        setEditing={v => setEditing(v ? `${id}|${c.key}` : null)} setPop={setPop}
                        onSave={v => onSave(row, c, v)} say={say} order={order} filling={inFill(i, c.key)}
                        onFillStart={() => setFill({ key: c.key, from: i, to: i })}
                        onFillOver={() => setFill(f => f && f.key === c.key ? { ...f, to: i } : f)} />
                ))}
                <td className="rb-rowend" />
              </tr>
            );
          })}
          {filter && !shown.length && <tr><td className="rb-empty" colSpan={slots.length + 2}>Nothing in {table.title} matches “{filter}” — use “Search all tables” above.</td></tr>}
          {!filter && viewing && !shown.length && <tr><td className="rb-empty" colSpan={slots.length + 2}>No row passes the filters — “Clear all” above.</td></tr>}
          {can.edit && !filter && !viewing && <GhostRow cols={slots} primary={primary} setPop={setPop} onCreate={onCreate} />}
        </tbody>
      </table>
      {!rows.length && !can.edit && <p className="rb-empty">No records yet.</p>}
    </div>
  );
}

/** One cell: the value as it reads, and — for those who may — its editor in place. */
function Cell({ table, row, col, can, primary, docs, editing, setEditing, setPop, onSave, say, order, filling, onFillStart, onFillOver }: {
  table: RepoTable; row: RepoRow; col: RepoColumn; can: Can; primary: boolean; docs: DocEntry | undefined;
  editing: boolean; setEditing: (on: boolean) => void; setPop: (p: Pop) => void;
  onSave: (v: unknown) => Promise<void>; say: (m: string, bad?: boolean) => void;
  order: string[]; filling: boolean; onFillStart: () => void; onFillOver: () => void;
}) {
  const v = row[col.key];
  const base = composedBase(col.key);
  const editable = can.edit && col.editable && !['secret', 'doc', 'ref'].includes(col.type) || (can.edit && col.type === 'ref');
  const cls = ['rb-cell', primary ? 'rb-sticky rb-primary' : '', editable ? 'rb-editable' : '', `t-${col.type}`].join(' ');
  const rect = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();
  const fillable = editable && !primary && !['secret', 'doc'].includes(col.type);
  const handle = fillable && <span className="rb-fill" title="Drag down (or up) to copy this value into those rows"
    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onFillStart(); }} onClick={e => e.stopPropagation()} />;

  // §155: the house rules and the description read as the whole text Hostaway gets; a click opens it whole.
  if (base) {
    return (
      <td className={`${cls} rb-composed ${filling ? 'rb-filling' : ''}`} onMouseEnter={onFillOver} title="Open the whole text"
          onClick={() => setPop({ kind: 'composed', row, base, focus: col.key })}>
        {col.key === base ? composeText(base, row, order) : text(v)}{handle}
      </td>
    );
  }

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
    <td className={`${cls} ${filling ? 'rb-filling' : ''}`} onClick={click} onMouseEnter={onFillOver}
        title={col.type === 'longtext' || col.type === 'text' ? text(v) : undefined}>
      {col.type === 'secret'
        ? <SecretInline table={table} row={row} col={col} can={can} say={say} />
        : <Value col={col} v={v} docs={docs} editable={editable} />}
      {handle}
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
      return <span className="rb-docs">{first.map(f => <span key={f.fileId} title={f.name}>{ic(fileGlyph(f.mimeType))}</span>)}
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
/** Only Wi-Fi follows Hostaway on its own (cleaners get it on every sync); every other compared column moves by a button (owner, §155). */
const AUTO_SYNC = new Set(['wifi_network', 'password_2']);

/* ── composed texts: house rules and description (§155) ───────────── */

const composedBase = (key: string) => key in COMPOSED ? key : partOf(key);

/** A folded section: the count of filled columns — or, holding a composed text, that text, opened by a click. */
function Stub({ group, cols, row, order, toggle, setPop }: {
  group: string; cols: RepoColumn[]; row: RepoRow; order: string[]; toggle: (g: string) => void; setPop: (p: Pop) => void;
}) {
  const base = cols.find(c => c.key in COMPOSED)?.key;
  if (base) {
    return <td className="rb-stub rb-composed" title="Open the whole text" onClick={() => setPop({ kind: 'composed', row, base, focus: base })}>
      {composeText(base, row, order) || '—'}</td>;
  }
  return <td className="rb-stub" onClick={() => toggle(group)} title={`Show ${group}`}>{cols.filter(x => text(row[x.key])).length}/{cols.length}</td>;
}

/**
 * The whole text, in a pop-up: the main text and each footer part (its own column, appended at the end —
 * marked as such), editable in place; "Whole text" shows it as Hostaway gets it, the footer parts marked.
 * A new footer part is a new column in the three Units tables. Saving writes the record only; Hostaway gets
 * it from ⇄ Check against Hostaway.
 */
function ComposedEditor({ table, row, base, focus, can, onClose, onSave, onAddPart }: {
  table: RepoTable; row: RepoRow; base: string; focus: string; can: Can; onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<boolean>; onAddPart: (title: string) => Promise<boolean>;
}) {
  const cols = userColumns(table);
  const order = cols.map(c => c.key);
  const keys = [base, ...partKeys(base, row, order)];
  const title = (k: string) => cols.find(c => c.key === k)?.title ?? k;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [view, setView] = useState<'edit' | 'whole'>('edit');
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const val = (k: string) => draft[k] ?? text(row[k]);
  const changed = keys.filter(k => val(k) !== text(row[k]));
  const parts = composeParts(base, Object.fromEntries(keys.map(k => [k, val(k)])), order);
  const close = () => { if (!changed.length || window.confirm('Close without saving your changes?')) onClose(); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });

  return createPortal(
    <div className="rb-modal-back" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="rb-modal" role="dialog" aria-label={title(base)}>
        <div className="rb-modal-head">
          <b>{title(base)}</b><span className="rb-hint">{text(row.name)}</span><span className="rb-spacer" />
          <button className={`chip ${view === 'edit' ? 'active' : ''}`} onClick={() => setView('edit')}>Parts</button>
          <button className={`chip ${view === 'whole' ? 'active' : ''}`} onClick={() => setView('whole')}>Whole text</button>
          <button className="rb-icon" title="Close" onClick={close}>×</button>
        </div>
        {view === 'whole' ? (
          <div className="rb-modal-body rb-whole">
            {parts.length ? parts.map(p => <p key={p.key} className={p.main ? '' : 'rb-part-mark'} title={p.main ? 'Main text' : `From the column ${title(p.key)}`}>{p.text}</p>)
              : <p className="rb-hint">Nothing written yet.</p>}
          </div>
        ) : (
          <div className="rb-modal-body">
            {keys.map((k, i) => (
              <label key={k} className={`rb-part ${i ? 'rb-part-foot' : ''}`}>
                <span className="rb-part-name">{i ? `Footer · ${title(k)}` : `${title(base)} — main text`}</span>
                <textarea className="rb-input" rows={i ? 3 : 14} autoFocus={k === focus} readOnly={!can.edit}
                          value={val(k)} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} />
              </label>
            ))}
            {can.structure && (adding === null
              ? <button className="link tiny rb-addpart" onClick={() => setAdding('')}>+ Add a footer part</button>
              : <form className="rb-inline-form" onSubmit={async e => { e.preventDefault(); if (!adding.trim()) return; setBusy(true); if (await onAddPart(adding.trim())) setAdding(null); setBusy(false); }}>
                  <input className="rb-input" autoFocus placeholder="Its name, e.g. Parking" value={adding} onChange={e => setAdding(e.target.value)} />
                  <button className="small" disabled={busy || !adding.trim()}>Add</button>
                  <button type="button" className="link tiny" onClick={() => setAdding(null)}>cancel</button>
                </form>)}
          </div>
        )}
        <div className="rb-modal-foot">
          <span className="rb-hint">Footer parts go at the end of the main text, in this order, as written. Hostaway gets it from ⇄ Check against Hostaway.</span>
          <span className="rb-spacer" />
          <button className="secondary small" onClick={close}>{changed.length ? 'Cancel' : 'Close'}</button>
          {can.edit && <button className="small" disabled={busy || !changed.length}
            onClick={async () => { setBusy(true); const ok = await onSave(Object.fromEntries(changed.map(k => [k, val(k)]))); setBusy(false); if (ok) { setDraft({}); onClose(); } }}>
            {busy ? 'Saving…' : `Save${changed.length > 1 ? ` ${changed.length} parts` : ''}`}</button>}
        </div>
      </div>
    </div>, document.body);
}

/* ── sections: a column group other than Details folds into one column (§155) ── */

type Slot = RepoColumn | { stub: string; cols: RepoColumn[] };
interface Run { group: string; section: boolean; cols: RepoColumn[] }
const UNFOLDED = 'kaizen.repo.unfolded';
const VIEWS = 'kaizen.repo.views';

/** The columns in their runs by group, and what shows: a folded section is one stub column. Unfolded ones are remembered per browser. */
function useSections(table: RepoTable, cols: RepoColumn[]) {
  const [open, setOpen] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(UNFOLDED) ?? '[]') as string[]); } catch { return new Set(); }
  });
  const runs = useMemo(() => {
    const out: Run[] = [];
    for (const c of cols) {
      const g = c.group || 'Details', last = out[out.length - 1];
      if (last && last.group === g) last.cols.push(c);
      else out.push({ group: g, section: g !== 'Details', cols: [c] });
    }
    return out;
  }, [cols]);
  const isOpen = (g: string) => open.has(`${table.key}|${g}`);
  const toggle = (g: string) => setOpen(prev => {
    const next = new Set(prev), k = `${table.key}|${g}`;
    if (next.has(k)) next.delete(k); else next.add(k);
    try { localStorage.setItem(UNFOLDED, JSON.stringify([...next])); } catch { /* private window: forgets on reload */ }
    return next;
  });
  const slots = runs.flatMap((r): Slot[] => !r.section || isOpen(r.group) ? r.cols : [{ stub: r.group, cols: r.cols }]);
  return { slots, runs, isOpen, toggle };
}

function GhostRow({ cols, primary, setPop, onCreate }: {
  cols: Slot[]; primary: string; setPop: (p: Pop) => void; onCreate: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [at, setAt] = useState<string | null>(null);
  return (
    <tr className="rb-ghost">
      <td className="rb-sticky rb-idcol rb-hint">new</td>
      {cols.map(c => {
        if ('stub' in c) return <td key={c.stub} />;
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
      {!bare && <div className="rb-pop-title">{col.title} <span className="rb-hint">· {text(row[primaryKey(table)])}</span><span className="rb-spacer" />
        {entry?.folderUrl && <a href={entry.folderUrl} target="_blank" rel="noreferrer">Drive folder ↗</a>}</div>}
      <div className="rb-files">
        {!entry && <div className="rb-hint loading-dot">Listing files</div>}
        {entry && !entry.files.length && <div className="rb-hint">No files linked yet.</div>}
        {entry?.files.map(f => (
          <div key={f.fileId} className="rb-file">
            <span className="rb-glyph">{ic(fileGlyph(f.mimeType))}</span>
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
function ColumnMenu({ table, col, run, canStructure, rows, view: look, onView, close }: {
  table: RepoTable; col: RepoColumn; run: (body: Record<string, unknown>, done: string) => Promise<boolean>;
  canStructure: boolean; rows: RepoRow[]; view: RepoView | undefined; onView: (v: RepoView) => void; close: () => void;
}) {
  const [view, setView] = useState<'menu' | 'filter' | 'rename' | 'options' | 'type' | 'delete'>('menu');
  const current: RepoView = look ?? { filters: {} };
  const picked = current.filters[col.key] ?? [];
  // Passwords are masked and files are lists: neither sorts nor filters by what it shows.
  const viewable = !['secret', 'doc'].includes(col.type);
  const values = useMemo(() => [...new Set(rows.map(r => viewValue(r[col.key])))]
    .sort((a, b) => a === BLANK ? 1 : b === BLANK ? -1 : a.localeCompare(b, undefined, { numeric: true })), [rows, col.key]);
  const sortBy = (dir: 1 | -1) => { onView({ ...current, sort: { key: col.key, dir } }); close(); };
  const pick = (v: string) => onView({ ...current, filters: { ...current.filters,
    [col.key]: picked.includes(v) ? picked.filter(x => x !== v) : [...picked, v] } });
  const [title, setTitle] = useState(col.title);
  const [opts, setOpts] = useState((col.options ?? []).join('\n'));
  const [type, setType] = useState(col.type);
  const cols = userColumns(table);
  const at = cols.findIndex(c => c.key === col.key);
  const base = { table: table.key, columnKey: col.key };
  const list = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);

  if (view === 'filter') return (
    <div>
      <div className="rb-pop-title">Show only · {col.title}</div>
      <div className="rb-filterlist">
        {values.map(v => (
          <label key={v} className="rb-filteropt"><input type="checkbox" checked={picked.includes(v)} onChange={() => pick(v)} /> {v}</label>
        ))}
      </div>
      <div className="rb-pop-actions"><span className="rb-hint">{picked.length ? `${picked.length} chosen` : 'None chosen = all rows'}</span><span className="rb-spacer" />
        <button className="secondary small" disabled={!picked.length} onClick={() => onView({ ...current, filters: { ...current.filters, [col.key]: [] } })}>Show all</button>
        <button className="small" onClick={close}>Done</button></div>
    </div>
  );
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
      {viewable && <>
        <button onClick={() => sortBy(1)}>↑ Sort A → Z</button>
        <button onClick={() => sortBy(-1)}>↓ Sort Z → A</button>
        {current.sort?.key === col.key && <button onClick={() => { onView({ ...current, sort: undefined }); close(); }}>✕ Remove sort</button>}
        <button onClick={() => setView('filter')}><Icon n="filter" /> Filter{picked.length ? ` · ${picked.length} chosen` : '…'}</button>
      </>}
      {canStructure && <>
        <hr className="rb-menu-sep" />
        <button onClick={() => setView('rename')}>✎ Rename</button>
        {col.type === 'select' && <button onClick={() => setView('options')}><Icon n="menu" /> Edit options</button>}
        <button onClick={() => setView('type')}>⇆ Change type</button>
        <button disabled={at <= 0} onClick={() => void run({ op: 'columns.move', ...base, direction: 'left' }, 'Moved')}>← Move left</button>
        <button disabled={at >= cols.length - 1} onClick={() => void run({ op: 'columns.move', ...base, direction: 'right' }, 'Moved')}>→ Move right</button>
        <button className="danger" onClick={() => setView('delete')}>✕ Delete column…</button>
      </>}
      <p className="rb-note">Sort and filter are yours only (this browser). Drag a column's header, or a row by its ⠿, to move it for everyone.</p>
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
      <button className="danger" onClick={() => setView('archive')}><Icon n="archive" /> Archive table…</button>
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
    <aside className="rb-panel" aria-label={`Record ${text(row[primary]) || id}`}>
      <header className="rb-panel-head">
        <div>
          <div className="rb-hint">{table.title}</div>
          <h3>{text(row[primary]) || '(no name)'}</h3>
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
            : <Confirm title={`Delete ${text(row[primary]) || 'this record'}?`} action="Delete record" onCancel={() => setConfirm(false)} onConfirm={() => void remove()}
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
  const base = composedBase(col.key);

  if (base) {
    return (
      <div className="rb-fieldval rb-editable rb-composed" title="Open the whole text" onClick={() => setPop({ kind: 'composed', row, base, focus: col.key })}>
        <span className="rb-longtext">{col.key === base ? composeText(base, row, userColumns(table).map(c => c.key)) : text(v)}</span>
        {isEmpty(v) && <span className="rb-hint">Add…</span>}
      </div>
    );
  }

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
                <span className="rb-hint">{Object.entries(r).filter(([k, v]) => k !== p && String(v).toLowerCase().includes(hits.q.toLowerCase())).map(([k]) => t.columns.find(c => c.key === k)?.title ?? k).slice(0, 3).join(', ')}</span>
              </button>
            ))}
          </div>
        );
      })}
      {!found.length && !failed.length && <p className="rb-empty">Nothing matches.</p>}
    </div>
  );
}
