/**
 * /report#i=<token> — the inspector's page (§135): ONE inspection, no account,
 * opened from the link the team sends on WhatsApp. The same field door and
 * the same habits as the helpers' page (§134): the unit and day always on
 * top, the name asked once and remembered, then step by step — a numbered
 * step per room, one item per screen, big answers.
 *
 * Mistake-proofing, as in a clean's steps:
 *  - every tap is saved as it is given (a phone that loses signal loses nothing);
 *  - a problem is not saved without a photo, and asks what it needs;
 *  - "Send" waits for every room, and says which are left;
 *  - reopening a sent inspection asks "Yes, reopen" on the spot.
 * The inspector only sends: the team reviews in Kaizen and makes the work.
 */
import { useEffect, useMemo, useState } from 'react';
import { getInspectLink, inspectAction, inspectPhotos, type InspectLinkData, type RunCheck } from '../api.ts';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { shrink } from '../components/PhotoPicker.tsx';
import { LANGS, LANG_NAME, dayLabel, isLang, stampLabel, type Lang } from '../lib/crew-i18n.ts';
import { checkKey, suggestedOutcome, type Area, type InspectionItem, type Outcome, type Section } from '../lib/inspection.ts';

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** The three things a problem can need; the team splits "clean" into next clean / new clean when it reviews. */
type Need = 'repair' | 'purchase' | 'clean_next';
const NEEDS: Need[] = ['repair', 'purchase', 'clean_next'];
const KIND: Record<Need, 'repair' | 'purchase' | 'clean'> = { repair: 'repair', purchase: 'purchase', clean_next: 'clean' };
const needOf = (o: Outcome | null): Need => o === 'purchase' ? 'purchase' : o === 'clean_next' || o === 'clean_new' ? 'clean_next' : 'repair';

const AREA_ES: Record<Area, string> = { general: 'General y entrada', living: 'Sala', kitchen: 'Cocina', bedroom: 'Recámara', bathroom: 'Baño', exterior: 'Afuera' };

const TX = {
  en: {
    head: (d: string) => `Inspection · ${d}`, name: "What's your name?", nameTip: 'So the team knows who inspected. This phone remembers it.',
    go: 'Continue', change: 'change', rooms: 'Go room by room', roomsTip: 'Every tap is saved. You can stop and come back with the same link.',
    of: (a: number, b: number) => `${a} of ${b}`, prob: (n: number) => n === 1 ? '1 problem' : `${n} problems`,
    noPhoto: (n: number) => n === 1 ? '1 needs a photo' : `${n} need a photo`, notYet: 'Not started',
    send: 'Send the inspection', missing: (r: string) => `Still to do: ${r}`, back: '← Rooms', prev: '← Previous', item: (a: number, b: number) => `Item ${a} of ${b}`,
    ok: '✓ OK', bad: '▲ Problem', na: '— Does not apply', rest: '✓ Everything else here is OK',
    other: '+ Something else in this room', also: 'Also reported here', probQ: 'Problem', photo: '📷 Take a photo', photoMore: '📷 Add another photo',
    photos: (n: number) => n === 1 ? '✓ 1 photo saved' : `✓ ${n} photos saved`, sendingPhoto: 'Sending the photo…',
    need: 'What does it need?', sug: 'suggested', repair: '🔧 Repair', purchase: '🛒 Buy', clean_next: '🧽 Clean',
    note: 'Note (optional)', notePh: 'e.g. lock beeps but does not open', save: 'Save the problem', needPhoto: 'Add a photo first.',
    describe: 'Say what it is', describePh: 'e.g. broken blind in the window', describeFirst: 'Say what it is first.', remove: 'Remove this problem',
    review: 'Check and send', reviewTip: 'The team turns these into work in Kaizen.', none: 'No problems found.',
    sendNow: 'Send to the team', edit: '← Back to the rooms',
    sent: '✓ Sent', sentTip: (by: string, at: string) => `Sent by ${by}, ${at}. The team reviews it and makes the work orders. You can close this page.`,
    reopen: 'Reopen to change something', sure: 'Reopen this inspection? The team will see it as not sent.', yes: 'Yes, reopen', no: 'No, keep it sent',
    english: '', saving: 'Saving…', notSaved: 'Not saved — try again.', bad_link: 'This link is not valid — ask for it again.',
  },
  es: {
    head: (d: string) => `Inspección · ${d}`, name: '¿Cómo te llamas?', nameTip: 'Para que el equipo sepa quién inspeccionó. Este teléfono lo recuerda.',
    go: 'Continuar', change: 'cambiar', rooms: 'Ve cuarto por cuarto', roomsTip: 'Cada toque se guarda. Puedes parar y volver con el mismo enlace.',
    of: (a: number, b: number) => `${a} de ${b}`, prob: (n: number) => n === 1 ? '1 problema' : `${n} problemas`,
    noPhoto: (n: number) => n === 1 ? '1 sin foto' : `${n} sin foto`, notYet: 'Sin empezar',
    send: 'Enviar la inspección', missing: (r: string) => `Falta: ${r}`, back: '← Cuartos', prev: '← Anterior', item: (a: number, b: number) => `Punto ${a} de ${b}`,
    ok: '✓ Bien', bad: '▲ Problema', na: '— No aplica', rest: '✓ Todo lo demás aquí está bien',
    other: '+ Otra cosa en este cuarto', also: 'También reportado aquí', probQ: 'Problema', photo: '📷 Tomar foto', photoMore: '📷 Agregar otra foto',
    photos: (n: number) => n === 1 ? '✓ 1 foto guardada' : `✓ ${n} fotos guardadas`, sendingPhoto: 'Enviando la foto…',
    need: '¿Qué necesita?', sug: 'sugerido', repair: '🔧 Reparar', purchase: '🛒 Comprar', clean_next: '🧽 Limpiar',
    note: 'Nota (opcional)', notePh: 'ej. la cerradura pita pero no abre', save: 'Guardar el problema', needPhoto: 'Primero agrega una foto.',
    describe: 'Di qué es', describePh: 'ej. persiana rota en la ventana', describeFirst: 'Primero di qué es.', remove: 'Quitar este problema',
    review: 'Revisa y envía', reviewTip: 'El equipo lo convierte en trabajo en Kaizen.', none: 'No se encontraron problemas.',
    sendNow: 'Enviar al equipo', edit: '← Volver a los cuartos',
    sent: '✓ Enviada', sentTip: (by: string, at: string) => `Enviada por ${by}, ${at}. El equipo la revisa y hace las órdenes de trabajo. Ya puedes cerrar esta página.`,
    reopen: 'Reabrir para cambiar algo', sure: '¿Reabrir esta inspección? El equipo la verá como no enviada.', yes: 'Sí, reabrir', no: 'No, dejarla enviada',
    english: 'Los puntos de la lista están en inglés por ahora.', saving: 'Guardando…', notSaved: 'No se guardó — intenta de nuevo.',
    bad_link: 'Este enlace no es válido — pídelo de nuevo.',
  },
};
type Tx = typeof TX.en;

type Screen =
  | { k: 'rooms' }
  | { k: 'item'; s: number; i: number }
  /** A problem: on a checklist item (`item`), or something else in the room (`checkId` once it exists). */
  | { k: 'problem'; s: number; item?: number; checkId?: string }
  | { k: 'review' };

export function InspectPage({ token }: { token: string }) {
  const [data, setData] = useState<InspectLinkData | null>(null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState<Lang | null>(() => { const l = get('reportLang'); return isLang(l) ? l : null; });
  const [name, setName] = useState(() => get('reportName') ?? '');
  const [named, setNamed] = useState(() => !!get('reportName'));
  const [screen, setScreen] = useState<Screen>({ k: 'rooms' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const shown: Lang = lang ?? data?.lang ?? 'en';
  const tx = TX[shown];

  useEffect(() => {
    getInspectLink(token).then(r => r.ok ? setData(r) : setErr(r.message ?? tx.bad_link)).catch(e => setErr(String(e)));
  }, [token]);
  // A new screen starts at the top.
  useEffect(() => { window.scrollTo(0, 0); setMsg(''); }, [screen]);

  const sections = data?.sections ?? [];
  const byKey = useMemo(() => new Map((data?.checks ?? []).filter(c => c.itemId).map(c => [checkKey(c), c])), [data]);
  const extras = (s: Section) => (data?.checks ?? []).filter(c => !c.itemId && c.area === s.area && c.n === s.n);
  const checkOf = (s: Section, it: InspectionItem) => byKey.get(`${it.id}:${s.n}`);
  const title = (s: Section) => {
    if (shown === 'en') return s.title;
    const many = sections.filter(x => x.area === s.area).length > 1 || s.n > 1;
    return many ? `${AREA_ES[s.area]} ${s.n}` : AREA_ES[s.area];
  };
  const answered = (s: Section) => s.items.filter(it => checkOf(s, it)?.result).length;
  const findings = (s: Section) => [...s.items.map(it => checkOf(s, it)).filter((c): c is RunCheck => c?.result === 'attention'), ...extras(s)];

  /** Every call answers with the page as it is now; a failure keeps the screen and says why. */
  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg('');
    try {
      const r = await inspectAction(token, { ...body, reporter: name.trim() });
      if (!r.ok) { setMsg(r.message ?? tx.notSaved); return null; }
      setData(r); return r;
    } catch (e) { setMsg(String(e)); return null; } finally { setBusy(false); }
  };
  /** The next item still to answer in this room, or back to the rooms. */
  const nextIn = (si: number, from: number, d: InspectLinkData) => {
    const s = d.sections[si]!;
    const open = (j: number) => !d.checks.some(c => c.itemId === s.items[j]!.id && c.n === s.n && c.result);
    const j = s.items.findIndex((_, j) => j > from && open(j));
    const k = j >= 0 ? j : s.items.findIndex((_, j) => open(j));
    setScreen(k >= 0 ? { k: 'item', s: si, i: k } : { k: 'rooms' });
  };

  const head = (
    <header className="mini-head">
      {data ? <span className="mini-clean"><b>🏠 {data.inspection.unit}</b><small>{tx.head(dayLabel(shown, data.inspection.date))}</small></span>
            : <span className="mini-brand">Kaizen</span>}
      <span className="mini-tools">
        <span className="todo-kind" role="group" aria-label="Language / Idioma">
          {LANGS.map(l => <button key={l} className={l === shown ? 'chip active' : 'chip'} aria-label={LANG_NAME[l]}
                                  onClick={() => { setLang(l); put('reportLang', l); }}>{l.toUpperCase()}</button>)}
        </span>
        <ThemeToggle />
      </span>
    </header>
  );
  if (err) return <>{head}<p className="banner error report-page">{err}</p></>;
  if (!data) return <>{head}<p className="note loading-dot">…</p></>;
  const note = msg ? <p className="breach" role="alert">{msg}</p> : null;

  let body: JSX.Element;
  if (!named) {
    body = (
      <div className="fr">
        <p className="fr-q">{tx.name}</p>
        <input className="fr-select" value={name} maxLength={60} autoComplete="given-name" onChange={e => setName(e.target.value)} />
        <p className="fr-tip">{tx.nameTip}</p>
        <button className="fr-btn fr-go" disabled={!name.trim()}
                onClick={() => { put('reportName', name.trim()); setNamed(true); }}>{tx.go}</button>
      </div>
    );
  } else if (data.sent) {
    body = <Sent tx={tx} lang={shown} sent={data.sent} busy={busy} onReopen={() => void act({ action: 'reopen' }).then(r => r && setScreen({ k: 'rooms' }))} />;
  } else if (screen.k === 'item') {
    const s = sections[screen.s]!, it = s.items[screen.i]!, c = checkOf(s, it);
    body = (
      <div className="fr">
        <button className="link fr-back" onClick={() => setScreen({ k: 'rooms' })}>{tx.back}</button>
        <p className="fr-kind">{title(s)} · {tx.item(screen.i + 1, s.items.length)}</p>
        <div className="ins-dots" aria-hidden="true">
          {s.items.map((x, j) => <span key={x.id} className={`${checkOf(s, x)?.result ?? ''}${j === screen.i ? ' cur' : ''}`} />)}
        </div>
        <p className="fr-big ins-item">{it.label}</p>
        <button className={`fr-btn fr-choice ins-ok${c?.result === 'ok' ? ' on' : ''}`} disabled={busy}
                onClick={() => void act({ action: 'check', itemId: it.id, n: s.n, result: 'ok' }).then(r => r && nextIn(screen.s, screen.i, r))}>{tx.ok}</button>
        <button className={`fr-btn fr-choice ins-bad${c?.result === 'attention' ? ' on' : ''}`} disabled={busy}
                onClick={() => void act({ action: 'check', itemId: it.id, n: s.n, result: 'attention' })
                  .then(r => r && setScreen({ k: 'problem', s: screen.s, item: screen.i }))}>
          {tx.bad}{c?.result === 'attention' ? ` · ${tx[needOf(c.outcome)]}` : ''}</button>
        <button className={`fr-btn fr-choice${c?.result === 'na' ? ' on' : ''}`} disabled={busy}
                onClick={() => void act({ action: 'check', itemId: it.id, n: s.n, result: 'na' }).then(r => r && nextIn(screen.s, screen.i, r))}>{tx.na}</button>
        {note}
        <button className="fr-btn secondary" disabled={busy}
                onClick={() => void act({ action: 'allOk', area: s.area, n: s.n }).then(r => r && setScreen({ k: 'rooms' }))}>{tx.rest}</button>
        <button className="fr-btn secondary" onClick={() => setScreen({ k: 'problem', s: screen.s })}>{tx.other}</button>
        {!!extras(s).length && <div className="fr-group">
          <p className="fr-cat">{tx.also}</p>
          {extras(s).map(x => <button key={x.id} className="fr-line link" onClick={() => setScreen({ k: 'problem', s: screen.s, checkId: x.id })}>
            <span>▲ {x.label}</span><small>{x.photos.length ? '📷' : tx.noPhoto(1)}</small></button>)}
        </div>}
        {screen.i > 0 && <button className="link fr-back" onClick={() => setScreen({ ...screen, i: screen.i - 1 })}>{tx.prev}</button>}
      </div>
    );
  } else if (screen.k === 'problem') {
    const s = sections[screen.s]!;
    const it = screen.item != null ? s.items[screen.item]! : null;
    const c = it ? checkOf(s, it) : data.checks.find(x => x.id === screen.checkId);
    body = <Problem key={`${screen.s}:${screen.item ?? screen.checkId ?? 'new'}`} tx={tx} where={title(s)} item={it} check={c ?? null} busy={busy} note={note}
      onBack={() => setScreen(it ? { k: 'item', s: screen.s, i: screen.item! } : { k: 'item', s: screen.s, i: 0 })}
      save={b => act(b.checkId || !b.label ? { action: 'check', ...b } : { action: 'add', area: s.area, n: s.n, ...b })}
      photo={async (checkId, f) => {
        setBusy(true); setMsg('');
        try {
          const r = await inspectPhotos(token, name.trim(), checkId, [await shrink(f)]);
          if (!r.ok) { setMsg(r.message ?? tx.notSaved); return false; }
          setData(r); return true;
        } catch (e) { setMsg(String(e)); return false; } finally { setBusy(false); }
      }}
      onCreated={id => setScreen({ k: 'problem', s: screen.s, checkId: id })}
      remove={id => void act({ action: 'remove', checkId: id }).then(r => r && setScreen({ k: 'item', s: screen.s, i: 0 }))}
      done={() => it ? nextIn(screen.s, screen.item!, data) : setScreen({ k: 'item', s: screen.s, i: 0 })} />;
  } else if (screen.k === 'review') {
    const all = sections.flatMap(s => findings(s).map(c => ({ c, where: title(s) })));
    body = (
      <div className="fr">
        <button className="link fr-back" onClick={() => setScreen({ k: 'rooms' })}>{tx.edit}</button>
        <p className="fr-q">{tx.review}</p>
        <p className="fr-tip">{tx.reviewTip}</p>
        {!all.length && <p className="fr-big">✓ {tx.none}</p>}
        {NEEDS.filter(n => all.some(x => needOf(x.c.outcome) === n)).map(n => (
          <div key={n} className="fr-group">
            <p className="fr-cat">{tx[n]} · {all.filter(x => needOf(x.c.outcome) === n).length}</p>
            {all.filter(x => needOf(x.c.outcome) === n).map(({ c, where }) => (
              <div key={c.id} className="fr-line"><span>{c.label}<small>{where}{c.note ? ` · ${c.note}` : ''}</small></span>
                <small>📷 {c.photos.length}</small></div>))}
          </div>
        ))}
        {note}
        <button className="fr-btn fr-go" disabled={busy} onClick={() => void act({ action: 'send' })}>{busy ? tx.saving : tx.sendNow}</button>
      </div>
    );
  } else {
    const left = sections.filter(s => answered(s) < s.items.length || findings(s).some(c => !c.photos.length));
    const total = sections.length, done = total - left.length;
    body = (
      <div className="fr">
        <p className="fr-q">{tx.rooms}</p>
        <div className="ins-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><i style={{ width: `${done / total * 100}%` }} /></div>
        <p className="fr-tip">{tx.of(done, total)} · {tx.roomsTip}</p>
        {tx.english && <p className="fr-tip">{tx.english}</p>}
        {sections.map((s, si) => {
          const n = answered(s), f = findings(s), noPhoto = f.filter(c => !c.photos.length).length, ok = !left.includes(s);
          return (
            <button key={`${s.area}:${s.n}`} className="fr-btn fr-choice fr-stepbtn"
                    onClick={() => { const j = s.items.findIndex(it => !checkOf(s, it)?.result); setScreen({ k: 'item', s: si, i: j >= 0 ? j : 0 }); }}>
              <span className={`fr-num${ok ? ' ins-done' : ''}`}>{ok ? '✓' : si + 1}</span>
              <span>{title(s)}<small>{n ? `${n === s.items.length ? '✓ ' : ''}${tx.of(n, s.items.length)}` : tx.notYet}</small>
                {!!f.length && <small className="ins-prob">▲ {tx.prob(f.length)}{noPhoto ? ` · ${tx.noPhoto(noPhoto)}` : ''}</small>}</span>
            </button>
          );
        })}
        <button className="fr-btn fr-go" disabled={!!left.length} onClick={() => setScreen({ k: 'review' })}>{tx.send}</button>
        {!!left.length && <p className="fr-missing">{tx.missing(left.map(title).join(', '))}</p>}
      </div>
    );
  }

  return (
    <>{head}
    <div className="report-page">
      {named && <p className="fr-kind report-who">👤 {name} · <button className="link" onClick={() => setNamed(false)}>{tx.change}</button></p>}
      <div className="card">{body}</div>
    </div>
    </>
  );
}

/**
 * One problem: what it is (an item's label, or typed for "something else"),
 * a photo (required), what it needs (the item's usual one suggested), a note.
 * "Something else" is created on its first photo, so it never exists without one.
 */
function Problem({ tx, where, item, check, busy, note, onBack, save, photo, onCreated, remove, done }: {
  tx: Tx; where: string; item: InspectionItem | null; check: RunCheck | null; busy: boolean; note: JSX.Element | null;
  onBack: () => void; save: (b: Record<string, unknown>) => Promise<{ checkId?: string } | null>;
  photo: (checkId: string, f: File) => Promise<boolean>; onCreated: (id: string) => void;
  remove: (checkId: string) => void; done: () => void;
}) {
  const suggested: Need | null = item ? needOf(suggestedOutcome(item.defaultOutcome)) : null;
  const [need, setNeed] = useState<Need>(check?.outcome ? needOf(check.outcome) : suggested ?? 'repair');
  const [label, setLabel] = useState(check?.label ?? '');
  const [text, setText] = useState(check?.note ?? '');
  const [sending, setSending] = useState(false);
  const free = !item;
  const photos = check?.photos.length ?? 0;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    let id = check?.id;
    if (!id) {
      if (!label.trim()) return;
      const r = await save({ kind: KIND[need], label: label.trim(), note: text });
      if (!r?.checkId) return;
      id = r.checkId;
    }
    setSending(true);
    await photo(id, f);
    setSending(false);
    if (!check) onCreated(id);
  };
  const choose = (n: Need) => { setNeed(n); if (check) void save({ checkId: check.id, outcome: n }); };

  return (
    <div className="fr">
      <button className="link fr-back" onClick={onBack} disabled={busy}>← {where}</button>
      <p className="fr-kind">{where} · {tx.probQ}</p>
      {free && !check ? <>
        <label className="fr-q" htmlFor="ins-what">{tx.describe}</label>
        <input id="ins-what" className="fr-select" value={label} maxLength={200} placeholder={tx.describePh} onChange={e => setLabel(e.target.value)} />
      </> : <p className="fr-big ins-item">{check?.label ?? item?.label}</p>}

      {!!photos && <p className="fr-done-line">{tx.photos(photos)}</p>}
      <label className={`fr-btn ${photos ? 'secondary' : 'fr-go'}${busy || (free && !check && !label.trim()) ? ' off' : ''}`}>
        {sending ? tx.sendingPhoto : photos ? tx.photoMore : tx.photo}
        <input type="file" accept="image/*" capture="environment" hidden disabled={busy || (free && !check && !label.trim())}
               onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void pick(f); }} />
      </label>
      {free && !check && !label.trim() && <p className="fr-missing">{tx.describeFirst}</p>}

      <p className="fr-q">{tx.need}</p>
      <div className="fr-urg" role="radiogroup" aria-label={tx.need}>
        {NEEDS.map(n => <button key={n} role="radio" aria-checked={need === n} className={`fr-btn fr-choice${need === n ? ' on' : ''}`}
                                disabled={busy} onClick={() => choose(n)}>
          {tx[n]}{n === suggested && <small className="ins-sug"> · {tx.sug}</small>}</button>)}
      </div>
      <label className="fr-field" htmlFor="ins-note">{tx.note}</label>
      <textarea id="ins-note" className="fr-text" rows={3} maxLength={1000} placeholder={tx.notePh} value={text} onChange={e => setText(e.target.value)} />
      {note}
      <button className="fr-btn fr-go" disabled={busy || !photos}
              onClick={() => void save({ checkId: check!.id, note: text, outcome: need }).then(r => r && done())}>{tx.save}</button>
      {!photos && <p className="fr-missing">{tx.needPhoto}</p>}
      {free && check && <button className="link fr-back danger" disabled={busy} onClick={() => remove(check.id)}>{tx.remove}</button>}
    </div>
  );
}

function Sent({ tx, lang, sent, busy, onReopen }: { tx: Tx; lang: Lang; sent: { at: string; by: string }; busy: boolean; onReopen: () => void }) {
  const [asking, setAsking] = useState(false);
  // sent.at is the database's timestamp; shown in New York time like the rest of ops.
  const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sent.at)).replace(', ', ' ');
  return (
    <div className="fr fr-done" role="status">
      <p className="fr-done-line">{tx.sent}</p>
      <p className="fr-tip">{tx.sentTip(sent.by, stampLabel(lang, ny))}</p>
      {asking ? <div className="fr-confirm">
        <p>{tx.sure}</p>
        <button className="fr-btn fr-go" disabled={busy} onClick={onReopen}>{tx.yes}</button>
        <button className="fr-btn secondary" onClick={() => setAsking(false)}>{tx.no}</button>
      </div> : <button className="fr-btn secondary" onClick={() => setAsking(true)}>{tx.reopen}</button>}
    </div>
  );
}
