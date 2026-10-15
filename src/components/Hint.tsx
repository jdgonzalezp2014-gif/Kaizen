/**
 * A "?" beside a title that shows how something works — on hover, on keyboard focus, or a tap on a phone
 * (owner, 2026-10-14: too much explaining text on screen is visual noise). Only for explanations: what a
 * state, a limit or a warning says stays on screen.
 */
import { useId, useState, type ReactNode } from 'react';

export function Hint({ children, label = 'How this works' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="hint" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="hint-q" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
              onClick={e => { e.stopPropagation(); setOpen(v => !v); }} onBlur={() => setOpen(false)}
              onFocus={() => setOpen(true)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>?</button>
      {open && <span role="tooltip" id={id} className="hint-pop">{children}</span>}
    </span>
  );
}

/**
 * A short label whose detail shows on hover, keyboard focus or a tap (owner, 2026-10-14 — §159): where a
 * to-do came from ("Report from a cleaner") stays one word on the row; what was reported is behind it.
 */
export function Peek({ label, children, ariaLabel, className = '' }: { label: ReactNode; children: ReactNode; ariaLabel?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={`hint peek ${className}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="peek-label" aria-label={ariaLabel} aria-expanded={open} aria-describedby={open ? id : undefined}
              onClick={e => { e.stopPropagation(); setOpen(v => !v); }} onBlur={() => setOpen(false)}
              onFocus={() => setOpen(true)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>{label}</button>
      {open && <span role="tooltip" id={id} className="hint-pop">{children}</span>}
    </span>
  );
}

/**
 * A flag that is only an icon on the row — inspection, same-day, deep — its word and its reason on hover or a
 * tap (owner, 2026-10-14 — §159: the words were noise on every line). `tone` colours the icon when it asks for attention.
 */
export function IconFlag({ icon, label, detail, tone }: { icon: ReactNode; label: string; detail?: string | null; tone?: 'attn' }) {
  return (
    <Peek className={`iflag ${tone ?? ''}`} ariaLabel={label} label={icon}>
      <b>{label}</b>{detail ? <><br />{detail}</> : null}
    </Peek>
  );
}
