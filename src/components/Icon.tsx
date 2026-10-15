/**
 * Small one-colour icons in place of emoji (owner feedback, 2026-10-14 — the
 * emoji read as noise: each brings its own colours and weight). One drawing
 * language: 24-unit grid, 1.75 stroke, round joins, sized to the text (1em) and
 * coloured by it (currentColor), so an icon takes a status colour only when the
 * text around it does. Decorative — the word next to it is the label.
 */
import type { ReactNode } from 'react';

const P: Record<string, string> = {
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  done: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
  sparkles: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2zM19 3v4M17 5h4',
  cart: 'M8 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM2 2h2l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L22 7H5.1',
  bottle: 'M10 2h4v3h-4zM9 5h6l1 3v12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V8zM8 12h8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  brush: 'm9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  receipt: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM16 8H8M16 12H8M13 16H8',
  clip: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
  cash: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01',
  dollar: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  alert: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01',
  warning: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3zM12 9v4M12 17h.01',
  calendar: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 2v4M8 2v4M3 10h18',
  home: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  building: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18zM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4',
  eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61M2 2l20 20',
  bed: 'M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9',
  share: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13',
  note: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  flask: 'M9 3h6M10 3v7.4L4.6 19a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 10.4V3M7 16h10',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
  key: 'M15.5 7.5 19 4M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3M7.5 21a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  pin: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  clipboard: 'M9 2h6v4H9zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
  chair: 'M6 19v3M18 19v3M5 11V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM19 10v1a7 7 0 0 1-14 0v-1M12 18v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2.1 1.2L14.7 21h-4l-.3-2.4a7 7 0 0 1-2.1-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.9L4.4 9.3l2-3.4 1.9.7a7 7 0 0 1 2.1-1.2L10.7 3h4l.3 2.4a7 7 0 0 1 2.1 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.9z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2',
  landing: 'M2 22h20M6.4 18.4 2.6 12.5l2-.9 2.6 2.1 3.6-1.2-3.6-6.7 2.3-.9 6 5.7 4.3-1.4a1.8 1.8 0 0 1 1.1 3.4z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  repeat: 'm17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3',
  layers: 'm12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
  wifi: 'M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0M12 20h.01',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  chart: 'M3 3v18h18M7 16v-3M12 16V8M17 16v-6',
  archive: 'M2 3h20v5H2zM4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  dots: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
};
/** The status shapes (● ▲ ■ ○), filled, for the few emoji that were a coloured state. */
const SHAPE: Record<string, [string, string]> = {
  crit: ['M6 6h12v12H6z', 'tone-bad'], attn: ['M12 4 21 19H3z', 'tone-warn'], none: ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', 'tone-off'],
};

/** Which icon stands in for which emoji. Monochrome glyphs (✓ ✕ ↗ ★ ✎ ▲ ●) are text already and stay. */
export const EMOJI_ICON: Record<string, string> = {
  '🔧': 'wrench', '📷': 'camera', '✅': 'done', '✨': 'sparkles', '🛒': 'cart', '🧴': 'bottle', '🔍': 'search',
  '🧽': 'brush', '🧹': 'brush', '💬': 'message', '⚡': 'zap', '🧾': 'receipt', '📎': 'clip', '💵': 'cash', '💸': 'cash',
  '💲': 'dollar', '❓': 'help', '❗': 'alert', '⚠': 'warning', '📅': 'calendar', '🗓': 'calendar', '🏠': 'home',
  '🏢': 'building', '👁': 'eye', '🙈': 'eyeOff', '🛏': 'bed', '📤': 'share', '📝': 'note', '🧪': 'flask', '⏰': 'clock',
  '⏳': 'clock', '🔒': 'lock', '🔐': 'lock', '🔑': 'key', '🙋': 'hand', '🙌': 'hand', '📍': 'pin', '🖼': 'image',
  '📘': 'book', '📚': 'book', '🔗': 'link', '📋': 'clipboard', '🪑': 'chair', '🎤': 'mic', '⚙': 'gear', '💾': 'save',
  '🗑': 'trash', '🌙': 'moon', '📦': 'box', '📄': 'file', '🚫': 'ban', '🛬': 'landing', '👥': 'users', '🔁': 'repeat',
  '🧱': 'layers', '📶': 'wifi', '✉': 'mail', '🧵': 'list', '📱': 'phone', '📨': 'mail', '👤': 'user', '📕': 'file',
  '📊': 'chart', '📽': 'file', '🔎': 'search', '🗄': 'archive', '🌐': 'globe', '☰': 'menu',
  '☀': 'sun', '↩': 'undo', '📆': 'calendar',
  '🔴': 'crit', '🟠': 'attn', '⚪': 'none',
};

export function Icon({ n, label }: { n: string; label?: string }) {
  const shape = SHAPE[n];
  if (shape) return (
    <svg className={`icon ${shape[1]}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={shape[0]} /></svg>
  );
  const d = P[n] ?? P.help!;
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
         strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined}
         aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={d} />
    </svg>
  );
}

const RE = new RegExp(`(${Object.keys(EMOJI_ICON).join('|')})️?`, 'gu');

/**
 * A string that may carry emoji (copy from crew-i18n, a label map, example
 * data), rendered with the icons in their place. Anything else passes through
 * untouched, so wrapping a child that never has emoji costs nothing.
 */
export function ic<T>(s: T): T | ReactNode {
  if (typeof s !== 'string' || !RE.test(s)) return s;
  RE.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of s.matchAll(RE)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    out.push(<Icon key={k++} n={EMOJI_ICON[m[1]!]!} />);
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  // One inline box: loose pieces inside a flex row (a label.check, a chip) would each become a column.
  return <span className="ic-text">{out}</span>;
}

/** The same string with its emoji taken out — for places an icon cannot go (a title, a placeholder, an <option>). */
export const noEmoji = (s: string) => s.replace(RE, '').replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
