/** A small floating panel under its button — closes on a click outside, Esc, or when asked. Used for "Filters" and the ⋯ menu. */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Popover({ button, label, className = '', align = 'left', children }: {
  button: ReactNode; label: string; className?: string; align?: 'left' | 'right';
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!on) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOn(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOn(false); } };
    addEventListener('mousedown', away); addEventListener('keydown', esc, true);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc, true); };
  }, [on]);
  return (
    <span className={`pop ${className}`} ref={ref}>
      <button type="button" className="pop-btn" aria-haspopup="true" aria-expanded={on} aria-label={label} title={label} onClick={() => setOn(v => !v)}>{button}</button>
      {on && <div className={`pop-panel ${align}`} role="menu">{typeof children === 'function' ? children(() => setOn(false)) : children}</div>}
    </span>
  );
}
