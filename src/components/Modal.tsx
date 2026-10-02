/**
 * A pop-up (§103): for something read or written in a moment and closed —
 * the activity of a task, say — so it does not sit in the page. Esc, ✕ or a
 * click outside closes it; the page keeps its place behind it.
 */
import { useEffect, type ReactNode } from 'react';

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', esc); document.body.style.overflow = was; };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="link modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
