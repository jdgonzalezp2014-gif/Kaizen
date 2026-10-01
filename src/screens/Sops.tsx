/**
 * SOPs — the library (§92).
 *
 * Browsed by process area (sections), searched across every word of every
 * procedure, and measured the way a process owner would: how many are
 * published, how many wait as drafts, how many are past their review, and
 * which screens of the app have no procedure at all — the gaps list is the
 * to-do list for whoever owns the library.
 */
import { useEffect, useMemo, useState } from 'react';
import { sopAction } from '../api.ts';
import { blankSop, SopEditor, SopRow, SopView, useSops } from '../components/Sops.tsx';
import { coverage, keysUnder, matchesSearch, reviewOverdue, sectionPath, sectionTree, type Sop } from '../lib/sops.ts';
import { todayIn } from '../lib/dates.ts';

const ALL = '*';

export function Sops({ focus, onFocused }: { focus?: string; onFocused?: () => void }) {
  const today = todayIn('America/New_York');
  const { data, err, reload } = useSops();
  const [section, setSection] = useState<string>(ALL);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Sop | null>(null);
  const [removed, setRemoved] = useState<Sop | null>(null);
  const [secEdit, setSecEdit] = useState<{ key?: string; label: string; description: string; parentKey?: string } | null>(null);
  const [secErr, setSecErr] = useState('');
  const [onlyDue, setOnlyDue] = useState(false);

  // Arriving from a screen's SOP panel, at one SOP.
  useEffect(() => { if (focus) { setOpenId(focus); onFocused?.(); } }, [focus]);

  const sops = data?.sops ?? [];
  const sections = data?.sections ?? [];
  const canEdit = !!data?.canEdit;
  const cov = useMemo(() => coverage(sops), [sops]);
  const stats = useMemo(() => ({
    published: sops.filter(s => s.status === 'published').length,
    drafts: sops.filter(s => s.status === 'draft').length,
    overdue: sops.filter(s => reviewOverdue(s, today)).length
  }), [sops, today]);
  // A section counts — and shows — its subsections too (§97).
  const countIn = (key: string) => { const ks = keysUnder(sections, key); return sops.filter(s => ks.includes(s.sectionKey) && s.status !== 'archived').length; };
  const inSection = section === ALL ? null : keysUnder(sections, section);
  const list = sops.filter(s => (!inSection || inSection.includes(s.sectionKey)) && matchesSearch(s, q)
    && (!onlyDue || reviewOverdue(s, today)))
    // Needs attention first: overdue, then drafts; archived last.
    .sort((a, b) => rank(a, today) - rank(b, today) || a.title.localeCompare(b.title));
  const open = sops.find(s => s.id === openId) ?? null;
  const sectionLabel = (k: string) => sectionPath(sections, k);
  const current = sections.find(s => s.key === section);

  const saveSection = async () => {
    if (!secEdit) return;
    setSecErr('');
    const r = await sopAction({ action: 'section', key: secEdit.key, label: secEdit.label, description: secEdit.description, parentKey: secEdit.parentKey });
    if (!r.ok) { setSecErr(r.error ?? 'Not saved.'); return; }
    setSecEdit(null); await reload(); if (r.key) setSection(r.key);
  };
  const removeSection = async (key: string) => {
    setSecErr('');
    const r = await sopAction({ action: 'sectionRemove', key });
    if (!r.ok) { setSecErr(r.error ?? 'Not removed.'); return; }
    setSection(ALL); await reload();
  };
  const startNew = (features: string[] = []) => {
    setOpenId(null);
    setEditing(blankSop(section !== ALL ? section : (sections[0]?.key ?? 'guest'), features));
  };

  return (
    <section className="sops">
      <div className="row-controls sops-head">
        <h2 className="screen-title">SOPs &amp; articles</h2>
        <input className="sops-search" type="search" value={q} placeholder="Search every procedure…" onChange={e => { setQ(e.target.value); setOpenId(null); }} />
        {canEdit && <button className="small" onClick={() => startNew()}>+ New SOP</button>}
      </div>

      {err && <p className="banner error">{err}</p>}
      {removed && (
        <p className="banner ok todo-undo">Removed “{removed.title}”.
          <button className="link" onClick={() => void sopAction({ action: 'restore', id: removed.id }).then(() => { setRemoved(null); void reload(); })}>Undo</button>
          <button className="link tiny" aria-label="Dismiss" onClick={() => setRemoved(null)}>✕</button>
        </p>
      )}

      {data && (
        <dl className="strip sops-strip">
          <div><dt>Published</dt><dd>{stats.published}</dd></div>
          {canEdit && <div><dt>Drafts</dt><dd>{stats.drafts}</dd></div>}
          <div className={stats.overdue ? 'is-warn' : ''}>
            <dt>Review overdue</dt>
            <dd>{stats.overdue}{stats.overdue > 0 && <button className="link tiny sops-due" onClick={() => { setOnlyDue(!onlyDue); setOpenId(null); }}>{onlyDue ? 'show all' : 'show'}</button>}</dd>
          </div>
          <div><dt>Screens covered</dt><dd>{cov.covered}<small>of {cov.total}</small></dd></div>
        </dl>
      )}

      {data && (
        <div className="sop-lib">
          <nav className="sop-sections" aria-label="Sections">
            <button className={section === ALL ? 'on' : ''} onClick={() => { setSection(ALL); setOpenId(null); setEditing(null); }}>
              All <span className="sop-count">{sops.filter(s => s.status !== 'archived').length}</span></button>
            {sectionTree(sections).map(({ section: x, children }) => [x, ...children].map(s => (
              <button key={s.key} className={`${section === s.key ? 'on' : ''} ${s.parentKey ? 'sub' : ''}`} title={s.description ?? ''}
                      onClick={() => { setSection(s.key); setOpenId(null); setEditing(null); }}>
                <span className="sop-sec-name">{s.parentKey && <span aria-hidden="true">↳ </span>}{s.label}</span>
                <span className={`sop-count ${countIn(s.key) ? '' : 'zero'}`}>{countIn(s.key)}</span>
              </button>
            )))}
            {canEdit && <button className="sop-add-section" onClick={() => setSecEdit({ label: '', description: '' })}>+ Add section</button>}
          </nav>

          <div className="sop-main">
            {secEdit && (
              <div className="card sop-secform">
                <h3>{secEdit.key ? 'Rename' : secEdit.parentKey ? `New subsection in ${sectionLabel(secEdit.parentKey)}` : 'New section'}</h3>
                <label>Name<input value={secEdit.label} autoFocus maxLength={80} onChange={e => setSecEdit({ ...secEdit, label: e.target.value })} /></label>
                <label>What it covers<input value={secEdit.description} maxLength={300} onChange={e => setSecEdit({ ...secEdit, description: e.target.value })} /></label>
                {secErr && <p className="banner error">{secErr}</p>}
                <div className="button-row">
                  <button className="ghost" onClick={() => setSecEdit(null)}>Cancel</button>
                  <button disabled={!secEdit.label.trim()} onClick={() => void saveSection()}>Save</button>
                </div>
              </div>
            )}

            {editing ? (
              <div className="card">
                <h3 className="sop-edit-title">{editing.id ? `Edit — ${editing.title}` : 'New SOP or article'}</h3>
                <SopEditor initial={editing} sections={sections} onCancel={() => setEditing(null)}
                           onSaved={s => { setEditing(null); setOpenId(s.id); void reload(); }} />
              </div>
            ) : open ? (
              <div className="card">
                <button className="link sop-back" onClick={() => setOpenId(null)}>← {section === ALL ? 'All SOPs' : sectionLabel(section)}</button>
                <SopView sop={open} sections={sections} canEdit={canEdit} onEdit={() => setEditing(open)}
                         onChanged={() => void reload()} onRemoved={s => { setRemoved(s); setOpenId(null); void reload(); }} />
              </div>
            ) : (
              <>
                {current && (
                  <div className="sop-sechead">
                    <div>
                      {current.parentKey && <button className="link sop-up" onClick={() => setSection(current.parentKey!)}>← {sectionLabel(current.parentKey)}</button>}
                      <h3>{current.label}</h3>{current.description && <p className="note">{current.description}</p>}
                      {!current.parentKey && sections.some(x => x.parentKey === current.key) && (
                        <div className="sop-subs">
                          {sections.filter(x => x.parentKey === current.key).map(x => (
                            <button key={x.key} className="chip" onClick={() => setSection(x.key)}>{x.label} <span className="sop-count">{countIn(x.key)}</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                    {canEdit && (
                      <span className="sop-sectools">
                        <button className="link" onClick={() => setSecEdit({ key: current.key, label: current.label, description: current.description ?? '' })}>Rename</button>
                        {/* One level: only a section holds subsections. */}
                        {!current.parentKey && <button className="link" onClick={() => setSecEdit({ label: '', description: '', parentKey: current.key })}>+ Subsection</button>}
                        {!sops.some(s => keysUnder(sections, current.key).includes(s.sectionKey)) && !sections.some(x => x.parentKey === current.key) &&
                          <button className="link danger" onClick={() => void removeSection(current.key)}>Remove</button>}
                        <button className="small" onClick={() => startNew()}>+ New in {current.label}</button>
                      </span>
                    )}
                  </div>
                )}
                {secErr && !secEdit && <p className="banner error">{secErr}</p>}
                {list.length ? (
                  <ul className="sop-list card">
                    {list.map(s => <SopRow key={s.id} sop={s} section={section === ALL ? sectionLabel(s.sectionKey) : s.sectionKey !== section ? sections.find(x => x.key === s.sectionKey)?.label : undefined}
                                           onOpen={() => setOpenId(s.id)} />)}
                  </ul>
                ) : (
                  <p className="note sop-empty">
                    {q ? `Nothing matches “${q}”.` : onlyDue ? 'Nothing is past its review.'
                      : canEdit ? 'Nothing here yet. A good first SOP is the task people ask about most.' : 'Nothing published here yet.'}
                  </p>
                )}

                {/* The library's own to-do list: screens where the work has no written procedure. */}
                {section === ALL && !q && canEdit && cov.gaps.length > 0 && (
                  <div className="sop-gaps">
                    <h3>Screens without a published SOP <span className="sop-count">{cov.gaps.length}</span></h3>
                    <p className="note">Each is work done without a written procedure. Write one from here and it shows on that screen's SOPs button.</p>
                    <div className="sop-gap-list">
                      {cov.gaps.map(g => <button key={g.key} className="chip" onClick={() => {
                        setOpenId(null); setEditing(blankSop(g.section, [g.key]));
                      }}>+ {g.label}</button>)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {!data && !err && <p className="note loading-dot">Loading</p>}
    </section>
  );
}

const rank = (s: Sop, today: string) => reviewOverdue(s, today) ? 0 : s.status === 'draft' ? 1 : s.status === 'published' ? 2 : 3;
