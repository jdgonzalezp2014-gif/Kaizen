/**
 * A receipt made ready for the AI, in the browser (owner, 2026-10-15 — Walmart and Amazon orders, as screenshots and PDFs).
 *
 * · A PDF with text inside (Walmart's and Amazon's invoices) goes as its TEXT: the numbers are exact, nothing is
 *   guessed from pixels, and any model in the chain can read it. A scanned PDF (no text) goes as the file.
 * · A long screenshot of an order page (1170 × 6000) is cut into parts that keep the text sharp — shrunk whole, it
 *   would be 390 px wide and unreadable (Claude shrinks anything past ~1568 px too). Parts overlap a little so no line
 *   is cut in two; the prompt says to count a repeated line once.
 * · A photo is made smaller as before (`shrink`).
 */
import { shrink } from './PhotoPicker.tsx';

const PART_W = 1300, PART_H = 1400, OVERLAP = 120, MAX_PARTS = 10;

export interface Prepared { files: File[]; texts: string[] }

export async function prepareReceipt(f: File): Promise<Prepared> {
  if (f.type === 'application/pdf') {
    const text = await pdfText(f).catch(() => '');
    // Under ~80 characters there is no real text layer (a scan): the model reads the file.
    return text.replace(/\s+/g, '').length >= 80 ? { files: [], texts: [text] } : { files: [f], texts: [] };
  }
  if (!f.type.startsWith('image/')) return { files: [f], texts: [] };
  try {
    const img = await createImageBitmap(f);
    if (img.height / img.width < 2.2) return { files: [await shrink(f)], texts: [] };
    const k = Math.min(1, PART_W / img.width);
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    const parts: File[] = [];
    for (let y = 0; y < h && parts.length < MAX_PARTS; y += PART_H - OVERLAP) {
      const ph = Math.min(PART_H, h - y);
      const c = document.createElement('canvas');
      c.width = w; c.height = ph;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, ph);
      g.drawImage(img, 0, y / k, img.width, ph / k, 0, 0, w, ph);
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.9));
      if (blob) parts.push(new File([blob], `${f.name.replace(/\.[^.]+$/, '')}-part${parts.length + 1}.jpg`, { type: 'image/jpeg' }));
      if (y + ph >= h) break;
    }
    return { files: parts.length ? parts : [await shrink(f)], texts: [] };
  } catch { return { files: [f], texts: [] }; }
}

/** The PDF's text, line by line (items grouped by their height on the page, left to right). pdf.js loads only when needed. */
async function pdfText(f: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str }]);
    }
    pages.push([...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r.sort((a, b) => a.x - b.x).map(c => c.s).join('  ')).join('\n'));
  }
  return pages.join('\n\n');
}

/** Images pasted with Ctrl+V (a screenshot), named so the list says what they are. */
export function pastedImages(e: ClipboardEvent | React.ClipboardEvent): File[] {
  return [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
    .map((f, i) => new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${i + 1}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type }));
}
