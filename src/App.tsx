import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Revenue } from './screens/Revenue.tsx';
import { Units } from './screens/Units.tsx';
import { Costs } from './screens/Costs.tsx';
import { Settings } from './screens/Settings.tsx';
import { Operations } from './screens/Operations.tsx';
import { Repository } from './screens/Repository.tsx';
import { Home } from './screens/Home.tsx';
import { CrewHome } from './screens/Crew.tsx';
import { ReportPage } from './screens/Report.tsx';
import { VendorHome, WorkLinkPage } from './screens/Work.tsx';
import { PracticePage, isPractice, PUBLIC_PRACTICE, type PracticeWhich } from './screens/Practice.tsx';
import { InspectPage } from './screens/Inspect.tsx';
import { Sops } from './screens/Sops.tsx';
import { SopButton, SopPanel } from './components/Sops.tsx';
import { featureOf } from './lib/sops.ts';
import { getUnits, getSettings, can, type UnitRow } from './api.ts';
import { todayIn } from './lib/dates.ts';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { TabIcon } from './components/TabIcon.tsx';
import { Modal } from './components/Modal.tsx';
import { Icon } from './components/Icon.tsx';
import { LiveBell } from './components/LiveBell.tsx';
import { usePhone } from './components/usePhone.ts';
import { ReportsDialog } from './components/Reports.tsx';
import { param, setParams } from './components/useUrlState.ts';

type Tab = 'home' | 'units' | 'revenue' | 'operations' | 'repository' | 'costs' | 'claims' | 'sops' | 'settings' | 'crew' | 'vendor';

/**
 * A cleaner's secret link (§122): /crew#t=<token>. Read once, then taken
 * out of the address bar so it is not left on screen or in a screenshot.
 */
/** A handyman's own link (owner, 2026-10-25): /crew#v=<token>, the same door and handling as a cleaner's. */
const VENDOR_TOKEN = (() => {
  if (location.pathname !== '/crew') return null;
  const h = new URLSearchParams(location.hash.slice(1));
  const v = h.get('v');
  if (v) { history.replaceState(null, '', '/crew'); try { sessionStorage.setItem('vendorToken', v); } catch { /* private mode */ } return v; }
  if (h.get('t')) { try { sessionStorage.removeItem('vendorToken'); } catch { /* private mode */ } return null; }
  try { return sessionStorage.getItem('vendorToken'); } catch { return null; }
})();
const CREW_TOKEN = (() => {
  if (location.pathname !== '/crew') return null;
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  if (t) history.replaceState(null, '', '/crew');
  if (t) return t;
  try { return sessionStorage.getItem('crewToken'); } catch { return null; }
})();
if (CREW_TOKEN) { try { sessionStorage.setItem('crewToken', CREW_TOKEN); } catch { /* private mode */ } }

/**
 * A cleaner's report link for their helpers (§134): /report#t=<token>. Kept on
 * the helper's phone (localStorage) so the page opens again from a home-screen
 * icon; taken out of the address bar like the crew link.
 */
/**
 * An inspector's link (§135): /report#i=<token> — the same field door as the
 * helpers'. Read BEFORE the report token (which clears the address bar); the
 * phone remembers which of the two it opened last, for a home-screen icon.
 */
/** A handyman's link for one work order (§137): /report#w=<token> — the same field door, kept on the phone too. */
const WORK_TOKEN = (() => {
  if (location.pathname !== '/report') return null;
  const h = new URLSearchParams(location.hash.slice(1));
  const w = h.get('w');
  try {
    if (w) { history.replaceState(null, '', '/report'); localStorage.setItem('workToken', w); localStorage.setItem('fieldLast', 'w'); return w; }
    if (h.get('t') || h.get('i')) return null;
    return localStorage.getItem('fieldLast') === 'w' ? localStorage.getItem('workToken') : null;
  } catch { return w; }
})();

const INSPECT_TOKEN = (() => {
  if (location.pathname !== '/report') return null;
  const h = new URLSearchParams(location.hash.slice(1));
  const i = h.get('i');
  try {
    if (i) { history.replaceState(null, '', '/report'); localStorage.setItem('inspectToken', i); localStorage.setItem('fieldLast', 'i'); return i; }
    if (h.get('t')) { localStorage.setItem('fieldLast', 't'); return null; }
    return localStorage.getItem('fieldLast') === 'i' ? localStorage.getItem('inspectToken') : null;
  } catch { return i; }
})();

const REPORT_TOKEN = (() => {
  if (location.pathname !== '/report') return null;
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  if (t) { history.replaceState(null, '', '/report'); try { localStorage.setItem('reportToken', t); } catch { /* private mode */ } return t; }
  try { return localStorage.getItem('reportToken'); } catch { return null; }
})();

export function App() {
  // The link door has no sign-in: the page and nothing else.
  if (location.pathname === '/crew') return VENDOR_TOKEN ? <main><VendorHome token={VENDOR_TOKEN} /></main> : <CrewShell token={CREW_TOKEN} />;
  // The helpers' page has its own one-line header: the language sits beside day/night (§134).
  if (location.pathname === '/report') return <main>{WORK_TOKEN ? <WorkLinkPage token={WORK_TOKEN} />
    : INSPECT_TOKEN ? <InspectPage token={INSPECT_TOKEN} /> : <ReportPage token={REPORT_TOKEN} />}</main>;
  // §139 practice: a field page with example data, nothing sent — opened from the SOP panel.
  // Two doors to the same page: the in-app hash (team, signed in) and a real
  // path a cleaner or helper opens without a sign-in. The public paths live
  // under /crew, which Access already bypasses for the token-link door — so no
  // new Access policy is needed (§140). The page is pure mock, no API call fires.
  // The pathname is normalised (trailing slash, case) because a browser may add
  // either and this door MUST open before TeamApp attempts to load settings.
  const normalPath = location.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  const publicWhich = (Object.keys(PUBLIC_PRACTICE) as PracticeWhich[]).find(k => PUBLIC_PRACTICE[k] === normalPath);
  const practice = publicWhich ?? /^#practice\/([a-z-]+)$/.exec(location.hash)?.[1];
  if (practice && isPractice(practice)) return <PracticePage which={practice} />;
  // The team's "View as cleaner" (§122): a tab with that cleaner's page and nothing of the team's.
  const preview = /^#as-cleaner\/(.+)$/.exec(location.hash);
  if (preview) return <PreviewShell name={decodeURIComponent(preview[1]!)} />;
  return <TeamApp />;
}

function PreviewShell({ name }: { name: string }) {
  return (
    <main>
      {/* The cleaner's page has its own one-line top (§134): no big header here either. */}
      <p className="banner warn"><Icon n="eye" /> Preview — {name}'s page exactly as they get it. Their buttons do nothing here. Close this tab to go back.</p>
      <CrewHome asCleaner={name} />
    </main>
  );
}

function CrewShell({ token }: { token: string | null }) {
  return (
    <main>
      {token ? <CrewHome token={token} /> : <p className="banner error">This link is incomplete — ask the team to send it again. / Este enlace está incompleto — pide al equipo que lo envíe de nuevo.</p>}
    </main>
  );
}

const TABS: [Tab, string][] = [
  ['home', 'Home'], ['units', 'Units'], ['revenue', 'Revenue'], ['operations', 'Operations'],
  ['repository', 'Repository'], ['costs', 'Costs'], ['sops', 'SOPs'], ['settings', 'Settings']
];

function TeamApp() {
  // Null, not 'units'. Rendering a default tab before the role is known
  // mounts that screen for everyone — an ops account briefly saw Units
  // and fired /api/forward, which answers 403 for them. The flash was
  // the visible part; the forbidden request was the rest of it.
  const [tab, setTab] = useState<Tab | null>(null);
  /** A door from Home straight into one of Operations' views ("operations:todos"). */
  const [opsView, setOpsView] = useState<string | undefined>(undefined);
  // §159: a click in the side bar on an Operations view — a counter, so the same view twice still navigates.
  const [opsNav, setOpsNav] = useState<{ v: string; n: number } | undefined>(undefined);
  const goOps = (v: string, extra: Record<string, string> = {}) => {
    setParams({ tab: 'operations', view: v === 'board' ? null : v, ...extra }, { whole: true });
    setOpsView(v); setOpsNav({ v, n: Date.now() }); setTab('operations');
  };
  // The tab is in the address (?tab=…, useUrlState.ts): a new tab is a step back can undo, and starts clean.
  // The tab already open keeps its address — its sections are still showing.
  const go = (t: Tab, extra: Record<string, string> = {}) => {
    if (t !== tab) setParams({ tab: t, ...extra }, { whole: true });
    setTab(t);
  };
  // Which Operations view is showing — its SOPs button lists that view's procedures (§92).
  const [opsNow, setOpsNow] = useState<string | undefined>(undefined);
  /** An SOP to open when the library tab opens from a screen's SOPs panel. */
  const [sopFocus, setSopFocus] = useState<string | undefined>(undefined);
  /** §162: a link from Slack to one piece of work (?todo=N / ?claim=N) — opened in Operations → To-do. */
  const [workFocus, setWorkFocus] = useState<{ todo?: string; claim?: string } | undefined>(undefined);
  /** The screen whose SOPs are open beside the work (§98) — it stays open while they move around. */
  const [sopPanel, setSopPanel] = useState<string | null>(null);
  // Fetched once at the top: three screens need the same unit list, and
  // three copies of it drift the moment one of them is stale.
  const [units, setUnits] = useState<UnitRow[]>([]);
  // Which tabs to draw comes from the server, not from a guess here.
  // Null until it answers, so nothing is drawn that might then vanish.
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState('');
  // Only decides which controls are DRAWN. The server refuses anything
  // the role does not permit regardless; this just avoids offering it.
  const [permissions, setPermissions] = useState<string[]>([]);
  /** Reports (owner, 2026-10-15): the bug / request form, from the rail's foot or the phone's menu. Slack's card links ?report=N. */
  const [reporting, setReporting] = useState<'new' | 'list' | null>(() => new URLSearchParams(location.search).has('report') ? 'list' : null);

  useEffect(() => {
    getSettings()
      .then(r => {
        const tabs = r.tabs ?? TABS.map(t => t[0]);
        setAllowed(tabs);
        setPermissions(r.permissions ?? []);
        // A cleaner signed in (§122): their own page, and nothing else is asked for.
        if (tabs.length === 1 && tabs[0] === 'crew') { setTab('crew'); return; }
        // §137: a handyman signed in — their work orders, nothing else.
        if (tabs.length === 1 && tabs[0] === 'vendor') { setTab('vendor'); return; }
        // After the role is known: a cleaner's role cannot read the unit list.
        getUnits().then(u => setUnits(u.units ?? [])).catch(() => {});
        // A link to one cleaner's page, as they see it: #crew/<name> (§122).
        if (location.hash.startsWith('#crew/') && tabs.includes('operations')) {
          setParams({ tab: 'operations', view: 'crew' }, { replace: true });
          setOpsView('crew'); setTab('operations');
          return;
        }
        // Land on the first tab they can open — Home, for everyone: the
        // day at a glance, cut to what their role can see.
        // Back from Google's consent screen (§72): straight to Settings, where it reports.
        const back = new URLSearchParams(location.search).has('drive') && tabs.includes('settings') ? 'settings' : null;
        // A link to one SOP (§101 — "How to use this" in Slack): straight to it in the library.
        const sop = new URLSearchParams(location.search).get('sop');
        if (sop && tabs.includes('sops')) {
          setSopFocus(sop); setTab('sops');
          setParams({ tab: 'sops', sop }, { replace: true, whole: true });
          return;
        }
        // §162: Slack's "Open in Kaizen" on a task or a claim — what Slack cannot do is one click away.
        const q = new URLSearchParams(location.search);
        if ((q.get('todo') || q.get('claim')) && tabs.includes('operations')) {
          setWorkFocus(q.get('todo') ? { todo: q.get('todo')! } : { claim: q.get('claim')! });
          setOpsView('todos'); setTab('operations');
          setParams({ tab: 'operations', view: 'todos', todo: q.get('todo'), claim: q.get('todo') ? null : q.get('claim') }, { replace: true, whole: true });
          return;
        }
        // A link to a tab (owner, 2026-10-14 — "@Kaizen sops" links the SOP library): ?tab=<tab>, and since
        // 2026-10-26 its sections too (?tab=operations&view=todos) — each screen reads its own keys.
        const tabQ = new URLSearchParams(location.search).get('tab');
        if (tabQ && tabs.includes(tabQ as Tab)) {
          if (tabQ === 'operations') setOpsView(param('view') ?? undefined);
          setTab(tabQ as Tab);
          return;
        }
        // A link to one Repository record (§150 — Setup → Inventory's map): ?repo=<table>/<ROW-id>, opened by Repository itself.
        if (new URLSearchParams(location.search).get('repo') && tabs.includes('repository')) {
          setParams({ tab: 'repository' }, { replace: true });
          setTab('repository'); return;
        }
        const first = (back ?? tabs[0]) as Tab;
        setParams({ tab: first }, { replace: true });
        setTab(first);
      })
      .catch(e => {
        // Silently falling back to the ops tab set made a transient
        // failure look like a demotion: an admin lost Units, Revenue and
        // Settings with no explanation, which reads as "someone changed
        // my access" rather than "the request failed".
        //
        // Still fails closed — no tabs are drawn — but it says why.
        setAllowed([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  // Back / forward: the tab the address names (the screens follow their own keys). No tab = where the app lands.
  const allowedRef = useRef<string[] | null>(null);
  allowedRef.current = allowed;
  useEffect(() => {
    const pop = () => {
      const a = allowedRef.current;
      if (!a?.length) return;
      const t = param('tab');
      const next = (t && a.includes(t) ? t : a[0]) as Tab;
      if (next === 'operations') setOpsView(param('view') ?? 'board');
      setTab(next);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);

  // A cleaner signed in sees only their page, which has its own one-line top (§134).
  const crewOnly = allowed?.length === 1 && (allowed[0] === 'crew' || allowed[0] === 'vendor');
  // §166: new work from anyone, while the app is open — for whoever can see the to-dos. One bell: the header on a
  // phone, the side rail's foot on a bigger screen (the header is hidden there).
  const phone = usePhone();
  const bell = allowed && can(permissions, 'todos') && allowed.includes('operations')
    ? <LiveBell onOpen={id => { setWorkFocus({ todo: id }); goOps('todos', { todo: id }); }} /> : null;
  return (
    <main>
      {!crewOnly && <header className="app-header">
        {/* No tagline. It restated a framing the owner had already lost an
            argument about, and a slogan nobody reads is pure vertical
            space on a screen whose job is a list. */}
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><h1>Kaizen OS</h1></div>
        <Today compact />
        {phone && bell}
        <span className="phone-theme"><ThemeToggle /></span>
      </header>}
      {!crewOnly && allowed && <SideNav tabs={allowed.filter(t => TABS.some(x => x[0] === t)) as Tab[]} tab={tab} onTab={go}
                                         opsNow={opsNow} onOps={goOps} permissions={permissions} onReport={() => setReporting('new')} bell={phone ? null : bell} />}
      {!crewOnly && allowed && <TabBar tabs={allowed.filter(t => TABS.some(x => x[0] === t)) as Tab[]} tab={tab} onTab={go} onReport={() => setReporting('new')} />}
      {reporting && <ReportsDialog initial={reporting} where={whereNow(tab, opsNow)} onClose={() => setReporting(null)} />}

      {/* Only shown to someone who can act on it. Telling an ops account
          to go to Settings → Sync listings names a screen they cannot
          open. */}
      {units.length === 0 && tab !== 'settings' && allowed?.includes('settings') && (
        <p className="banner warn">
          No units in the local database yet. Settings → Sync listings, once — costs and price
          decisions attach to these records and cannot be saved without them.
        </p>
      )}

      {loadError && (
        <p className="banner error">
          Could not read your access level, so nothing is shown. This is a failure to load,
          not a change to your permissions — reload to try again. ({loadError})
        </p>
      )}
      {tab === null && !loadError && <p className="note">Loading…</p>}
      {tab === 'crew'     && <CrewHome />}
      {tab === 'vendor'   && <VendorHome />}
      {tab === 'units'    && <Units />}
      {tab === 'revenue'  && <Revenue canClaims={can(permissions, 'claims.money')} />}
      {tab === 'home' && <Home permissions={permissions} onGo={to => {
        const [t, sub] = to.split(':');
        if (allowed?.includes(t!)) { if (t === 'operations' && sub) goOps(sub); else { setOpsView(sub); go(t as Tab); } }
      }} />}
      {tab === 'operations' && <Operations permissions={permissions} initialView={opsView} nav={opsNav} onView={setOpsNow} focus={workFocus} />}
      {tab === 'repository' && <Repository canReveal={can(permissions, 'repository.reveal')}
                                           canEdit={can(permissions, 'repository.edit')}
                                           canStructure={can(permissions, 'repository.structure')} />}
      {tab === 'costs'    && <Costs units={units} />}
      {tab === 'sops'     && <Sops focus={sopFocus} onFocused={() => setSopFocus(undefined)} />}
      {tab === 'settings' && <Settings />}

      {/* The procedures for the screen someone is on (§92), floating bottom right (§96);
          opened beside the work, not over it, and kept open across screens (§98). */}
      {!sopPanel && tab && tab !== 'sops' && allowed?.includes('sops') && featureOf(tab, opsNow) && (
        <SopButton key={featureOf(tab, opsNow)!} feature={featureOf(tab, opsNow)!} onOpen={() => setSopPanel(featureOf(tab, opsNow))} />
      )}
      {sopPanel && tab !== 'sops' && (
        <SopPanel key={sopPanel} feature={sopPanel} canEdit={can(permissions, 'sops.edit')} onClose={() => setSopPanel(null)}
                  onLibrary={id => { setSopPanel(null); setSopFocus(id); go('sops', id ? { sop: id } : {}); }} />
      )}
    </main>
  );
}

/** Cloudflare Access ends the session here and shows its own login page again (owner, 2026-10-26). */
const SIGN_OUT = '/cdn-cgi/access/logout';

/**
 * The phone's tab bar (§80, redesign 2026-10-14): the tabs at the bottom,
 * in reach of a thumb, instead of a strip that scrolls sideways and hides
 * half the app. Five fit; past five, four and "More", which lists the rest.
 * Hidden by CSS above 720px, where the header's tabs are shown instead.
 */
function TabBar({ tabs, tab, onTab, onReport }: { tabs: Tab[]; tab: Tab | null; onTab: (t: Tab) => void; onReport: () => void }) {
  const [more, setMore] = useState(false);
  if (tabs.length < 2) return null;
  // "More" is always there now: it also holds "Report / request" (owner, 2026-10-15) — so four tabs, then More.
  const shown = tabs.slice(0, 4);
  const rest = tabs.slice(4);
  const label = (t: Tab) => TABS.find(x => x[0] === t)?.[1] ?? t;
  const restOpen = tab !== null && rest.includes(tab);
  return (
    <>
      <nav className="tabbar" aria-label="Sections">
        {shown.map(t => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} aria-current={tab === t ? 'page' : undefined}
                  onClick={() => onTab(t)}><TabIcon name={t} />{label(t)}</button>
        ))}
        <button className={restOpen ? 'tab active' : 'tab'} aria-haspopup="dialog" onClick={() => setMore(true)}>
          <TabIcon name="more" />{restOpen ? label(tab!) : 'More'}
        </button>
      </nav>
      {more && (
        <Modal title="More" onClose={() => setMore(false)}>
          <ul className="more-list">
            {rest.map(t => (
              <li key={t}>
                <button className={tab === t ? 'more-item active' : 'more-item'} aria-current={tab === t ? 'page' : undefined}
                        onClick={() => { onTab(t); setMore(false); }}>
                  <TabIcon name={t} /><span>{label(t)}</span>
                </button>
              </li>
            ))}
            <li>
              <button className="more-item" onClick={() => { setMore(false); onReport(); }}>
                <TabIcon name="report" /><span>Report a bug / request</span>
              </button>
            </li>
            <li>
              <a className="more-item" href={SIGN_OUT}><TabIcon name="signout" /><span>Sign out</span></a>
            </li>
          </ul>
        </Modal>
      )}
    </>
  );
}

/** The day, in the menu (owner, 2026-10-14: the date and the city were a heading on Home). Central (CST/CDT) — the team's zone. */
function Today({ compact = false }: { compact?: boolean }) {
  const d = new Date(`${todayIn('America/Chicago')}T12:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(d);
  return compact
    ? <span className="today-chip" title={f({ weekday: 'long', month: 'long', day: 'numeric' })}>{f({ weekday: 'short', month: 'short', day: 'numeric' })}</span>
    // owner, 2026-10-15: the boxed date at the top read as ugly in a narrow rail — plain text at the foot now,
    // fading in with the other labels when the rail opens (`.side-word`).
    : <span className="side-today side-word" title={f({ weekday: 'long', month: 'long', day: 'numeric' })}>
        {f({ weekday: 'short', month: 'short', day: 'numeric' })}
      </span>;
}

/**
 * Tablet and desktop navigation (owner, 2026-10-14: "clean screens — the menu as a vertical slider, the
 * sub-menus open when the cursor is on them"): a rail of icons on the left that slides open on hover or
 * keyboard focus, with Operations' views under it; day / night at the foot. The screen above is the work
 * alone. Hidden at 720 px and below, where the bottom bar does this.
 */
function SideNav({ tabs, tab, onTab, opsNow, onOps, permissions, onReport, bell }: {
  tabs: Tab[]; tab: Tab | null; onTab: (t: Tab) => void; opsNow?: string; onOps: (v: string) => void; permissions: string[]; onReport: () => void;
  bell?: ReactNode;
}) {
  const label = (t: Tab) => TABS.find(x => x[0] === t)?.[1] ?? t;
  // The same views, words and permissions as Operations' own strip (which the rail replaces on a big screen).
  const opsViews: [string, string][] = [['board', 'Movements'], ...(can(permissions, 'todos') ? [['todos', 'To-do'] as [string, string]] : []),
    ['crew', 'Cleaners'], ['vendors', 'Handymen'], ['inspections', 'Inspections'], ['inventory', 'Inventory'], ['notes', 'Notes log'], ['rates', 'Rates & rules'],
    ...(can(permissions, 'operations.setup') ? [['setup', 'Setup'] as [string, string]] : [])];
  return (
    <aside className="side-nav" aria-label="Sections">
      <div className="side-brand"><span className="brand-mark" aria-hidden="true" /><span className="side-word">Kaizen OS</span></div>
      <nav className="side-list">
        {tabs.map(t => (
          <div key={t} className={`side-item ${tab === t ? 'active' : ''} ${t === 'operations' ? 'has-sub' : ''}`}>
            <button className="side-link" aria-current={tab === t ? 'page' : undefined} onClick={() => onTab(t)} title={label(t)}>
              <TabIcon name={t} /><span className="side-word">{label(t)}</span>
            </button>
            {t === 'operations' && (
              <div className="side-sub" role="group" aria-label="Operations">
                {opsViews.map(([k, l]) => (
                  <button key={k} className={tab === 'operations' && (opsNow === k || (k === 'crew' && opsNow === 'calendar')) ? 'side-sublink active' : 'side-sublink'}
                          onClick={() => onOps(k)}>{l}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        {bell}
        <button className="side-link" onClick={onReport} title="Report a bug / request">
          <TabIcon name="report" /><span className="side-word">Report / request</span>
        </button>
        <a className="side-link" href={SIGN_OUT} title="Sign out">
          <TabIcon name="signout" /><span className="side-word">Sign out</span>
        </a>
        <ThemeToggle /><Today />
      </div>
    </aside>
  );
}

/** Where a report was sent from, in words (owner, 2026-10-15): the tab, and Operations' view when there. */
function whereNow(tab: Tab | null, opsNow?: string): string {
  const t = TABS.find(x => x[0] === tab)?.[1] ?? tab ?? 'Kaizen';
  return tab === 'operations' && opsNow ? `${t} › ${opsNow}` : t;
}
