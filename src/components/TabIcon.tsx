/**
 * The tab bar's icons (phone, §80). One drawing language — 24-unit grid,
 * 1.75 stroke, round joins — so no icon shouts louder than its neighbour.
 * Decorative: the tab's word is the label, so they are aria-hidden.
 */
const PATHS: Record<string, string> = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  units: 'M4 21V8l6-4 6 4v13M16 11h4v10M4 21h16M8 10h4M8 14h4M8 18h4',
  revenue: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  operations: 'M9 4h6v3H9zM7 5.5H5.5A1.5 1.5 0 0 0 4 7v12.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V7a1.5 1.5 0 0 0-1.5-1.5H17M8 12l2.5 2.5L16 9',
  repository: 'M4 6.5C4 5 7.6 4 12 4s8 1 8 2.5S16.4 9 12 9 4 8 4 6.5zM4 6.5v11C4 19 7.6 20 12 20s8-1 8-2.5v-11M4 12c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5',
  costs: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  claims: 'M5 21V4M5 4h11l-2 4 2 4H5',
  sops: 'M4 5a1 1 0 0 1 1-1h5a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5a1 1 0 0 1-1-1zM20 5a1 1 0 0 0-1-1h-5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5a1 1 0 0 0 1-1z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2.1 1.2L14.7 21h-4l-.3-2.4a7 7 0 0 1-2.1-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.9L4.4 9.3l2-3.4 1.9.7a7 7 0 0 1 2.1-1.2L10.7 3h4l.3 2.4a7 7 0 0 1 2.1 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.9z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  // Reports (owner, 2026-10-15): a speech bubble with an exclamation — "something to tell the builders".
  report: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v4M12 14h.01',
};

export function TabIcon({ name }: { name: string }) {
  const d = PATHS[name] ?? PATHS.more!;
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={name === 'more' ? 3 : 1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
