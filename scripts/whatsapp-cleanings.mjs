#!/usr/bin/env node
/**
 * Turn WhatsApp cleaning-crew chats into rows for the cleanings log.
 *
 *   node scripts/whatsapp-cleanings.mjs <folder> [--out <dir>]
 *
 * WHAT IT WILL NOT DO
 *
 * It never invents a price. A clean whose unit has no invoiced rate comes
 * out with Price empty, because an empty cell is a fact you can act on and
 * a guessed one is a number you will trust. Same for dates: a row without
 * a date it could read is dropped, not estimated.
 *
 * ONE ROW PER CLEAN, AND ONLY WHERE A REAL DATE WAS READ
 *
 * An earlier version also emitted the invoice line items. That was wrong
 * in a way that is easy to miss: the invoices are WEEKLY, so a unit
 * cleaned three times in a week appears three times on one invoice — and
 * dating all three to the invoice day turns three real cleans into three
 * rows on the same day. They look like duplicates because, as dated, they
 * are. The invoices are read for the deep-clean flag and for the summary
 * printed at the end, and nothing dated by them is written out.
 *
 * What comes out is one file: date, unit, deep, cleaner — deduplicated on
 * unit and day, because the same clean gets talked about more than once.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── the units, and every way the crew writes them ────────────────────
//
// Order matters: the first alias that matches wins, so the longer and more
// specific names are listed before the ones they contain. "Napa Valley"
// has to be tested before "Valley", or every Napa clean is filed as Amber.
const UNITS = [
  ['Napa Valley',     ['napa valley', 'napa']],
  ['Amber Valley',    ['amber valley', 'amber', 'valley house', 'valley']],
  ['Timber Crest',    ['timber crest', 'timbercrest', 'timber house', 'timber']],
  ['Preston Vineyard',['preston vineyard', 'preston house', 'preston']],
  ['Kingsford Home',  ['kingsford house', 'kingsford', 'kinsford', 'kingsfor']],
  ['Concord',         ['concord']],
  ['Quest',           ['quest']],
  ['Bobcat House',    ['bobcat']],
  ['Charger Luxe',    ['charger']],
  // Apartments are written as bare numbers.
  ['CL 1125',  ['1125']], ['CL 1446', ['1446']], ['CL1235', ['1235']],
  ['CL1250',   ['1250']], ['CL1339',  ['1339']], ['CL2211', ['2211']],
  ['CL2260',   ['2260']], ['CL2349',  ['2349']], ['CL2359', ['2359']],
  ['CL2450',   ['2450']], ['CL2462',  ['2462']],
  ['P2-1201',  ['1201']], ['P2-1304', ['1304']], ['P2-1406', ['1406']],
  ['P2-4304',  ['4304']], ['P2-4308', ['4308']], ['P2-4323', ['4323']]
];

/**
 * Who did the work.
 *
 * This is not decoration. The same unit is invoiced at $35 by one crew and
 * $70 by another, so a rate that is not tied to a vendor is the midpoint of
 * two real prices and equals neither. Keyed on the phone number rather than
 * the chat, because the crews appear in each other's groups.
 */
const CREW = [
  [/682.?\s?800.?9142/, 'Michelle'],
  [/214.?\s?680.?9619/, 'Karina & Marvin'],
  [/214.?\s?995.?9321/, 'Karina & Marvin'],
  [/402.?\s?303.?2251/, 'Veronica'],
  [/903.?\s?336.?5072/, 'Veronica']
];
const crewOf = sender => CREW.find(([re]) => re.test(sender))?.[1] ?? null;

/**
 * A chat named after one property is itself evidence. "Please consider this
 * unit for tomorrow" in the Preston chat means Preston, and that is most of
 * the scheduling traffic.
 */
const CHAT_DEFAULT = [
  [/preston/i, 'Preston Vineyard'], [/kingsford/i, 'Kingsford Home'],
  [/timber/i, 'Timber Crest'],      [/napa/i, 'Napa Valley'],
  [/amber/i, 'Amber Valley']
];

// Money on a line does not make it an invoice. These are people haggling.
const NOT_A_LINE_ITEM =
  /\b(can you do|usually|typical rate|we can agree|gas cost|i can cover|extra \$?\d+ right|instead of|discount|too high|is too|reminder|payment|sent|paid|total)\b/i;

// Billed, but not a clean. Kept out of the cleaning rows on purpose.
const NOT_A_CLEAN =
  /\b(additional|power wash|tom thumb|ticket|paint|set ?up|help to set|supplies)\b/i;

const INVOICE_HEADER = /\b(invoice of the week|weekly invoice|invoice for deep|here is the invoice|invoice summary)\b/i;
const DEEP = /\bdeep\s*clean/i;

const MEDIA = /<Multimedia omitido>/;
const SKIP = [
  /Se eliminó este mensaje/, /Eliminaste este mensaje/,
  /‎?.*(añadió a|creó el grupo|cambió el nombre|te añadió)/,
  /Los mensajes y las llamadas están cifrados/, /Fijaste un mensaje/
];

const HEAD = /^(\d{1,2})\/(\d{1,2})\/(\d{2}),\s+(\d{1,2}):(\d{2})\s*([ap])\.\s?m\.\s+-\s+(.*)$/;

/** D/M/YY — Spanish export order. Day first, not month. */
function isoDate(d, m, y) {
  return `20${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Group lines into messages; a continuation line has no timestamp. */
/**
 * WhatsApp writes curly quotes. `today'?s` does not match `today’s`, and
 * that one character was silently dropping real scheduling messages — the
 * same class of bug as matching emoji by code range.
 */
const flatten = t => t.replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"');

function parseChat(text, chat) {
  text = flatten(text);
  const msgs = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(HEAD);
    if (m) {
      if (cur) msgs.push(cur);
      const [, d, mo, y, , , , rest] = m;
      const colon = rest.indexOf(': ');
      cur = {
        date: isoDate(+d, +mo, y),
        sender: colon > 0 ? rest.slice(0, colon) : '',
        body: colon > 0 ? rest.slice(colon + 2) : rest,
        chat
      };
    } else if (cur) {
      cur.body += '\n' + raw;
    }
  }
  if (cur) msgs.push(cur);
  return msgs.filter(x => !SKIP.some(re => re.test(x.body)) && x.body.trim());
}

/** First unit named in a string, longest alias first. */
function findUnit(s) {
  const low = ' ' + s.toLowerCase().replace(/[^\w\s-]/g, ' ') + ' ';
  for (const [name, aliases] of UNITS) {
    for (const a of aliases) {
      if (new RegExp(`(?<![\\w-])${a}(?![\\w-])`).test(low)) return name;
    }
  }
  return null;
}

function money(s) {
  const m = s.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// ── read every chat ──────────────────────────────────────────────────
const folder = process.argv[2];
const outDir = (process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : folder) ?? '.';
if (!folder) { console.error('usage: whatsapp-cleanings.mjs <folder> [--out <dir>]'); process.exit(1); }

function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.txt') ? [p] : []);
  });
}

const messages = walk(folder).flatMap(p =>
  parseChat(readFileSync(p, 'utf8'), basename(p).replace(/^Chat de WhatsApp con /, '').replace(/\.txt$/, '')));

// ── pass 1: the rate card, from invoices only ────────────────────────
const rates = new Map();   // `unit||vendor` -> { regular: [], deep: [] }
const billed = [];         // every invoice line item, kept whole
const oddMoney = [];

for (const msg of messages) {
  if (!INVOICE_HEADER.test(msg.body)) continue;
  for (const line of msg.body.split('\n')) {
    const amount = money(line);
    if (amount == null) continue;
    if (/\btotal\b/i.test(line)) continue;
    if (NOT_A_LINE_ITEM.test(line) && !/^[\s\-•*]*\S/.test(line.trim())) continue;

    const unit = findUnit(line);
    const deep = DEEP.test(line);
    const chore = NOT_A_CLEAN.test(line);

    if (!unit) {
      // A four-digit number that is not a unit is almost always a typo for
      // one. Say which, and say it is a guess — do not quietly rewrite it.
      const digits = line.match(/(?<![\d$.])(\d{4})(?![\d])/)?.[1];
      let hint = '';
      if (digits) {
        const near = UNITS.filter(([, a]) => a.some(x => /^\d{4}$/.test(x)))
          .map(([n, a]) => [n, a[0]])
          .filter(([, a]) => [...a].filter((c, i) => c !== digits[i]).length === 1);
        if (near.length === 1) hint = `   <-- not a unit; looks like ${near[0][0]} ($${amount})`;
      }
      oddMoney.push(`${msg.date}  ${line.trim()}   [${msg.chat}]${hint}`);
      continue;
    }

    const vendor = crewOf(msg.sender) ?? 'unknown';
    billed.push({ date: msg.date, unit, vendor, amount, deep, chore, line: line.trim(), chat: msg.chat });
    if (chore) continue;
    const key = `${unit}||${vendor}`;
    if (!rates.has(key)) rates.set(key, { regular: [], deep: [] });
    rates.get(key)[deep ? 'deep' : 'regular'].push(amount);
  }
}

const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), i = a.length >> 1;
  return a.length % 2 ? a[i] : Math.round(((a[i - 1] + a[i]) / 2) * 100) / 100;
};

// ── pass 2: dated events ─────────────────────────────────────────────
//
// Three different kinds of evidence that a clean happened on a day, in
// descending order of how much they prove. They are labelled rather than
// merged, because "the crew said it is done" and "the office asked for it"
// are not the same claim and only one of them is a fact.
const READY = /\b([\w\s.'-]{2,24}?)\s*(?:is\s+|are\s+)?ready\b/i;

/** The crew are phone numbers; the office are names. */
const isCrew = s => /^\+?\d|^\+\s?\(/.test(s.trim());

const events = [];

/**
 * Days a deep clean was named for a unit.
 *
 * "for tomorrow we need a deep cleaning" dates the work to the day after
 * the message, so the shift is applied rather than the message's own date
 * being used — otherwise every scheduled deep lands one day early.
 */
const deepDays = new Set();
const shift = (date, by) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

for (const msg of messages) {
  if (!DEEP.test(msg.body) && !/\bdeep\b/i.test(msg.body)) continue;
  const ahead = /\btomorrow\b/i.test(msg.body) ? 1 : 0;
  for (const line of msg.body.split('\n')) {
    if (!/\bdeep\b/i.test(line) && !/\bdeep\b/i.test(msg.body.split('\n')[0] ?? '')) continue;
    const unit = findUnit(line) ?? (msg.chat ? CHAT_DEFAULT.find(([re]) => re.test(msg.chat))?.[1] : null);
    if (unit) deepDays.add(`${shift(msg.date, ahead)}|${unit}`);
  }
}

for (const msg of messages) {
  if (INVOICE_HEADER.test(msg.body)) continue;
  const lines = msg.body.split('\n');

  // A unit being mentioned is not a unit being cleaned. Every rule below
  // asks the same question — is this unit the SUBJECT of a statement that
  // the work is done — because "Tuesday to concord" and "no sheets ready"
  // both name a unit and neither is a clean.

  // (a) "<unit> ready" — the crew reporting that unit finished.
  //
  // The unit has to OPEN the clause. Without that, "For concord is also no
  // sheets ready" reads as a Concord clean when the thing that is ready is
  // sheets, and "both houses are ready ... from quest to concord" picks
  // whichever name appears first in a sentence about neither.
  if (isCrew(msg.sender)) {
    for (const clause of msg.body.split(/[,.;:|\n]|\band\b/)) {
      const c = clause.trim();
      if (!/\bready\b/i.test(c)) continue;
      if (/\bno\b|\bnot\b|\?|\bwill be\b|\bto be\b|\bwhen\b|\bis it\b|\bare they\b/i.test(c)) continue;
      // Something other than the unit is the subject.
      if (/\b(sheet|towel|duvet|linen|supply|supplies|order|key|code|everything|it|they)\b/i.test(c)) continue;
      const opener = c.match(/^(?:the\s+)?([\w\s-]{2,22}?)\s+(?:house\s+)?(?:is\s+|are\s+|will\s+)?ready\b/i);
      if (!opener) continue;
      const unit = findUnit(opener[1]);
      if (unit) events.push({ date: msg.date, unit, vendor: crewOf(msg.sender),
                              source: 'ready', line: c, chat: msg.chat });
    }
  }

  // (b) A bare unit name from the crew — the caption on a batch of photos
  // of a finished unit. It must BE the name and nothing else: one or two
  // extra words at most, and no verb or preposition anywhere, or "Tuesday
  // to concord" becomes a clean that has not happened yet.
  const only = msg.body.trim();
  if (isCrew(msg.sender) && only.length <= 22 && !/\bready\b/i.test(only)) {
    const words = only.split(/\s+/);
    const noise = /\b(in|at|on|for|to|the|a|is|are|and|or|no|not|so|we|i|it|this|that|just|only|also|do|does|did|will|can|go|going|next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
    const unit = findUnit(only);
    if (unit && words.length <= 3 && /^[\w\s.'-]+$/.test(only) && !noise.test(only)) {
      events.push({ date: msg.date, unit, vendor: crewOf(msg.sender),
                    source: 'photos', line: only, chat: msg.chat });
    }
  }

  // (c) The office naming the day's work. A plan, not a completion — but
  // dated, and nearly all of them happened.
  if (!isCrew(msg.sender) && /today'?s cleaning|today we (have|only have)|remember today|don'?t forget today/i.test(msg.body)) {
    for (const line of lines) {
      const unit = findUnit(line);
      if (unit) events.push({ date: msg.date, unit, vendor: null,
                              source: 'scheduled', line: line.trim(), chat: msg.chat });
    }
  }
}

// (d) A burst of photos.
//
// The normal shape of this chat is thirty photos and no words at all, and
// the office answering "Thanks". That clean happened and was invoiced, and
// in text it left nothing — which is why fewer than a quarter of the
// invoiced cleans were being found.
//
// In a chat named after ONE property the unit is not in doubt, so a day on
// which the crew sent photos there is a day that unit was worked on. In a
// multi-unit chat a burst only counts if the same person named exactly one
// unit that day: two names is a guess, and a guess is what put Concord on
// days nobody cleaned it.
const SHOTS = 4;
const burst = new Map();   // `chat|date|sender` -> count
const named = new Map();   // `chat|date|sender` -> Set(unit)

for (const msg of messages) {
  if (!isCrew(msg.sender)) continue;
  const k = `${msg.chat}|${msg.date}|${msg.sender}`;
  if (MEDIA.test(msg.body)) burst.set(k, (burst.get(k) ?? 0) + 1);
  else if (!INVOICE_HEADER.test(msg.body)) {
    const u = findUnit(msg.body);
    if (u) { if (!named.has(k)) named.set(k, new Set()); named.get(k).add(u); }
  }
}

for (const [k, shots] of burst) {
  if (shots < SHOTS) continue;
  const [chat, date, sender] = k.split('|');
  const house = CHAT_DEFAULT.find(([re]) => re.test(chat))?.[1] ?? null;
  const saidThatDay = [...(named.get(k) ?? [])];
  // The chat's own property wins; otherwise one unambiguous mention.
  const unit = house ?? (saidThatDay.length === 1 ? saidThatDay[0] : null);
  if (!unit) continue;
  events.push({ date, unit, vendor: crewOf(sender), source: 'photo-burst',
                line: `${shots} photos, no caption`, chat });
}

// One clean per unit per day, keeping the strongest evidence for it.
const RANK = { ready: 4, photos: 3, 'photo-burst': 2, scheduled: 1 };
const best = new Map();
for (const e of events) {
  const k = `${e.date}|${e.unit}`;
  const prev = best.get(k);
  if (!prev || RANK[e.source] > RANK[prev.source]) best.set(k, e);
}
// --verified keeps only what the CREW confirmed: a unit they said was
// ready, or one they captioned a batch of finished photos with. The
// office naming the day's work is a plan — dated, usually right, but
// nobody has said it happened.
const verifiedOnly = process.argv.includes('--verified');
const cleanings = [...best.values()]
  .filter(e => !verifiedOnly || e.source !== 'scheduled')
  .sort((a, b) => a.date.localeCompare(b.date) || a.unit.localeCompare(b.unit));

// ── write: one file ─────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const esc = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head, rows) => [head, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';

// Deduplicated on unit and day above; the deep flag is read from the
// separate pass, so a clean is marked deep because somebody said so on
// that day for that unit, not because the unit has ever had one.
for (const c of cleanings) c.deep = deepDays.has(`${c.date}|${c.unit}`);

writeFileSync(join(outDir, 'cleanings.csv'), csv(
  ['Checkout', 'Unit', 'Deep', 'Cleaner', 'Source', 'Quote'],
  cleanings.map(c => [c.date, c.unit, c.deep ? 'YES' : '', c.vendor ?? '',
                      c.source, c.line.slice(0, 100)])));

// ── report ───────────────────────────────────────────────────────────
const span = cleanings.length ? `${cleanings[0].date} → ${cleanings.at(-1).date}` : '—';
const by = k => cleanings.filter(c => c.source === k).length;
const deepDated = cleanings.filter(c => c.deep).length;
const deepBilled = billed.filter(b => b.deep && !b.chore).length;

console.log(`messages read      ${messages.length}`);
console.log(`dated cleanings    ${cleanings.length}   ${span}`);
console.log(`   crew said ready ${by('ready')}`);
console.log(`   photo captions  ${by('photos')}`);
console.log(`   photo bursts    ${by('photo-burst')}`);
console.log(`   office schedule ${by('scheduled')}`);
console.log(`deep, dated        ${deepDated}`);
console.log(`deep, on invoices  ${deepBilled}   <- billed but never dated in chat: ${Math.max(0, deepBilled - deepDated)}`);
console.log(`\nwrote cleanings.csv (${cleanings.length} rows) in ${outDir}`);
console.log(`nothing is dated from an invoice: a weekly invoice cannot say which day.`);
