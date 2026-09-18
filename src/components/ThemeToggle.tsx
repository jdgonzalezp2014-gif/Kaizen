/**
 * Day / night, remembered per browser.
 *
 * Day is the default and the OS preference is deliberately not
 * consulted — see the boot script in index.html. This component only
 * ever flips an attribute that is already set, so there is no moment
 * where the page has no theme.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'kaizen-theme';

function current(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // A remembered theme is a per-viewer convenience, so browser storage
    // is the right place for it — and it is wrapped because a blocked
    // store must cost the preference, never the page.
    try { localStorage.setItem(KEY, theme); } catch { /* not worth a failure */ }
  }, [theme]);

  const next: Theme = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      className="tab theme-toggle"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {/* The icon shows what you get, not what you have — a sun on a light
          page reads as "you are in day mode" to half of people and "click
          for day mode" to the other half, so the label settles it. */}
      <span aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span>
      <span className="theme-word">{next === 'dark' ? 'Night' : 'Day'}</span>
    </button>
  );
}
