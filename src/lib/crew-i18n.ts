/**
 * The crew page in the cleaner's language (§129): English or Spanish.
 *
 * Only what a CLEANER reads is here — the team's side stays in English
 * (the app's rule). Dates, periods and paydays are formatted per language;
 * reasons Kaizen itself wrote ("booking cancelled in Hostaway") are put
 * into Spanish; notes a person typed (a flag, a denial) stay as written.
 *
 * Pure: no framework. The English output is exactly what the page said
 * before this file existed.
 */
import type { DateStr } from './dates.ts';
import { movementText, type ExtraStatus, type InvoicePeriod, type Movement, type Period } from './crew.ts';

export type Lang = 'en' | 'es';
export const LANGS: Lang[] = ['en', 'es'];
export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'es';
export const LANG_NAME: Record<Lang, string> = { en: 'English', es: 'Español' };

const DOW = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], es: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] };
const MON = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
              es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] };
const MONTH = { en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
                es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] };
export const DOW_LETTER: Record<Lang, string[]> = { en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'], es: ['D', 'L', 'M', 'M', 'J', 'V', 'S'] };

const parts = (d: DateStr) => {
  const t = new Date(`${d}T12:00:00Z`);
  return { w: t.getUTCDay(), m: t.getUTCMonth(), d: t.getUTCDate(), y: t.getUTCFullYear() };
};

/** "Sun, Oct 11" / "dom 11 oct". */
export function dayLabel(lang: Lang, d: DateStr): string {
  const p = parts(d);
  return lang === 'es' ? `${DOW.es[p.w]} ${p.d} ${MON.es[p.m]}` : `${DOW.en[p.w]}, ${MON.en[p.m]} ${p.d}`;
}
/** "2026-10-11 21:40" → "Sun, Oct 11 at 21:40" / "dom 11 oct a las 21:40". */
export const stampLabel = (lang: Lang, at: string) =>
  `${dayLabel(lang, at.slice(0, 10))} ${lang === 'es' ? 'a las' : 'at'} ${at.slice(11, 16)}`;
export const monthTitle = (lang: Lang, y: number, m: number) => `${MONTH[lang][m - 1]} ${y}`;

/** An invoice period's name: "Oct 10 – Oct 16, 2026" / "10 oct – 16 oct 2026"; "Oct 2026" / "octubre 2026". */
export function periodLabel(lang: Lang, p: Period, kind: InvoicePeriod): string {
  const a = parts(p.from), b = parts(p.to);
  if (kind === 'weekly') {
    return lang === 'es' ? `${a.d} ${MON.es[a.m]} – ${b.d} ${MON.es[b.m]} ${b.y}` : `${MON.en[a.m]} ${a.d} – ${MON.en[b.m]} ${b.d}, ${b.y}`;
  }
  return lang === 'es' ? `${MONTH.es[a.m]} ${a.y}` : `${MON.en[a.m]} ${a.y}`;
}
/** When it is paid: "Saturday, Oct 17" / "el sábado 17 oct"; "the first days of November" / "los primeros días de noviembre". */
export function payNote(lang: Lang, p: Period, kind: InvoicePeriod): string {
  const q = parts(p.payday);
  if (kind === 'weekly') return lang === 'es' ? `el sábado ${q.d} ${MON.es[q.m]}` : `Saturday, ${MON.en[q.m]} ${q.d}`;
  return lang === 'es' ? `los primeros días de ${MONTH.es[q.m]}` : `the first days of ${MONTH.en[q.m]}`;
}

/** The reasons Kaizen writes on a clean it does not pay, in the cleaner's language. Anything else stays as written. */
export function voidReasonText(lang: Lang, reason: string): string {
  if (lang === 'en') return reason;
  if (reason === 'booking cancelled in Hostaway') return 'reserva cancelada en Hostaway';
  let m = /^same unit and day as reservation (\S+) — one clean$/.exec(reason);
  if (m) return `misma unidad y día que la reserva ${m[1]} — una sola limpieza`;
  m = /^booking changed — the guest booked again as reservation (\S+), which carries the clean$/.exec(reason);
  if (m) return `reserva cambiada — el huésped volvió a reservar (reserva ${m[1]}), que lleva la limpieza`;
  return reason;
}

const KIND: Record<string, Record<Lang, string>> = {
  early_departure: { en: 'early departure', es: 'salida anticipada' },
  mid_stay: { en: 'mid-stay', es: 'a mitad de estancia' },
  extra: { en: 'extra', es: 'extra' }
};
export const kindWord = (lang: Lang, kind: string) => KIND[kind]?.[lang] ?? kind.replace('_', ' ');
export const bedsWord = (lang: Lang, beds: number | null | undefined) => beds ? (lang === 'es' ? `${beds} hab.` : `${beds}BR`) : '';

/** An invoice line's work: "2BR deep clean (early departure)" / "2 hab. limpieza profunda (salida anticipada)". */
export function workText(lang: Lang, c: { beds: number | null; deep: boolean; kind: string }): string {
  const what = lang === 'es' ? (c.deep ? 'limpieza profunda' : 'limpieza') : (c.deep ? 'deep clean' : 'clean');
  const k = c.kind === 'checkout' ? null : `(${kindWord(lang, c.kind)})`;
  return [bedsWord(lang, c.beds) || null, what, k].filter(Boolean).join(' ');
}

/** What moved, told to the cleaner. */
export function movementFor(lang: Lang, m: Movement): string {
  const day = (d: DateStr) => dayLabel(lang, d);
  if (lang === 'en') return movementText(m, day, true);
  switch (m.kind) {
    case 'added': return `Nueva: ${m.unit} el ${day(m.date)}`;
    case 'moved': return `${m.unit}: la salida pasó del ${day(m.from)} al ${day(m.to)} (${m.later ? 'estancia extendida' : 'estancia acortada'})`;
    case 'time': return `${m.unit} el ${day(m.date)}: la hora de salida cambió de ${m.from} a ${m.to}`;
    case 'removed': return `${m.unit} el ${day(m.date)}: ${({
      cancelled: 'reserva cancelada — sin limpieza', declined: 'la rechazaste', not_needed: 'ya no hace falta limpiar',
      unassigned: 'quitada de tu agenda, aún sin asignar a nadie', reassigned: 'asignada a otra persona' })[m.why]}`;
  }
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** Every other sentence a cleaner reads, per language. */
export const TX = {
  en: {
    loading: 'Loading your cleans…', loadFail: 'Could not load your page.',
    hi: (name: string) => `Hi, ${name}`, inactive: 'inactive', notPriced: 'not priced', notSaved: 'Not saved.',
    periodField: (k: InvoicePeriod) => `Invoice period (${k === 'weekly' ? 'weekly, Saturday to Friday, paid Saturday' : 'monthly, paid in the first days of the next month'})`,
    cleansTitle: (label: string) => `Cleans — ${label}`,
    paidCount: (k: number) => `${k} paid`, soFar: ' so far', notPaidCount: (k: number) => `○ ${k} not paid`,
    flaggedCount: (k: number) => `⚑ ${k} flagged`, extrasWaiting: (k: number) => `○ ${n(k, 'extra', 'extras')} waiting`,
    noCleans: 'No cleans in this period.',
    comingUp: 'Coming up', lastUpdate: (s: string) => `Last update: ${s}`, changesSince: 'Changes since then',
    noChanges: '✓ No changes since then.',
    through: (d: string) => `Through ${d}. Check here before you plan the day.`,
    autoNote: (k: number) => `Your cleans show here ${k} days ahead — sooner when the team assigns one to you directly. Check here before you plan the day.`,
    nothingThrough: (d: string) => `Nothing for you through ${d} yet.`, nothingNext: (k: number) => `Nothing for you in the next ${k} days yet.`,
    theNextDays: 'the next days',
    tagNew: '+ new', tagMoved: (d: string) => `⇢ moved from ${d}`, tagTime: '◷ time changed',
    manualClean: (k: string) => `manual clean (${k})`, checkout: (t: string) => `checkout ${t}`,
    nextGuestAt: (t: string) => `⚡ next guest in at ${t}`, nextGuestSameDay: '⚡ next guest in the same day', deep: '🧽 deep',
    cantDoIt: "Can't do it", whyOptional: 'Why (optional) — the team reads it', sending: 'Sending…',
    declineBtn: 'Decline this clean', keepIt: 'Keep it', declineNote: 'It goes back to the team unassigned, for someone else.',
    notPaidReason: (r: string) => `○ not paid — ${r}`, comingUpTag: '○ coming up', notYours: '○ not assigned to you any more',
    flaggedNote: (t: string) => `⚑ Flagged: ${t}`, corrected: (t: string) => `✎ Corrected by the team: ${t}`,
    manualTag: (k: string) => ` · manual (${k})`,
    extraWord: { pending: '○ waiting for the team', approved: '✓ approved', denied: '■ denied', cancelled: 'withdrawn' } as Record<ExtraStatus, string>,
    attach: '+ receipt / photo', withdraw: 'withdraw', addExtra: '+ Add an extra',
    whatFor: 'What for (e.g. extra laundry load)', receiptOptional: 'Receipt, invoice or photo (optional)',
    sendTeam: 'Send to the team', cancel: 'Cancel', fromInspection: '🧾 From the inspection:',
    calLegend: 'Tap a day for its cleans. ✓ done and paid · ⚑ flagged · ○ not paid · • coming up · ⚡ next guest the same day.',
    calAuto: (k: number) => ` Coming up shows your cleans ${k} days ahead, and any the team assigned to you directly.`,
    nothing: ' — nothing', icsBtn: '📅 Add my coming cleans to my phone calendar',
    icsNote: 'A copy of them as they are now — if one changes, check this page and add them again.',
    calNotPaid: (r: string) => `not paid — ${r}`, calFlagged: (t: string) => `flagged — ${t}`, calDeep: ' · deep',
    calNotYours: 'not assigned to you any more', calNextGuest: (t: string | null) => ` · next guest in${t ? ` at ${t}` : ''}`,
    icsSummary: (unit: string, beds: string) => `Clean ${unit}${beds ? ` (${beds})` : ''}`,
    icsCheckout: 'checkout clean', icsNextGuest: (t: string | null) => ` — next guest in${t ? ` at ${t}` : ' the same day'}`,
    icsPays: (p: string) => ` Pays ${p}.`,
    from: 'From', to: 'To', period: 'Period', paid: 'Paid', print: 'Print / save as PDF',
    open: (d: string, p: string) => `○ This period is still open — cleans done by ${d} are added. Paid ${p}.`,
    colDate: 'Date', colUnit: 'Unit', colWork: 'Work', colAmount: 'Amount', extraLine: (t: string) => `Extra — ${t}`,
    noPaid: 'No paid cleans in this period.', cleans: 'Cleans', approvedExtras: 'Approved extras', total: 'Total',
    unpriced: (k: number) => `▲ ${k} clean${k === 1 ? ' has' : 's have'} no rate on the card yet and ${k === 1 ? 'is' : 'are'} not in the total — the team sets it.`,
    pendingExtras: (k: number) => `○ ${k} extra${k === 1 ? ' is' : 's are'} waiting for the team and not in the total yet.`,
    notPaidIn: 'Not paid in this period:',
    // §134: reports from the field, one clean at a time — written for people who are not at home on a phone:
    // one question per screen, an icon and a word on every choice.
    optLabel: 'Options…', optShare: '📤 Send the link to my helper',
    supMenuQ: 'What do you want to tell the team?',
    supKind: { used: '🧴 What I took for this clean', purchase: '🛒 I bought something', missing: '❓ Something is missing',
               problem: '⚠️ Something is wrong', request: '🙋 I need something' } as Record<string, string>,
    supUsedQ: 'Tap + for each thing you took.', supBuyQ: 'What did you buy?', supMissQ: 'What is missing?',
    supProblemQ: 'What is wrong?', supRequestQ: 'What do you need?',
    supPickItem: 'Choose…', supHowMany: 'How many?', supFound: 'How many are there now?', supCost: 'Total paid (optional)',
    supReceiptBtn: 'Photo of the receipt', supPhotoBtn: 'A photo (optional)', supPhotos: (k: number) => `✓ ${k} photo${k === 1 ? '' : 's'}`,
    supRemove: 'Remove', supSpeakTip: 'Tip: tap the 🎤 on your keyboard to speak instead of typing.',
    supCat: { kitchen: 'Kitchen', bathroom: 'Bathroom', cleaning: 'Cleaning', linens: 'Linens', other: 'Other' } as Record<string, string>,
    supSendCount: (k: number) => `Send — ${k} thing${k === 1 ? '' : 's'}`,
    supNeedAny: 'Tap + on what you took.', supNeedItem: 'Choose what it is.', supNeedQty: 'Say how many.',
    supNeedText: 'Write what it is (or say it with the 🎤).',
    supDone: '✓ Sent. Thank you!', supDoneTask: 'The team got it as a task.',
    supAnother: 'Tell something else', supBack: '← Back', supClose: 'Close',
    shareFor: (unit: string, day: string) => `A link for whoever helps you at ${unit} on ${day}.`,
    shareWhat: 'With it they can say what they took, what is missing or what is wrong — for this clean only. They need no account.',
    shareUntil: (d: string) => `It works until ${d}.`,
    shareWa: 'Send by WhatsApp', shareMore: 'Share…', shareCopy: 'Copy link', shareCopied: '✓ Copied',
    shareMsg: (unit: string, day: string, link: string) => `Kaizen — ${unit}, ${day}. Open this to tell the team what you took or a problem: ${link}`,
    optExtra: '💵 Add an extra', extraAmount: 'How much? ($)', extraWhat: 'What was it for?',
    extraNote: 'For work beyond the clean (an extra laundry load, a deep spot…). The team approves or denies it; only approved extras are paid, with this clean.',
    extraNeedAmount: (max: number) => `Write the amount (up to $${max}).`, extraNeedWhat: 'Say what it was for.',
    extraSent: 'The team will approve or deny it — you will see it on this clean.',
    tabClean: '🧽 My clean', tabReport: '🙋 Report or ask', repSwitch: 'Your cleans on this phone', repName: 'What is your name?', repNameNote: 'So the team knows who it was. This phone remembers it.',
    repContinue: 'Continue', repChange: 'Change name', repBad: 'This link is incomplete — ask for it again.',
    // §134: the clean step by step — photos before, after, done.
    urgQ: 'How urgent is it?', urgNeed: 'Choose how urgent it is.',
    urg: { urgent: '🔴 Urgent — before the next guest', high: '🟠 Soon — in the next days', low: '⚪ When possible' } as Record<string, string>,
    optSteps: '📷 Photos & mark as done', stepsTitle: 'Your clean, step by step',
    stepBefore: '📷 Photos BEFORE cleaning', stepAfter: '📷 Photos AFTER cleaning', stepDone: '✅ Mark as done',
    stepCount: (k: number) => k ? `✓ ${k} photo${k === 1 ? '' : 's'}` : 'Not yet',
    stepNeedAfter: 'First the AFTER photos (step 3).', stepNeedTaken: 'First step 2: what you took from storage.',
    stepTaken: '🧴 What I took from storage', takenNotYet: 'Not yet — required',
    takenQ: 'Tap + for each thing you took OUT OF THE STORAGE for this house. What was already in the house does not count.',
    takenNothing: 'I took nothing from storage', takenNone: '✓ Nothing from storage',
    takenCount: (k: number) => `✓ ${k} thing${k === 1 ? '' : 's'}`, stepFolder: 'See the photos in Drive',
    doneBy: (by: string, at: string) => `✅ Done — ${by}, ${at}`, reopen: '↩️ Reopen',
    reopenAsk: 'Reopen this clean? It will show as not done.', reopenYes: 'Yes, reopen', reopenNo: 'No, leave it done',
    photoTake: '📷 Take a photo', photoTakeMore: '📷 Take another photo', photoGallery: '🖼️ Choose from the gallery', photoSend: (k: number) => k ? `Send ${k} photo${k === 1 ? '' : 's'}` : 'Send',
    photoSending: (i: number, k: number) => `Sending ${i} of ${k}…`, photoSaved: (k: number) => `✓ ${k} photo${k === 1 ? '' : 's'} saved`,
    photoContinue: 'Continue', photoNeed: 'Take a photo or choose them from the gallery first.',
    photoTip: 'One photo of each room from the door is enough — and close-ups of anything wrong.',
    stateLine: (b: number, a: number) => `📷 ${b} before · ${a} after`, stateDone: (by: string) => `✅ done (${by})`
  },
  es: {
    loading: 'Cargando tus limpiezas…', loadFail: 'No se pudo cargar tu página.',
    hi: (name: string) => `Hola, ${name}`, inactive: 'inactivo', notPriced: 'sin precio', notSaved: 'No se guardó.',
    periodField: (k: InvoicePeriod) => `Periodo de invoice (${k === 'weekly' ? 'semanal, de sábado a viernes, se paga el sábado' : 'mensual, se paga los primeros días del mes siguiente'})`,
    cleansTitle: (label: string) => `Limpiezas — ${label}`,
    paidCount: (k: number) => `${n(k, 'pagada', 'pagadas')}`, soFar: ' hasta ahora', notPaidCount: (k: number) => `○ ${n(k, 'sin pago', 'sin pago')}`,
    flaggedCount: (k: number) => `⚑ ${n(k, 'marcada', 'marcadas')}`, extrasWaiting: (k: number) => `○ ${n(k, 'extra', 'extras')} en espera`,
    noCleans: 'No hay limpiezas en este periodo.',
    comingUp: 'Próximas', lastUpdate: (s: string) => `Última actualización: ${s}`, changesSince: 'Cambios desde entonces',
    noChanges: '✓ Sin cambios desde entonces.',
    through: (d: string) => `Hasta el ${d}. Revisa aquí antes de planear tu día.`,
    autoNote: (k: number) => `Tus limpiezas aparecen aquí ${k} días antes — antes, si el equipo te asigna una directamente. Revisa aquí antes de planear tu día.`,
    nothingThrough: (d: string) => `Todavía nada para ti hasta el ${d}.`, nothingNext: (k: number) => `Todavía nada para ti en los próximos ${k} días.`,
    theNextDays: 'los próximos días',
    tagNew: '+ nueva', tagMoved: (d: string) => `⇢ movida desde el ${d}`, tagTime: '◷ cambió la hora',
    manualClean: (k: string) => `limpieza manual (${k})`, checkout: (t: string) => `salida ${t}`,
    nextGuestAt: (t: string) => `⚡ entra huésped a las ${t}`, nextGuestSameDay: '⚡ entra huésped el mismo día', deep: '🧽 profunda',
    cantDoIt: 'No puedo', whyOptional: '¿Por qué? (opcional) — el equipo lo lee', sending: 'Enviando…',
    declineBtn: 'Rechazar esta limpieza', keepIt: 'Me la quedo', declineNote: 'Vuelve al equipo sin asignar, para otra persona.',
    notPaidReason: (r: string) => `○ sin pago — ${r}`, comingUpTag: '○ próxima', notYours: '○ ya no está asignada a ti',
    flaggedNote: (t: string) => `⚑ Marcada: ${t}`, corrected: (t: string) => `✎ Corregida por el equipo: ${t}`,
    manualTag: (k: string) => ` · manual (${k})`,
    extraWord: { pending: '○ esperando al equipo', approved: '✓ aprobado', denied: '■ rechazado', cancelled: 'retirado' } as Record<ExtraStatus, string>,
    attach: '+ recibo / foto', withdraw: 'retirar', addExtra: '+ Agregar un extra',
    whatFor: '¿Para qué? (p. ej., una carga extra de lavandería)', receiptOptional: 'Recibo, invoice o foto (opcional)',
    sendTeam: 'Enviar al equipo', cancel: 'Cancelar', fromInspection: '🧾 De la inspección:',
    calLegend: 'Toca un día para ver sus limpiezas. ✓ hecha y pagada · ⚑ marcada · ○ sin pago · • próxima · ⚡ entra huésped el mismo día.',
    calAuto: (k: number) => ` En "Próximas" ves tus limpiezas ${k} días antes, y las que el equipo te asignó directamente.`,
    nothing: ' — nada', icsBtn: '📅 Agregar mis próximas limpiezas al calendario del teléfono',
    icsNote: 'Es una copia de cómo están ahora — si alguna cambia, revisa esta página y vuelve a agregarlas.',
    calNotPaid: (r: string) => `sin pago — ${r}`, calFlagged: (t: string) => `marcada — ${t}`, calDeep: ' · profunda',
    calNotYours: 'ya no está asignada a ti', calNextGuest: (t: string | null) => ` · entra huésped${t ? ` a las ${t}` : ''}`,
    icsSummary: (unit: string, beds: string) => `Limpieza ${unit}${beds ? ` (${beds})` : ''}`,
    icsCheckout: 'limpieza de salida', icsNextGuest: (t: string | null) => ` — entra huésped${t ? ` a las ${t}` : ' el mismo día'}`,
    icsPays: (p: string) => ` Paga ${p}.`,
    from: 'De', to: 'Para', period: 'Periodo', paid: 'Pago', print: 'Imprimir / guardar como PDF',
    open: (d: string, p: string) => `○ Este periodo sigue abierto — se suman las limpiezas hechas hasta el ${d}. Se paga ${p}.`,
    colDate: 'Fecha', colUnit: 'Unidad', colWork: 'Trabajo', colAmount: 'Monto', extraLine: (t: string) => `Extra — ${t}`,
    noPaid: 'No hay limpiezas pagadas en este periodo.', cleans: 'Limpiezas', approvedExtras: 'Extras aprobados', total: 'Total',
    unpriced: (k: number) => `▲ ${k === 1 ? '1 limpieza aún no tiene' : `${k} limpiezas aún no tienen`} tarifa y no ${k === 1 ? 'está' : 'están'} en el total — la pone el equipo.`,
    pendingExtras: (k: number) => `○ ${k === 1 ? '1 extra espera' : `${k} extras esperan`} al equipo y aún no ${k === 1 ? 'está' : 'están'} en el total.`,
    notPaidIn: 'Sin pago en este periodo:',
    optLabel: 'Opciones…', optShare: '📤 Enviar el enlace a mi ayudante',
    supMenuQ: '¿Qué le quieres avisar al equipo?',
    supKind: { used: '🧴 Lo que tomé para esta limpieza', purchase: '🛒 Compré algo', missing: '❓ Falta algo',
               problem: '⚠️ Algo está mal', request: '🙋 Necesito algo' } as Record<string, string>,
    supUsedQ: 'Toca + por cada cosa que tomaste.', supBuyQ: '¿Qué compraste?', supMissQ: '¿Qué falta?',
    supProblemQ: '¿Qué está mal?', supRequestQ: '¿Qué necesitas?',
    supPickItem: 'Elige…', supHowMany: '¿Cuántos?', supFound: '¿Cuántos hay ahora?', supCost: 'Total pagado (opcional)',
    supReceiptBtn: 'Foto del recibo', supPhotoBtn: 'Una foto (opcional)', supPhotos: (k: number) => `✓ ${k} foto${k === 1 ? '' : 's'}`,
    supRemove: 'Quitar', supSpeakTip: 'Consejo: toca el 🎤 de tu teclado para hablar en vez de escribir.',
    supCat: { kitchen: 'Cocina', bathroom: 'Baño', cleaning: 'Limpieza', linens: 'Blancos', other: 'Otros' } as Record<string, string>,
    supSendCount: (k: number) => `Enviar — ${k} ${k === 1 ? 'cosa' : 'cosas'}`,
    supNeedAny: 'Toca + en lo que tomaste.', supNeedItem: 'Elige qué es.', supNeedQty: 'Di cuántos.',
    supNeedText: 'Escribe qué es (o dilo con el 🎤).',
    supDone: '✓ Enviado. ¡Gracias!', supDoneTask: 'El equipo lo recibió como tarea.',
    supAnother: 'Avisar otra cosa', supBack: '← Atrás', supClose: 'Cerrar',
    shareFor: (unit: string, day: string) => `Un enlace para quien te ayude en ${unit} el ${day}.`,
    shareWhat: 'Con él puede avisar qué tomó, qué falta o qué está mal — solo de esta limpieza. No necesita cuenta.',
    shareUntil: (d: string) => `Funciona hasta el ${d}.`,
    shareWa: 'Enviar por WhatsApp', shareMore: 'Compartir…', shareCopy: 'Copiar enlace', shareCopied: '✓ Copiado',
    shareMsg: (unit: string, day: string, link: string) => `Kaizen — ${unit}, ${day}. Abre esto para avisarle al equipo qué tomaste o un problema: ${link}`,
    optExtra: '💵 Agregar un extra', extraAmount: '¿Cuánto? ($)', extraWhat: '¿Para qué fue?',
    extraNote: 'Para trabajo más allá de la limpieza (una carga extra de lavandería, una mancha profunda…). El equipo lo aprueba o lo rechaza; solo se pagan los extras aprobados, junto con esta limpieza.',
    extraNeedAmount: (max: number) => `Escribe el monto (hasta $${max}).`, extraNeedWhat: 'Di para qué fue.',
    extraSent: 'El equipo lo aprobará o rechazará — lo verás en esta limpieza.',
    tabClean: '🧽 Mi limpieza', tabReport: '🙋 Avisar o pedir', repSwitch: 'Tus limpiezas en este teléfono', repName: '¿Cómo te llamas?', repNameNote: 'Para que el equipo sepa quién fue. Este teléfono lo recuerda.',
    repContinue: 'Continuar', repChange: 'Cambiar nombre', repBad: 'Este enlace está incompleto — pídelo de nuevo.',
    urgQ: '¿Qué tan urgente es?', urgNeed: 'Elige qué tan urgente es.',
    urg: { urgent: '🔴 Urgente — antes del próximo huésped', high: '🟠 Pronto — en los próximos días', low: '⚪ Cuando se pueda' } as Record<string, string>,
    optSteps: '📷 Fotos y marcar completada', stepsTitle: 'Tu limpieza, paso a paso',
    stepBefore: '📷 Fotos ANTES de limpiar', stepAfter: '📷 Fotos DESPUÉS de limpiar', stepDone: '✅ Marcar como completada',
    stepCount: (k: number) => k ? `✓ ${k} foto${k === 1 ? '' : 's'}` : 'Todavía no',
    stepNeedAfter: 'Primero las fotos del DESPUÉS (paso 3).', stepNeedTaken: 'Primero el paso 2: lo que tomaste del storage.',
    stepTaken: '🧴 Lo que tomé del storage', takenNotYet: 'Todavía no — obligatorio',
    takenQ: 'Toca + por cada cosa que sacaste DEL STORAGE para esta casa. Lo que ya estaba en la casa no cuenta.',
    takenNothing: 'No tomé nada del storage', takenNone: '✓ Nada del storage',
    takenCount: (k: number) => `✓ ${k} ${k === 1 ? 'cosa' : 'cosas'}`, stepFolder: 'Ver las fotos en Drive',
    doneBy: (by: string, at: string) => `✅ Completada — ${by}, ${at}`, reopen: '↩️ Reabrir',
    reopenAsk: '¿Reabrir esta limpieza? Se verá como no completada.', reopenYes: 'Sí, reabrir', reopenNo: 'No, dejarla completada',
    photoTake: '📷 Tomar foto', photoTakeMore: '📷 Tomar otra foto', photoGallery: '🖼️ Elegir de la galería', photoSend: (k: number) => k ? `Enviar ${k} foto${k === 1 ? '' : 's'}` : 'Enviar',
    photoSending: (i: number, k: number) => `Enviando ${i} de ${k}…`, photoSaved: (k: number) => `✓ ${k} foto${k === 1 ? '' : 's'} guardada${k === 1 ? '' : 's'}`,
    photoContinue: 'Continuar', photoNeed: 'Primero toma una foto o elígelas de la galería.',
    photoTip: 'Basta una foto de cada cuarto desde la puerta — y de cerca lo que esté mal.',
    stateLine: (b: number, a: number) => `📷 ${b} antes · ${a} después`, stateDone: (by: string) => `✅ completada (${by})`
  }
};
export type Tx = typeof TX.en;
