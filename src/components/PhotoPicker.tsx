/**
 * One way to add photos, everywhere in the field pages (§134): before /
 * after, a receipt, a problem. The owner found each place did it its own
 * way. Now always the same two big buttons and the same strip:
 *  - 📷 Take a photo — opens the camera straight away (one shot; the button
 *    then says "Take another", so several are taken one after the other);
 *  - 🖼️ Choose from the gallery — several at once;
 *  - what is chosen shows as thumbnails, each with ✕ to take it out.
 * Two buttons rather than one: a single "photos" input with `multiple`
 * does not offer the camera on many Android phones.
 */
import { useEffect, useMemo } from 'react';
import type { Tx } from '../lib/crew-i18n.ts';
import { ic } from './Icon.tsx';

export function PhotoPicker({ tx, files, onChange, max = 20, disabled = false }: {
  tx: Tx; files: File[]; onChange: (f: File[]) => void; max?: number; disabled?: boolean;
}) {
  const urls = useMemo(() => files.map(f => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls]);
  const add = (list: FileList | null) => onChange([...files, ...[...(list ?? [])].filter(f => /^image\//.test(f.type || 'image/'))].slice(0, max));
  const full = files.length >= max;
  return (
    <div className="fr-photos">
      <label className={`fr-btn fr-pick${disabled || full ? ' off' : ''}`}>
        {ic(files.length ? tx.photoTakeMore : tx.photoTake)}
        <input type="file" accept="image/*" capture="environment" hidden disabled={disabled || full}
               onChange={e => { add(e.target.files); e.target.value = ''; }} />
      </label>
      <label className={`fr-btn secondary${disabled || full ? ' off' : ''}`}>
        {ic(tx.photoGallery)}
        <input type="file" accept="image/*" multiple hidden disabled={disabled || full}
               onChange={e => { add(e.target.files); e.target.value = ''; }} />
      </label>
      {!!files.length && (
        <div className="fr-thumbs">
          {urls.map((u, i) => (
            <span key={u} className="fr-thumb">
              <img src={u} alt="" />
              {!disabled && <button type="button" aria-label={tx.supRemove} onClick={() => onChange(files.filter((_, j) => j !== i))}>✕</button>}
            </span>
          ))}
        </div>
      )}
      {!!files.length && <p className="fr-tip">{ic(tx.supPhotos(files.length))}</p>}
    </div>
  );
}

/** A phone photo made smaller (longest side 2000 px, JPEG) before it travels; the original when the browser cannot. */
export async function shrink(f: File): Promise<File> {
  try {
    const img = await createImageBitmap(f);
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    if (k === 1 && f.size < 1_500_000) return f;
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : f;
  } catch { return f; }
}
