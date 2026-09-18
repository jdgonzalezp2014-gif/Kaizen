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
 * WHERE THE NUMBERS COME FROM
 *
 * Two different things are in these chats and they are not interchangeable:
 *
 *   the INVOICES  carry unit + price together, and are the only authority
 *                 on what a clean cost. They are weekly, so they do NOT say
 *                 which day each clean happened.
 *   the CHATTER   carries unit + date ("Napa ready", "Preston ready"), and
 *                 is the only authority on when.
 *
 * So the script builds a rate card from the invoices and applies it to the
 * dated events. Every row says which of the two it came from, and carries
 * the message it was read from so you can check it.
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

const SKIP = [
  /<Multimedia omitido>/, /Se eliminó este mensaje/, /Eliminaste este mensaje/,
  /‎?.*(añadió a|creó el grupo|cambió el nombre|te añadió)/,
  /Los mensajes y las llamadas están cifrados/, /Fijaste un mensaje/
];

const HEAD = /^(\d{1,2})\/(\d{1,2})\/(\d{2}),\s+(\d{1,2}):(\d{2})\s*([ap])\.\s?m\.\s+-\s+(.*)$/;

/** D/M/YY — Spanish export order. Day first, not month. */
function isoDate(d, m, y) {
  return `20${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Group lines into messages; a continuation line has no timestamp. */
function parseChat(text, chat) {
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

for (const msg of messages) {
  if (INVOICE_HEADER.test(msg.body)) continue;
  const lines = msg.body.split('\n');

  // (a) "Napa ready" — the CREW reporting the unit finished. Strongest.
  //
  // Only from the crew: the office writes "is 2462 ready?" and "it should
  // be ready at 4", which are a question and a plan, not a completion.
  for (const line of isCrew(msg.sender) ? lines : []) {
    if (!/\bready\b/i.test(line)) continue;
    if (/\?\s*$|\bis\s+\S+\s+ready|would like|check in/i.test(line)) continue;
    if (/\bnot ready|ready to|ready for|be ready|will be ready|when.*ready|ready\?/i.test(line)) continue;
    const m = line.match(READY);
    if (!m) continue;
    const unit = findUnit(m[1]) ?? findUnit(line);
    if (unit) events.push({ date: msg.date, unit, vendor: crewOf(msg.sender), source: 'ready', line: line.trim(), chat: msg.chat });
  }

  // (b) A bare unit name from the crew: the caption on a batch of finished
  // photos. The photos themselves are stripped, the label is the evidence.
  const only = msg.body.trim();
  if (isCrew(msg.sender) && only.length <= 24 && !/\bready\b/i.test(only)) {
    const unit = findUnit(only);
    // Guard: the whole message must BE the name, not merely contain it,
    // or "2 more" and "ok 1125?" become cleans that never happened.
    // It must BE the label, not a sentence that happens to be short. A
    // leading preposition or verb means it is a fragment — "In 4308" is
    // the tail of a sentence about a sofa, not a finished unit.
    const fragment = /^(in|at|on|for|to|the|a|is|are|and|or|no|not|so|we|i|it|this|that|just|only|also|do|does|did)\b/i;
    if (unit && /^[\w\s.'-]+$/.test(only) && only.split(/\s+/).length <= 3 && !fragment.test(only)) {
      events.push({ date: msg.date, unit, vendor: crewOf(msg.sender), source: 'photos', line: only, chat: msg.chat });
    }
  }

  // (c) The office naming the day's work. A plan, not a completion — but
  // it is dated, and almost all of them happened.
  if (!isCrew(msg.sender) && /today'?s cleaning|today we (have|only have)|remember today/i.test(msg.body)) {
    for (const line of lines) {
      const unit = findUnit(line);
      if (unit) events.push({ date: msg.date, unit, vendor: null, source: 'scheduled', line: line.trim(), chat: msg.chat });
    }
  }
}

// One clean per unit per day, keeping the strongest evidence for it.
const RANK = { ready: 3, photos: 2, scheduled: 1 };
const best = new Map();
for (const e of events) {
  const k = `${e.date}|${e.unit}`;
  const prev = best.get(k);
  if (!prev || RANK[e.source] > RANK[prev.source]) best.set(k, e);
}
const cleanings = [...best.values()]
  .sort((a, b) => a.date.localeCompare(b.date) || a.unit.localeCompare(b.unit));

// ── write ────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const esc = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head, rows) => [head, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';

// The rate card. Deep is a column of its own and is left EMPTY where the
// crew never invoiced a deep clean for that unit — that blank is the space
// to fill in, not a zero.
const keys = [...rates.keys()].sort();
writeFileSync(join(outDir, 'rates.csv'), csv(
  ['Unit', 'Cleaner', 'Regular', 'Deep', 'Regular samples', 'Regular range', 'Deep samples'],
  keys.map(k => {
    const [u, v] = k.split('||');
    const r = rates.get(k);
    const lo = Math.min(...r.regular), hi = Math.max(...r.regular);
    return [u, v, median(r.regular) ?? '', median(r.deep) ?? '', r.regular.length,
            r.regular.length ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : '', r.deep.length];
  })));

writeFileSync(join(outDir, 'cleanings.csv'), csv(
  ['Checkout', 'Unit', 'Cleaner', 'Price', 'Deep', 'Source', 'Confidence', 'Quote', 'Chat'],
  cleanings.map(c => {
    // The vendor's own rate, or nothing. A price from the other crew is
    // not this clean's price.
    const r = c.vendor ? rates.get(`${c.unit}||${c.vendor}`) : null;
    return [c.date, c.unit, c.vendor ?? '', r ? (median(r.regular) ?? '') : '', '', c.source,
            c.source === 'ready' ? 'high' : c.source === 'photos' ? 'high' : 'planned',
            c.line.slice(0, 120), c.chat];
  })));

writeFileSync(join(outDir, 'billed.csv'), csv(
  ['Invoice date', 'Unit', 'Cleaner', 'Amount', 'Deep', 'Not a clean', 'Line', 'Chat'],
  billed.map(b => [b.date, b.unit, b.vendor, b.amount, b.deep ? 'YES' : '', b.chore ? 'YES' : '', b.line, b.chat])));

writeFileSync(join(outDir, 'unresolved.txt'),
  (oddMoney.length ? oddMoney.join('\n') : '(none)') + '\n');

// ── report ───────────────────────────────────────────────────────────
const span = cleanings.length ? `${cleanings[0].date} → ${cleanings.at(-1).date}` : '—';
console.log(`messages read      ${messages.length}`);
console.log(`invoice line items ${billed.length}  (${billed.filter(b => b.deep).length} deep, ${billed.filter(b => b.chore).length} not a clean)`);
console.log(`unit x cleaner     ${keys.length} rate(s)`);
const by = k => cleanings.filter(c => c.source === k).length;
console.log(`dated cleanings    ${cleanings.length}   ${span}`);
console.log(`   crew said ready ${by('ready')}`);
console.log(`   photo captions  ${by('photos')}`);
console.log(`   office schedule ${by('scheduled')}   (planned, not confirmed)`);
console.log(`money not matched  ${oddMoney.length}  -> unresolved.txt`);
console.log(`\nwrote rates.csv, cleanings.csv, billed.csv, unresolved.txt in ${outDir}`);
