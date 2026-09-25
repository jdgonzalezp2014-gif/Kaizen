import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDay, latestNotes, parseDailySettings, parseInspectionLog, parseNotesLog } from './daily.ts';

test('dates: ISO passes through, US slashes are month-first', () => {
  assert.equal(isoDay('2026-09-14'), '2026-09-14');
  assert.equal(isoDay('9/4/2026 10:32:00'), '2026-09-04');
  assert.equal(isoDay('Sep 14'), '');
});

test('the Inspection Log banner is not mistaken for the header', () => {
  const csv = [
    '🔍 Inspection Log  ·  add a row every time a unit is inspected.,,,,',
    'Date,Unit,Inspected by,Result,Notes',
    '2026-09-10,CL1250,Owner,OK,',
    '2026-09-20,CL1250,Veronica,Minor issues,towels'
  ].join('\n');
  const log = parseInspectionLog(csv, '2026-09-24')!;
  assert.equal(log.done.length, 2);
  assert.equal(log.done[0]!.date, '2026-09-20');   // newest first
  assert.equal(log.done[0]!.by, 'Veronica');
});

test('a scheduled inspection is not a done one', () => {
  // Counting it would reset the clock and silence the reminder that
  // asked for it.
  const csv = 'Date,Unit,Inspected by,Result,Notes\n2026-09-30,CL1250,Owner,,\n2026-09-20,CL1250,Owner,,';
  const log = parseInspectionLog(csv, '2026-09-24')!;
  assert.equal(log.done.length, 0);
  assert.equal(log.scheduled.length, 2);
});

test('a tab without the expected columns is reported, not read as empty', () => {
  assert.equal(parseInspectionLog('a,b,c\n1,2,3', '2026-09-24'), null);
  assert.equal(parseNotesLog('<html>'), null);
});

test('the current note is the last one logged, including a cleared one', () => {
  const csv = [
    'Logged at,Check-in,Unit,Guest,Type,Notes,Res ID',
    '9/20/2026 10:00:00,9/25/2026,CL1250,Ann,Check-in,early arrival,111',
    '9/21/2026 09:00:00,9/25/2026,CL1250,Ann,Check-out,late checkout,111',
    '9/22/2026 12:00:00,9/25/2026,CL1250,Ann,Check-in,,111'
  ].join('\n');
  const notes = latestNotes(parseNotesLog(csv)!);
  assert.equal(notes.get('111|checkin'), '');
  assert.equal(notes.get('111|checkout'), 'late checkout');
});

test('settings: numbers, the roster with both rate cards, extra inspectors', () => {
  const csv = [
    'kind,key,value,value2,value3,label',
    'num,inspectionIntervalDays,90,,,Inspection interval (days)',
    'num,inspectionValueTrigger,1000,,,Inspection value trigger',
    'cleaner,Michelle,low,"{""1"":35,""2"":55,""3"":""""}","{}",Cleaner (low tier)',
    'inspector,Manager,,,,Extra inspector'
  ].join('\n');
  const s = parseDailySettings(csv)!;
  assert.equal(s.source, 'sheet');
  assert.equal(s.inspectionIntervalDays, 90);
  assert.equal(s.inspectionValueTrigger, 1000);
  assert.equal(s.inspectionSoonDays, 24);          // not in the sheet → default
  assert.equal(s.cleaners[0]!.name, 'Michelle');
  assert.equal(s.cleaners[0]!.rates['2'], 55);
  assert.equal(s.cleaners[0]!.rates['3'], null);   // blank is "no rate", never 0
  assert.deepEqual(s.inspectors, ['Manager']);
});
