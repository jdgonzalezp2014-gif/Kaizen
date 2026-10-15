/**
 * How to get into the unit, and its Wi-Fi (§136) — on the cleaner's clean of
 * the day and on the helper's link. Folded until tapped: codes are not left
 * on a screen anyone can glance at. The address opens in Maps.
 */
import { useState } from 'react';
import type { UnitAccess } from '../lib/unit-access.ts';
import type { Tx } from '../lib/crew-i18n.ts';
import { Icon, ic } from './Icon.tsx';

export function AccessBox({ tx, a }: { tx: Tx; a: UnitAccess }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className="fr-btn secondary access-open" onClick={() => setOpen(true)}>{ic(tx.accessTitle)}</button>;
  return (
    <div className="access-box">
      <div className="access-head"><b>{ic(tx.accessTitle)}</b><button className="link" onClick={() => setOpen(false)}>{ic(tx.accessHide)}</button></div>
      {a.address && <p><Icon n="pin" /> {ic(a.address)}{a.mapsUrl && <> · <a href={a.mapsUrl} target="_blank" rel="noreferrer">{ic(tx.openMaps)}</a></>}</p>}
      {a.lockType && <p><Icon n="lock" /> {ic(tx.accessLock)}: {ic(a.lockType)}</p>}
      {a.code ? <p className="access-code">{ic(tx.accessCode)}: <b>{ic(a.code)}</b></p>
        : (a.kind === 'smart' || !a.kind) && <p className="breach">{ic(tx.accessNoCode)}</p>}
      {a.code && a.codeFrom === 'hostaway' && <p className="note">{ic(tx.accessCodeGuests)}</p>}
      {a.fob && a.fob !== a.lockType && <p><Icon n="key" /> {ic(tx.accessFob)}: {ic(a.fob)}</p>}
      {a.lockbox && <p className="access-code">{ic(tx.accessLockbox)}: <b>{ic(a.lockbox)}</b></p>}
      {a.wifiName && <p><Icon n="wifi" /> {ic(tx.accessWifi)}: <b>{ic(a.wifiName)}</b>{a.wifiPassword && <> · {ic(tx.accessWifiPw)}: <b>{ic(a.wifiPassword)}</b></>}</p>}
    </div>
  );
}
