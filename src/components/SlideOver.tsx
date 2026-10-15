/**
 * A side panel over the page (§160): the list stays where it is and what was opened takes half the
 * screen — the whole screen on a phone. Header (title + actions) and dock (the comment box) stay put;
 * only the middle scrolls. Esc, "Close →" or a tap on the dimmed list closes it.
 *
 * `useDock()` hands a descendant the dock element, so a comment box deep inside the form can be
 * rendered into the bottom of the panel instead of wherever its parent happens to be.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const Dock = createContext<HTMLElement | null>(null);
export const useDock = () => useContext(Dock);
/** Inline content inside a panel (a sub-task opened in place) must not borrow its parent's dock. */
export const NoDock = ({ children }: { children: ReactNode }) => <Dock.Provider value={null}>{children}</Dock.Provider>;

export function SlideOver({ title, onClose, actions, below, children }: {
  title: string; onClose: () => void; actions?: ReactNode; below?: ReactNode; children: ReactNode;
}) {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) onClose(); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, []);
  return createPortal(
    <div className="slide-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="slide-over" role="dialog" aria-label={title}>
        <div className="slide-head">
          <h2 title={title}>{title}</h2>
          {/* ✓ and ✕ in `actions` are the item's own (done / cancel). Closing the panel is this, Esc, or the backdrop. */}
          <button type="button" className="link tiny slide-close" onClick={onClose} title="Close the panel (Esc)">Close →</button>
          <div className="slide-actions">{actions}</div>
        </div>
        {below}
        <Dock.Provider value={dock}><div className="slide-body">{children}</div></Dock.Provider>
        <div className="slide-dock" ref={setDock} />
      </aside>
    </div>, document.body);
}
