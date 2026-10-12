/**
 * /report#i=<token> — the inspector's page (§135): ONE inspection, no account,
 * opened from the link the team sends on WhatsApp.
 *
 * The owner: the link shows THE SAME view as the team's — the unit room by
 * room with its counts, Cleaning · Repair · Purchase on top, "everything else
 * here is OK" — so it is the team's sheet (`InspectionRun`), reading and saving
 * through the link instead of the team's API. The only difference is the end:
 * the inspector SENDS (and can reopen); the team reviews in Kaizen and makes
 * the work. The name is asked once (this phone remembers it) and goes with
 * every answer. Photos are never required.
 */
import { useMemo, useState } from 'react';
import { getInspectLink, inspectAction, inspectPhotos, type InspectLinkData } from '../api.ts';
import { InspectionRun, type RunTransport } from '../components/InspectionRun.tsx';
import { shrink } from '../components/PhotoPicker.tsx';

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** The link's answer, in the shape the team's sheet reads. */
const asRun = (d: InspectLinkData, date: string) => ({
  inspection: { id: 'link', unitId: null, unit: d.inspection.unit, date: d.inspection.date, inspector: d.inspection.inspector,
                result: null, notes: null, finished: false },
  sections: d.sections, rooms: { bedrooms: 0, bathrooms: 0 }, checks: d.checks,
  nextClean: null, inspectors: [], today: date, sent: d.sent
});

export function InspectPage({ token }: { token: string }) {
  const [name, setName] = useState(() => get('reportName') ?? '');
  const [named, setNamed] = useState(() => !!get('reportName'));
  const transport = useMemo<RunTransport>(() => ({
    get: async () => {
      const r = await getInspectLink(token);
      return r.ok ? { ok: true as const, ...asRun(r, r.inspection.date) } : r;
    },
    act: async body => (await inspectAction(token, { ...body, reporter: name.trim() })) as never,
    photos: async (checkId, files) => inspectPhotos(token, name.trim(), checkId, await Promise.all(files.map(shrink)))
  }), [token, name]);

  if (!named) return (
    <div className="report-page">
      <div className="card">
        <div className="fr">
          <p className="fr-q">What is your name? / ¿Cómo te llamas?</p>
          <input className="fr-select" value={name} maxLength={60} autoComplete="given-name" onChange={e => setName(e.target.value)} />
          <p className="fr-tip">So the team knows who inspected. This phone remembers it. / Para que el equipo sepa quién inspeccionó.</p>
          <button className="fr-btn fr-go" disabled={!name.trim()}
                  onClick={() => { put('reportName', name.trim()); setNamed(true); }}>Continue / Continuar</button>
        </div>
      </div>
    </div>
  );
  return <InspectionRun id="link" canEdit link transport={transport} onClose={() => {}} />;
}
