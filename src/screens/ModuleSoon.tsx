/**
 * A planned module's page (restructure, owner 2026-11-16: "leave Phase 2 empty, but created"). The module exists in
 * the menu and has an address, so the structure is the real one from day one; the page only names what will live
 * here. Nothing loads, nothing is stored — what gets built lands under this name (src/lib/modules.ts).
 */
import type { NavModule } from '../lib/modules.ts';
import { Hint } from '../components/Hint.tsx';

export function ModuleSoon({ mod }: { mod: NavModule }) {
  return (
    <section className="mod-soon">
      <span className={`mod-tag ${mod.phase === 'Future' ? 'later' : 'next'}`}>{mod.phase}</span>
      <h2>{mod.label} <Hint>This area is part of the new structure and is not built yet. It shows only to people who can open Settings,
        until the area has screens and a team assigned to it.</Hint></h2>
      <div className="mod-plan">
        {(mod.plan ?? []).map(p => <div key={p} className="mod-plan-card"><span className="mod-plan-dot" aria-hidden="true" />{p}</div>)}
      </div>
      <p className="note">Nothing here yet.</p>
    </section>
  );
}
