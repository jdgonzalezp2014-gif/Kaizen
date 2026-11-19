/**
 * The help assistant (owner, 2026-11-17): one box for "how do we…?" and "what is the Wi-Fi of…?".
 * Rules do the work before any model is asked (owner: scripts first, to save tokens):
 *   1. a question that names a Repository record (a listing, a tool, a channel) is answered from that record — no AI.
 *      A secret (password, admin code) is never in the answer: it is a button that goes through the Repository's own
 *      reveal (permission `repository.reveal`, written to the reveal log).
 *   2. anything else goes to the SOPs: ranked by words (slack-sops `rankSops`); only if some match is a light model
 *      asked to answer from those few — the same path as @Kaizen in Slack.
 * Pure: the matching and the choice of fields.
 */
import { scrubCodes } from './guest-knowledge.ts';

export interface RepoRec {
  table: string; tableTitle: string; id: string; name: string;
  vals: Record<string, unknown>;
  columns: { key: string; title: string }[];
  /** Column keys that hold a stored secret for this record. */
  secrets: string[];
}
export interface RepoAnswer {
  table: string; tableTitle: string; id: string; name: string;
  fields: { label: string; value: string }[];
  secrets: { column: string; label: string }[];
  /** The question named a field this record has (wifi, check-in…): the card is the answer. False = a sentence may be needed. */
  matched: boolean;
}

const tokens = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
/** Words a name may carry that say nothing about which record it is. */
const FILLER = new Set(['the', 'and', 'for', 'de', 'del', 'la', 'el', 'los', 'las', 'house', 'unit', 'apt', 'account', 'login', 'log', 'ins']);
/** What people call a field, in English and Spanish → words found in column titles. */
const FIELD_WORDS: Record<string, string[]> = {
  wifi: ['wifi', 'wi-fi', 'network', 'internet'], internet: ['wifi', 'wi-fi', 'network', 'internet'],
  password: ['password'], contrasena: ['password'], clave: ['password', 'code'], pass: ['password'],
  code: ['code'], codigo: ['code'], pin: ['pin', 'code'], door: ['door', 'code', 'lock'], puerta: ['door', 'code', 'lock'], lockbox: ['lockbox'],
  address: ['address'], direccion: ['address'], parking: ['parking'], parqueadero: ['parking'],
  user: ['user', 'email', 'login'], usuario: ['user', 'email', 'login'], email: ['email'], correo: ['email'],
  link: ['link', 'url'], phone: ['phone'], telefono: ['phone'],
  // Audit 2026-11-19: what the team asks about a listing most, in both languages.
  checkin: ['check-in'], 'check-in': ['check-in'], entrada: ['check-in'], llegada: ['check-in'],
  checkout: ['check-out'], 'check-out': ['check-out'], salida: ['check-out'],
  pet: ['pet'], pets: ['pet'], mascota: ['pet'], mascotas: ['pet'], perro: ['pet'],
  guests: ['guests'], huespedes: ['guests'], capacity: ['guests'], capacidad: ['guests'], personas: ['guests'],
  beds: ['beds', 'bedrooms'], camas: ['beds', 'bedrooms'], bedrooms: ['bedrooms'], habitaciones: ['bedrooms'], cuartos: ['bedrooms'], banos: ['bathrooms'], bathrooms: ['bathrooms'],
  rules: ['rules'], reglas: ['rules'], cancellation: ['cancellation'], cancelacion: ['cancellation'],
  fee: ['fee'], fees: ['fee'], tarifa: ['fee'], cleaning: ['cleaning'], limpieza: ['cleaning'],
  lock: ['lock'], cerradura: ['lock'], fob: ['fob', 'keys'], fobs: ['fob', 'keys'], llave: ['keys', 'fob'], llaves: ['keys', 'fob'],
  manual: ['manual'], trash: ['trash'], basura: ['trash'], elevator: ['elevator'], ascensor: ['elevator'], maintenance: ['maintenance'], mantenimiento: ['maintenance'],
};
/** With nothing asked, the fields people open a listing for, in this order — not the table's first columns (Name, Active, Subitems…). */
const FIRST = ['hw_address', 'location', 'lock_type', 'wifi_network', 'checkin_from', 'checkin_until', 'checkout_time', 'max_guests', 'hw_bedrooms',
  'hw_beds', 'hw_bathrooms', 'parking', 'floor', 'elevator', 'house_manual'];
const firstRank = (key: string) => { const i = FIRST.indexOf(key); return i < 0 ? FIRST.length : i; };
/** Words that say nothing about what is asked — what is left after them, the name and the field words is a real question. */
const ASK_FILLER = new Set([...FILLER, 'what', 'whats', 'is', 'are', 'of', 'in', 'at', 'to', 'a', 'an', 'que', 'cual', 'es', 'en', 'y', 'un', 'una', 'me', 'dame', 'give', 'show', 'tell']);

/** A name's telling words: all of them must be in the question for the record to be meant. */
const nameWords = (name: string) => tokens(name).filter(w => !FILLER.has(w) && (w.length >= 3 || /\d/.test(w)));

/**
 * The records a question names, best first. A record is named when its name's telling words are in the question:
 * all of them ("amber valley wifi" → Amber Valley), or at least half ("airbnb password" → Airbnb SuperHost Account;
 * "valley" → both Valleys, for the person to pick). A code like CL-1125 is also meant by "cl 1125".
 * The fields shown are the ones the question asks for (wifi, password, code…); none asked → the record's first few.
 */
export function lookup(question: string, records: RepoRec[], max = 4): RepoAnswer[] {
  const q = new Set(tokens(question).flatMap(w => [w, ...w.split('-')]));
  if (!q.size) return [];
  const wanted = new Set([...q].flatMap(w => FIELD_WORDS[w] ?? []));
  const has = (w: string) => q.has(w) || w.split('-').every(p => q.has(p));
  const hits = records.map(r => {
    const nw = nameWords(r.name), m = nw.filter(has).length;
    // Whole names first, then by how much of the name was said.
    return { r, n: !nw.length || !m || m * 2 < nw.length ? 0 : (m === nw.length ? 100 : 0) + m };
  }).filter(x => x.n > 0).sort((a, b) => b.n - a.n);
  const top = hits[0]?.n ?? 0;
  const asks = (title: string) => { const t = tokens(title); return [...wanted].some(w => t.some(x => x === w || x.startsWith(w))); };
  return hits.filter(x => x.n === top).slice(0, max).map(({ r }) => {
    const filled = r.columns.filter(c => !r.secrets.includes(c.key)).map(c => ({ key: c.key, label: c.title, value: text(r.vals[c.key]) })).filter(f => f.value)
      .sort((a, b) => wanted.size ? 0 : firstRank(a.key) - firstRank(b.key)).map(({ label, value }) => ({ label, value }));
    const secrets = r.columns.filter(c => r.secrets.includes(c.key)).map(c => ({ column: c.key, label: c.title }));
    const fields = wanted.size ? filled.filter(f => asks(f.label)) : filled.slice(0, 8);
    const sec = wanted.size ? secrets.filter(s => asks(s.label)) : secrets;
    // Asked for something this record does not have by that name: show what it has rather than nothing.
    const empty = wanted.size > 0 && !fields.length && !sec.length;
    return { table: r.table, tableTitle: r.tableTitle, id: r.id, name: r.name, fields: empty ? filled.slice(0, 8) : fields.slice(0, 10), secrets: empty ? secrets : sec,
      matched: wanted.size > 0 && !empty };
  });
}

/**
 * Words of the question beyond the record's name and the field words: "does napa valley have a pool table" → does, have, pool, table.
 * Two or more, with no field matched, is a question a card of fields does not answer — the light model reads the record.
 */
export function extraWords(question: string, name: string): string[] {
  const nw = new Set(tokens(name).flatMap(w => [w, ...w.split('-')]));
  return tokens(question).filter(w => !nw.has(w) && !ASK_FILLER.has(w) && !FIELD_WORDS[w] && w.length >= 3);
}

/** All of a record's filled, non-secret fields — what the model may answer from. Long texts cut short; codes withheld (a code is asked by name → the card, no AI). */
export function recordText(r: RepoRec): string {
  return scrubCodes(r.columns.filter(c => !r.secrets.includes(c.key)).map(c => [c.title, text(r.vals[c.key])] as const).filter(([, v]) => v)
    .map(([t, v]) => `${t}: ${v.replace(/\s+/g, ' ')}`).join('\n')).slice(0, 9000);
}

/** The light model's question over one record: answer only from its fields, say what is not there. */
export function recordPrompt(question: string, r: RepoRec) {
  const system = [
    'You answer a team member\'s question about one record of the company\'s data repository (short-term rentals). Use ONLY the fields given.',
    'Answer ONLY with JSON: {"answer": string, "fields": string[], "found": boolean}. answer: 1–3 short sentences in the language of the question;',
    'if the fields do not say, found=false and answer says what is not recorded. fields: the field names you used.',
  ].join('\n');
  return { system, user: `Question: ${question.slice(0, 600)}\n\nRecord: ${r.name} (${r.tableTitle})\n${recordText(r)}` };
}

function text(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.trim().slice(0, 400);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ').slice(0, 400);
  return '';
}

/** A record's name from its table's name fields, else its id. */
export const recName = (vals: Record<string, unknown>, nameFields: string[] | null | undefined, id: string) =>
  (nameFields ?? []).map(k => text(vals[k])).filter(Boolean).join(' ') || text(vals.name) || id;
