import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keysUnder, sectionPath, sectionTree, type SopSection, cleanSteps, contentChanged, coverage, FEATURES, featureOf, forFeature, inline, matchesSearch, parseBody,
         reviewDueOn, reviewOverdue, type Sop } from './sops.ts';

const s = (over: Partial<Sop> = {}): Sop => ({
  id: '1', sectionKey: 'guest', kind: 'sop', title: 'Check-in readiness', status: 'published', purpose: null, trigger: null,
  owner: null, doneWhen: null, steps: [], body: null, features: [], reviewDays: 180, reviewedAt: null, reviewedBy: null,
  version: 1, createdBy: null, createdAt: '2026-01-01T00:00:00Z', updatedBy: null, updatedAt: '2026-01-01T00:00:00Z', ...over
});

test('the screen someone is on, as a feature', () => {
  assert.equal(featureOf('operations', 'todos'), 'operations.todos');
  assert.equal(featureOf('operations'), 'operations.board');
  assert.equal(featureOf('claims'), 'claims');
  assert.equal(featureOf('sops'), null);
  // Every feature's default section is one the migration seeds.
  const seeded = ['guest', 'compliance', 'turnover', 'inspections', 'maintenance', 'claims', 'revenue', 'finance', 'systems', 'team'];
  for (const f of FEATURES) assert.ok(seeded.includes(f.section), f.key);
});

test('review: due from the last review, or the last edit; only when published', () => {
  assert.equal(reviewDueOn(s({ reviewedAt: '2026-03-01T00:00:00Z', reviewDays: 30 })), '2026-03-31');
  assert.equal(reviewDueOn(s({ reviewDays: 90 })), '2026-04-01');
  assert.equal(reviewDueOn(s({ status: 'draft' })), null);
  assert.equal(reviewOverdue(s({ reviewDays: 90 }), '2026-04-02'), true);
  assert.equal(reviewOverdue(s({ reviewDays: 90 }), '2026-04-01'), false);
});

test('coverage counts published SOPs only', () => {
  const c = coverage([s({ features: ['claims', 'home'] }), s({ status: 'draft', features: ['costs'] })]);
  assert.equal(c.covered, 2);
  assert.equal(c.total, FEATURES.length);
  assert.ok(c.gaps.some(g => g.key === 'costs'));
  assert.ok(!c.gaps.some(g => g.key === 'claims'));
});

test('a screen lists its published SOPs first, then articles; drafts only when asked', () => {
  const list = [s({ id: 'a', kind: 'article', title: 'A', features: ['claims'] }), s({ id: 'b', title: 'Z', features: ['claims'] }),
                s({ id: 'c', status: 'draft', title: 'D', features: ['claims'] }), s({ id: 'd', features: ['home'] })];
  assert.deepEqual(forFeature(list, 'claims').map(x => x.id), ['b', 'a']);
  assert.deepEqual(forFeature(list, 'claims', true).map(x => x.id), ['c', 'b', 'a']);
});

test('search: every word, anywhere, including steps', () => {
  const x = s({ purpose: 'Every guest signs', steps: [{ text: 'Upload the ID to Drive', who: 'Ops', detail: 'From the lockbox photo' }] });
  assert.ok(matchesSearch(x, 'lockbox'));
  assert.ok(matchesSearch(x, 'drive guest'));
  assert.ok(matchesSearch(x, 'ops'));
  assert.ok(!matchesSearch(x, 'drive refund'));
  assert.ok(matchesSearch(x, '  '));
});

test('a new version only when what it says changed', () => {
  const a = s({ steps: [{ text: 'One' }] });
  assert.equal(contentChanged(a, { ...a, steps: [{ text: ' One ', who: '' }] }), false);
  assert.equal(contentChanged(a, { ...a, title: 'Other' }), true);
  assert.equal(contentChanged(a, { ...a, steps: [{ text: 'One', who: 'Ops' }] }), true);
  // A step's detail is content too: a new version when it changes.
  assert.equal(contentChanged(a, { ...a, steps: [{ text: 'One', detail: 'Use the blue key' }] }), true);
});

test('steps as typed: blanks dropped, who only when given', () => {
  assert.deepEqual(cleanSteps([{ text: ' a ', who: ' ' }, { text: '' }, { text: 'b', who: 'Ops', detail: ' How:\n- x ' }, null]),
                   [{ text: 'a' }, { text: 'b', who: 'Ops', detail: 'How:\n- x' }]);
  assert.deepEqual(cleanSteps('x'), []);
});

test('the body: headings, lists, paragraphs, bold and links — never HTML', () => {
  const b = parseBody('## When\nLine one\nline two\n\n- a\n- **b**\n1. first\n2) second\n\n<script>x</script>');
  assert.deepEqual(b.map(x => x.t), ['h', 'p', 'ul', 'ol', 'p']);
  assert.deepEqual(b[1], { t: 'p', v: [{ t: 'text', v: 'Line one line two' }] });
  assert.equal((b[2] as { items: unknown[] }).items.length, 2);
  assert.deepEqual(b[4], { t: 'p', v: [{ t: 'text', v: '<script>x</script>' }] });
  assert.deepEqual(inline('See https://example.com/a. Then **go**'), [
    { t: 'text', v: 'See ' }, { t: 'link', v: 'https://example.com/a', href: 'https://example.com/a' },
    { t: 'text', v: '. Then ' }, { t: 'bold', v: 'go' }]);
  assert.deepEqual(inline('http://not-https.com'), [{ t: 'text', v: 'http://not-https.com' }]);
});

test('subsections: one level, named with their section, counted with it', () => {
  const secs: SopSection[] = [
    { key: 'guest', label: 'Guest lifecycle', description: null, sort: 10 },
    { key: 'claims', label: 'Claims', description: null, sort: 20 },
    { key: 'checkin', label: 'Check-in', description: null, sort: 30, parentKey: 'guest' },
    { key: 'orphan', label: 'Orphan', description: null, sort: 40, parentKey: 'gone' }
  ];
  assert.deepEqual(sectionTree(secs).map(t => [t.section.key, t.children.map(c => c.key)]),
                   [['guest', ['checkin']], ['claims', []], ['orphan', []]]);
  assert.equal(sectionPath(secs, 'checkin'), 'Guest lifecycle › Check-in');
  assert.equal(sectionPath(secs, 'claims'), 'Claims');
  assert.deepEqual(keysUnder(secs, 'guest'), ['guest', 'checkin']);
});
