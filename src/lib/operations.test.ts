import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assign, blockForReservation, pickByStars, requiredStars, typicalNightly, zoneOf, buildBoard, eligibleInspectors, inspectionPanel, inspectionTier,
  mergeHostNote, proposeInspections, rateFor, sameGuest, summarize, withDefaults,
  type Cleaner, type OpsCleaning, type OpsListing, type OpsReservation, type OpsRules, type Override
} from './operations.ts';

const RULES: OpsRules = withDefaults({
  cleanerHighThreshold: 250, cleanerLowThreshold: 120, longStayPromoteNights: 14,
  deepCleanNights: 20, longVacancyDays: 25, nextResValueHorizonDays: 21,
  inspectionIntervalDays: 30, inspectionSoonDays: 24, inspectionValueTrigger: 2000
});
const ROSTER: Cleaner[] = [
  { name: 'Karina and Marvin', tier: 'high', position: 0, active: true,
    rates: { 1: 70, 2: 90, 3: 150 }, deepRates: { 1: 120, 3: 230 }, stars: 5, zones: [], maxPerDay: null },
  { name: 'Veronica', tier: 'mid', position: 0, active: true, rates: { 1: 50, 2: 90 }, deepRates: {},
    stars: 3, zones: [], maxPerDay: null },
  { name: 'Michelle', tier: 'low', position: 0, active: true, rates: { 1: 35, 2: 55 }, deepRates: {},
    stars: 2, zones: [], maxPerDay: null }
];
const TODAY = '2026-09-24';
const L: OpsListing[] = [
  { id: '1', name: 'CL1250', bedrooms: 2, active: true },
  { id: '2', name: 'P2 - 1406', bedrooms: 1, active: true },
  { id: '3', name: 'Charger Luxe', bedrooms: 3, active: false }
];
const res = (id: string, listingId: string, arrival: string, departure: string, total = 500,
             nights = 3, extra: Partial<OpsReservation> = {}): OpsReservation =>
  ({ reservationId: id, listingId, arrival, departure, nights, totalPaid: total, channel: 'airbnb', ...extra });

const board = (reservations: OpsReservation[], opts: {
  overrides?: Map<string, Override>; sheet?: Map<string, OpsCleaning>; inspectionLogRead?: boolean;
  done?: { date: string; unit: string; by: string; result: string; notes: string }[];
} = {}) => buildBoard({
  today: TODAY, windowDays: 10, listings: L, reservations, roster: ROSTER, rules: RULES,
  overrides: opts.overrides ?? new Map(), notes: new Map(),
  inspections: inspectionPanel(L, reservations, opts.done ?? [], [], TODAY, RULES),
  sheet: opts.sheet, inspectionLogRead: opts.inspectionLogRead
});
const out = (rows: ReturnType<typeof board>, resId: string) => rows.find(r => r.kind === 'out' && r.resId === resId)!;

/* ── the tier rule ── */

test('next booking at or above the high line goes to the high tier', () => {
  const r = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 300)]);
  assert.equal(out(r, 'a').cleaner, 'Karina and Marvin');
  assert.equal(out(r, 'a').price, 90);
});

test('a cheap next booking goes to the low tier', () => {
  const r = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 100)]);
  assert.equal(out(r, 'a').cleaner, 'Michelle');
  assert.equal(out(r, 'a').price, 55);
});

test('nothing booked, or booked past the horizon, is the mid tier', () => {
  const r = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '2', '2026-09-20', '2026-09-26'),
                   res('c', '2', '2026-11-20', '2026-11-25', 9000)]);
  assert.equal(out(r, 'a').cleaner, 'Veronica');
  assert.equal(out(r, 'b').cleaner, 'Veronica');
  assert.equal(out(r, 'b').next?.total, null);      // no value past the horizon…
  assert.equal(out(r, 'b').next?.gapDays, 55);      // …but the gap stays factual
  assert.equal(out(r, 'b').next?.longVacancy, true);
});

test('a long stay is promoted to the high tier whatever comes next', () => {
  const a = assign(14, null, ROSTER, RULES);
  assert.equal(a.cleaner, 'Karina and Marvin');
  assert.match(a.reason, /long-stay/);
});

test('an empty tier leaves the clean unassigned rather than picking someone else', () => {
  const r = buildBoard({ today: TODAY, windowDays: 10, listings: L, roster: ROSTER.filter(c => c.tier !== 'mid'),
    rules: RULES, reservations: [res('a', '1', '2026-09-20', '2026-09-26')], overrides: new Map(),
    notes: new Map(), inspections: [] });
  assert.equal(r[0]!.assignment, 'tbd');
  assert.match(r[0]!.auto.reason, /nobody is in the mid tier/);
});

/* ── pay ── */

test('deep reads the deep card and falls back to the ordinary rate for a blank size', () => {
  assert.equal(rateFor(ROSTER, 'Karina and Marvin', 3, true), 230);
  assert.equal(rateFor(ROSTER, 'Karina and Marvin', 2, true), 90);
  assert.equal(rateFor(ROSTER, 'Karina and Marvin', 2, false), 90);
});

test('no rate is null, never zero', () => {
  assert.equal(rateFor(ROSTER, 'Michelle', 4, false), null);
  assert.equal(rateFor(ROSTER, 'Nobody', 1, false), null);
  assert.equal(rateFor(ROSTER, 'Michelle', null, false), null);
});

test('a stay of the deep-clean length is flagged deep and priced off the deep card', () => {
  const r = board([res('a', '1', '2026-09-01', '2026-09-26', 3000, 25)]);
  assert.equal(out(r, 'a').deep, true);
  assert.equal(out(r, 'a').cleaner, 'Karina and Marvin');   // long-stay promotion
  assert.equal(out(r, 'a').price, 90);                      // no 2BR deep rate → ordinary
});

/* ── overrides ── */

test('a person\'s choice beats the rule, and the row says so', () => {
  const ov = new Map<string, Override>([['a', { assignment: 'assigned', cleaner: 'Michelle', deep: true,
    checkoutTime: '11:30 AM', checkinTime: null }]]);
  const o = out(board([res('a', '1', '2026-09-20', '2026-09-26')], { overrides: ov }), 'a');
  assert.equal(o.cleaner, 'Michelle');
  assert.equal(o.auto.cleaner, 'Veronica');
  assert.deepEqual(o.manual, { cleaner: true, deep: true, time: true });
  assert.equal(o.time, '11:30 AM');
});

test('"not needed" is not a clean and carries no pay', () => {
  const ov = new Map<string, Override>([['a', { assignment: 'not_needed', cleaner: null, deep: null,
    checkoutTime: null, checkinTime: null }]]);
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26')], { overrides: ov });
  assert.equal(out(rows, 'a').price, null);
  assert.equal(summarize(rows).cleanings, 0);
});

test('an explicit NO on deep survives a stay long enough to be deep', () => {
  const ov = new Map<string, Override>([['a', { assignment: null, cleaner: null, deep: false,
    checkoutTime: null, checkinTime: null }]]);
  assert.equal(out(board([res('a', '1', '2026-09-01', '2026-09-26', 3000, 25)], { overrides: ov }), 'a').deep, false);
});

/* ── urgency ── */

test('same-day turnover, and the same guest booking again is not one', () => {
  const g = { guestName: 'Ann Lee', phone: '+1 (214) 555-0101' };
  const r = board([
    res('a', '1', '2026-09-20', '2026-09-26', 500, 3, g), res('b', '1', '2026-09-26', '2026-09-29', 500, 3, g),
    res('c', '2', '2026-09-20', '2026-09-26'), res('d', '2', '2026-09-26', '2026-09-29')
  ]);
  assert.equal(out(r, 'a').urgency, 'same_guest');
  assert.equal(out(r, 'c').urgency, 'turnover');
  assert.equal(summarize(r).turnovers, 1);
});

test('a name alone is not the same guest — the phone has to match too', () => {
  assert.equal(sameGuest(res('a', '1', '', '', 0, 1, { guestName: 'Ann' }),
                         res('b', '1', '', '', 0, 1, { guestName: 'Ann' })), false);
});

/* ── shadow mode ── */

test('shadow mode names the fields where the sheet decided differently', () => {
  const sheet = new Map<string, OpsCleaning>([['a', { cleaner: 'Michelle', assignment: 'assigned', price: 55,
    deep: false, urgency: null, checkoutTime: '10:00 AM', beds: 2 }]]);
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26'), res('z', '2', '2026-09-20', '2026-09-26')], { sheet });
  assert.deepEqual(out(rows, 'a').differs, ['cleaner', 'price']);
  assert.equal(out(rows, 'z').inDailyFile, false);
  assert.equal(summarize(rows).differing, 1);
});

/* ── inspections ── */

test('tiers: never, overdue at the interval, soon at the warning line', () => {
  assert.equal(inspectionTier(null, RULES), 'never');
  assert.equal(inspectionTier(30, RULES), 'overdue');
  assert.equal(inspectionTier(24, RULES), 'soon');
  assert.equal(inspectionTier(23, RULES), 'ok');
});

test('the monthly flag lands on the first turnover only', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-25'), res('b', '1', '2026-09-25', '2026-09-28'),
                      res('c', '1', '2026-09-28', '2026-10-10')]);
  assert.deepEqual(rows.filter(r => r.kind === 'out').map(r => r.inspection.key), ['due', 'none']);
});

test('a big next booking forces an inspection; one logged after the checkout closes it', () => {
  const big = [res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-10-05', 2400)];
  assert.equal(out(board(big, { done: [{ date: '2026-09-20', unit: 'CL1250', by: 'Owner', result: 'OK', notes: '' }] }), 'a')
    .inspection.key, 'req');
  const panel = inspectionPanel(L, [], [{ date: '2026-09-26', unit: 'CL1250', by: 'Owner', result: 'OK', notes: '' }], [], '2026-09-26', RULES);
  const rows = buildBoard({ today: '2026-09-26', windowDays: 10, listings: L, roster: ROSTER, rules: RULES,
    reservations: [res('a', '1', '2026-09-20', '2026-09-26')], overrides: new Map(), notes: new Map(), inspections: panel });
  assert.equal(rows[0]!.inspection.key, 'ok');
});

test('without inspection history nothing is called overdue — a big booking still is', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-10-05', 2400),
                      res('c', '2', '2026-09-20', '2026-09-26')], { inspectionLogRead: false });
  assert.equal(out(rows, 'a').inspection.key, 'req');
  assert.equal(out(rows, 'c').inspection.key, 'none');
});

test('the inspector is never the person who cleaned', () => {
  const who = eligibleInspectors(ROSTER, ['Carlos'], 'Veronica');
  assert.ok(!who.includes('Veronica'));
  assert.ok(who.includes('Manager') && who.includes('Carlos'));
});

test('auto-schedule books each due unit once, at its next checkout, and skips units already booked', () => {
  const reservations = [res('a', '1', '2026-09-20', '2026-09-26'), res('b', '2', '2026-09-20', '2026-09-28')];
  const panel = inspectionPanel(L, reservations, [], [{ date: '2026-09-28', unit: 'P2-1406', by: '', result: '', notes: '' }], TODAY, RULES);
  const p = proposeInspections(panel, reservations, TODAY, RULES);
  assert.deepEqual(p.map(x => [x.unit, x.date]), [['CL1250', '2026-09-26']]);
});

/* ── the Host Note ── */

test('our lines replace our lines and nothing a person typed', () => {
  const existing = 'Door code 4411\n\nCheck-out 10:00 AM · Cleaner: Veronica\nParking spot 3';
  const merged = mergeHostNote(existing, 'Check-out 11:00 AM · Cleaner: Michelle');
  assert.equal(merged, 'Door code 4411\n\nCheck-out 11:00 AM · Cleaner: Michelle\nParking spot 3');
});

test('a note the sheet wrote in the old bracketed form is cleaned up, not duplicated', () => {
  const merged = mergeHostNote('⟦ KAIZEN ⟧\nold\n⟦/KAIZEN⟧\nVIP guest', 'Check-out 10:00 AM · Cleaner: Veronica');
  assert.equal(merged, 'VIP guest\n\nCheck-out 10:00 AM · Cleaner: Veronica');
});

test('a note never shares a line with the cleaner\'s name, and a wrapped note becomes one line', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26')]);
  out(rows, 'a').note = 'guest wants\nto extend';
  assert.equal(blockForReservation(rows, 'a'),
    'Check-out 10:00 AM · Cleaner: Veronica\nCheck-out note: guest wants to extend');
});

test('the panel matches loosely by name and leaves archived units out', () => {
  const panel = inspectionPanel(L, [], [{ date: '2026-09-01', unit: 'p2-1406', by: 'Owner', result: 'OK', notes: '' }], [], TODAY, RULES);
  assert.equal(panel.length, 2);
  assert.equal(panel.find(p => p.unitId === '2')!.tier, 'ok');
  assert.equal(panel[0]!.tier, 'never');
});

test('stored rules over defaults: a blank never reads as zero', () => {
  const r = withDefaults({ cleanerHighThreshold: '', inspectionIntervalDays: 90 });
  assert.equal(r.cleanerHighThreshold, 1500);
  assert.equal(r.inspectionIntervalDays, 90);
});

/* ── one clean per unit per day ── */

test('an iCal block inside a real stay, ending the same day, is not a second clean', () => {
  // Kingsford Home, 22 Sep: recorded as $200 + $350 for one checkout.
  const rows = board([
    res('stay', '1', '2026-08-22', '2026-09-26', 14700, 35),
    res('block', '1', '2026-09-20', '2026-09-26', 0, 6, { channel: 'customIcal' })
  ]);
  assert.equal(out(rows, 'stay').assignment, 'assigned');
  assert.equal(out(rows, 'block').assignment, 'not_needed');
  assert.equal(out(rows, 'block').sameDayOf, 'stay');
  assert.equal(out(rows, 'block').price, null);
  assert.equal(summarize(rows).cleanings, 1);
});

test('two real stays leaving the same unit the same day are one clean, owned by the bigger one', () => {
  const rows = board([res('small', '1', '2026-09-23', '2026-09-26', 300, 3), res('big', '1', '2026-09-20', '2026-09-26', 900, 6)]);
  assert.equal(out(rows, 'big').assignment, 'assigned');
  assert.equal(out(rows, 'small').sameDayOf, 'big');
});

test('a person who assigned the second departure keeps that choice', () => {
  const ov = new Map<string, Override>([['small', { assignment: 'assigned', cleaner: 'Michelle', deep: null, checkoutTime: null, checkinTime: null }]]);
  const rows = board([res('small', '1', '2026-09-23', '2026-09-26', 300, 3), res('big', '1', '2026-09-20', '2026-09-26', 900, 6)], { overrides: ov });
  assert.equal(out(rows, 'small').cleaner, 'Michelle');
  assert.equal(out(rows, 'small').sameDayOf, 'big');
});

/* ── stars (§121) ── */

const boardBy = (reservations: OpsReservation[], opts: {
  roster?: Cleaner[]; overrides?: Map<string, Override>; assignRule?: 'tiers' | 'stars';
} = {}) => buildBoard({
  today: TODAY, windowDays: 10, listings: L, reservations, roster: opts.roster ?? ROSTER, rules: RULES,
  overrides: opts.overrides ?? new Map(), notes: new Map(), inspections: [], assignRule: opts.assignRule ?? 'stars'
});
const withRoster = (patch: Record<string, Partial<Cleaner>>) => ROSTER.map(c => ({ ...c, ...(patch[c.name] ?? {}) }));

test('a unit\'s zone is its building, or Houses', () => {
  assert.equal(zoneOf('CL1250'), 'CL');
  assert.equal(zoneOf('CL 1125'), 'CL');
  assert.equal(zoneOf('P2-1201'), 'P2');
  assert.equal(zoneOf('P2 - 1406'), 'P2');
  assert.equal(zoneOf('Amber Valley'), 'Houses');
  assert.equal(zoneOf('Kingsford Duplicate'), 'Houses');
});

test('required stars: nightly band, plus the stay, plus a same-day turnover, capped at five', () => {
  assert.equal(requiredStars(99, null, 3, false, RULES).stars, 1);
  assert.equal(requiredStars(100, null, 3, false, RULES).stars, 2);
  assert.equal(requiredStars(180, null, 3, false, RULES).stars, 3);
  assert.equal(requiredStars(180, null, 8, false, RULES).stars, 4);
  assert.equal(requiredStars(180, null, 8, true, RULES).stars, 5);
  assert.equal(requiredStars(120, null, 20, false, RULES).stars, 4);
  const capped = requiredStars(300, null, 25, true, RULES);
  assert.equal(capped.stars, 5);
  assert.match(capped.why, /capped/);
  assert.match(requiredStars(null, 133, 3, false, RULES).why, /usual \$133\/night ★2/);
  assert.equal(requiredStars(null, null, 3, false, RULES).stars, RULES.starDefault);
});

test('stars go by the price per night, not the total — ten cheap nights do not outrank two dear ones', () => {
  const r = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-10-07', 900, 10),
                     res('c', '2', '2026-09-20', '2026-09-26'), res('d', '2', '2026-09-27', '2026-09-29', 600, 2)]);
  assert.equal(out(r, 'a').stars?.required, 1);
  assert.equal(out(r, 'c').stars?.required, 5);
});

test('the cheapest cleaner with enough stars is picked', () => {
  const two = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 300)]);
  assert.equal(out(two, 'a').stars?.required, 2);
  assert.equal(out(two, 'a').cleaner, 'Michelle');
  assert.equal(out(two, 'a').price, 55);
  assert.match(out(two, 'a').auto.reason, /★2 needed.*Michelle ★2 is the cheapest of 3/);
  const four = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 600)]);
  assert.equal(out(four, 'a').cleaner, 'Karina and Marvin');
});

test('a same-day turnover needs one star more', () => {
  const r = boardBy([res('a', '2', '2026-09-20', '2026-09-26'), res('b', '2', '2026-09-26', '2026-09-29', 300)]);
  assert.equal(out(r, 'a').stars?.required, 3);
  assert.equal(out(r, 'a').cleaner, 'Veronica');
});

test('nobody with enough stars: the most stars available, flagged below', () => {
  const p = pickByStars(4, 'CL', 2, false, ROSTER.filter(c => c.name === 'Michelle'), new Map());
  assert.equal(p.cleaner, 'Michelle');
  assert.equal(p.below, true);
  assert.match(p.reason, /nobody free in CL has ★4/);
});

test('a cleaner only cleans the zones she covers; nobody covering leaves it unassigned', () => {
  const roster = withRoster({ Michelle: { zones: ['P2'] } });
  assert.equal(pickByStars(2, 'CL', 1, false, roster, new Map()).cleaner, 'Veronica');
  assert.equal(pickByStars(2, 'P2', 1, false, roster, new Map()).cleaner, 'Michelle');
  const none = pickByStars(2, 'Houses', 2, false, ROSTER.map(c => ({ ...c, zones: ['CL'] })), new Map());
  assert.equal(none.cleaner, null);
  assert.match(none.reason, /nobody covers Houses/);
});

test('equal cost goes to whoever has fewer cleans that day, then to more stars', () => {
  assert.equal(pickByStars(3, 'CL', 2, false, ROSTER, new Map()).cleaner, 'Karina and Marvin');   // both $90
  const roster = withRoster({ Veronica: { stars: 5 } });     // Veronica and K&M both pay $90 for a 2BR
  assert.equal(pickByStars(4, 'CL', 2, false, roster, new Map([['Karina and Marvin', 1]])).cleaner, 'Veronica');
  assert.equal(pickByStars(4, 'CL', 2, false, roster, new Map([['Veronica', 1]])).cleaner, 'Karina and Marvin');
});

test('the daily max: a full cleaner is passed over, and the most demanding clean is served first', () => {
  const full = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 300),
                        res('c', '2', '2026-09-20', '2026-09-26'), res('d', '2', '2026-09-27', '2026-09-30', 300)],
                       { roster: withRoster({ Michelle: { maxPerDay: 1 } }) });
  assert.deepEqual([out(full, 'a').cleaner, out(full, 'c').cleaner], ['Michelle', 'Veronica']);

  // K&M can do one. The ★5 clean in P2 gets her, though CL1250 comes first on the board.
  const roster = withRoster({ 'Karina and Marvin': { maxPerDay: 1 }, Michelle: { active: false } });
  const r = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 300),
                     res('c', '2', '2026-09-20', '2026-09-26'), res('d', '2', '2026-09-27', '2026-09-30', 900)], { roster });
  assert.equal(out(r, 'c').stars?.required, 5);
  assert.equal(out(r, 'c').cleaner, 'Karina and Marvin');
  assert.equal(out(r, 'a').cleaner, 'Veronica');
});

test('a person\'s choice wins and takes its slot that day', () => {
  const ov = new Map<string, Override>([['a', { assignment: 'assigned', cleaner: 'Michelle', deep: null, checkoutTime: null, checkinTime: null }]]);
  const r = boardBy([res('a', '1', '2026-09-20', '2026-09-26'),
                     res('c', '2', '2026-09-20', '2026-09-26'), res('d', '2', '2026-09-27', '2026-09-30', 300)],
                    { roster: withRoster({ Michelle: { maxPerDay: 1 } }), overrides: ov });
  assert.equal(out(r, 'a').cleaner, 'Michelle');
  assert.equal(out(r, 'c').stars?.cleaner, 'Veronica');
  assert.equal(out(r, 'c').cleaner, 'Veronica');
});

test('nothing booked inside the horizon: the unit\'s usual nightly price sets the stars', () => {
  const r = boardBy([res('a', '2', '2026-09-23', '2026-09-26', 500, 3), res('c', '2', '2026-11-20', '2026-11-25', 500, 5)]);
  assert.equal(out(r, 'a').next?.nightly, null);
  assert.match(out(r, 'a').stars!.why, /usual \$133\/night/);
  assert.equal(out(r, 'a').stars?.required, 2);
});

test('an iCal block next is not a guest price; it is left out of the usual price too', () => {
  const stays = [res('a', '1', '2026-09-20', '2026-09-26', 600, 6), res('b', '1', '2026-09-27', '2026-09-30', 0, 3, { channel: 'ical' })];
  assert.equal(typicalNightly(stays).get('1'), 100);
  const r = boardBy(stays);
  assert.equal(out(r, 'a').next?.nightly, null);
  assert.equal(out(r, 'a').stars?.required, 2);
});

test('under the tiers the star answer rides along, deciding nothing', () => {
  const r = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 300)],
                    { assignRule: 'tiers' });
  assert.equal(out(r, 'a').cleaner, 'Karina and Marvin');   // $300 next ≥ the $250 high line
  assert.equal(out(r, 'a').stars?.cleaner, 'Michelle');     // $100/night is ★2
  assert.equal(summarize(r, ROSTER).belowStars, 0);
});

test('below stars is counted, by hand or not', () => {
  const ov = new Map<string, Override>([['a', { assignment: 'assigned', cleaner: 'Michelle', deep: null, checkoutTime: null, checkinTime: null }]]);
  const r = boardBy([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30', 900)], { overrides: ov });
  assert.equal(out(r, 'a').stars?.required, 5);
  assert.equal(summarize(r, ROSTER).belowStars, 1);
});

test('the second departure the same day carries no clean and no stars', () => {
  const rows = boardBy([res('small', '1', '2026-09-23', '2026-09-26', 300, 3), res('big', '1', '2026-09-20', '2026-09-26', 900, 6)]);
  assert.equal(out(rows, 'small').stars, null);
  assert.equal(out(rows, 'small').assignment, 'not_needed');
  assert.ok(out(rows, 'big').stars);
});

test('a cleaner who declined a clean is not handed it back by the rule (§122)', () => {
  const stays = [res('a', '2', '2026-09-20', '2026-09-26'), res('b', '2', '2026-09-27', '2026-09-30', 300)];
  assert.equal(out(boardBy(stays), 'a').cleaner, 'Michelle');
  const r = buildBoard({ today: TODAY, windowDays: 10, listings: L, reservations: stays, roster: ROSTER, rules: RULES,
    overrides: new Map(), notes: new Map(), inspections: [], assignRule: 'stars',
    declines: new Map([['a', [{ cleaner: 'Michelle', reason: 'sick' }]]]) });
  assert.equal(out(r, 'a').cleaner, 'Veronica');
  assert.deepEqual(out(r, 'a').declined, [{ cleaner: 'Michelle', reason: 'sick' }]);
});
