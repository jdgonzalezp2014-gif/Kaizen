/**
 * How to get into the unit, and its Wi-Fi (§136) — on the cleaner's clean of
 * the day and on the helper's link. Folded until tapped: codes are not left
 * on a screen anyone can glance at. The address opens in Maps.
 */
import { useState } from 'react';
import type { UnitAccess } from '../lib/unit-access.ts';
import type { Tx } from '../lib/crew-i18n.ts';

export function AccessBox({ tx, a }: { tx: Tx; a: UnitAccess }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="fr-btn secondary access-open" onClick={() => setOpen(true)}>{tx.accessTitle}</button>;
  return (
    <div className="access-box">
      <div className="access-head"><b>{tx.accessTitle}</b><button className="link" onClick={() => setOpen(false)}>{tx.accessHide}</button></div>
      {a.address && <p>📍 {a.address}{a.mapsUrl && <> · <a href={a.mapsUrl} target="_blank" rel="noreferrer">{tx.openMaps}</a></>}</p>}
      {a.lockType && <p>🔒 {tx.accessLock}: {a.lockType}</p>}
      {a.code ? <p className="access-code">{tx.accessCode}: <b>{a.code}</b></p>
        : (a.kind === 'smart' || !a.kind) && <p className="breach">{tx.accessNoCode}</p>}
      {a.code && a.codeFrom === 'hostaway' && <p className="note">{tx.accessCodeGuests}</p>}
      {a.fob && a.fob !== a.lockType && <p>🔑 {tx.accessFob}: {a.fob}</p>}
      {a.lockbox && <p className="access-code">{tx.accessLockbox}: <b>{a.lockbox}</b></p>}
      {a.wifiName && <p>📶 {tx.accessWifi}: <b>{a.wifiName}</b>{a.wifiPassword && <> · {tx.accessWifiPw}: <b>{a.wifiPassword}</b></>}</p>}
    </div>
  );
}
