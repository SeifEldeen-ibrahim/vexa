/** L2 — the checklist rules. Pure in, pure out: no network, no clock, no redis.
 *  What is proved here is what makes the ticks trustworthy, so each case names the
 *  user-visible failure it prevents. */
import assert from 'node:assert/strict';
import {
  agendaProgress, buildAgenda, buildCoveragePrompt, mergeMarks, parseAgenda,
  parseCoverageReply, promptItems, MAX_ITEMS,
} from './agenda.js';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('agenda.test.ts');

// ── buildAgenda ────────────────────────────────────────────────────────────────────────────
test('a textarea becomes a checklist: blanks dropped, bullets stripped, ids positional', () => {
  const a = buildAgenda('- Confirm the budget\n\n  * Agree the timeline\n1. Pick an owner\n');
  assert.deepEqual(a.items.map((i) => [i.id, i.text, i.status]), [
    ['a1', 'Confirm the budget', 'open'],
    ['a2', 'Agree the timeline', 'open'],
    ['a3', 'Pick an owner', 'open'],
  ]);
  assert.equal(a.version, 0);
});

test('a bare number is not a bullet — "2026 budget review" keeps its year', () => {
  assert.equal(buildAgenda(['2026 budget review']).items[0].text, '2026 budget review');
});

test('the same line twice is a typo, not two items', () => {
  assert.equal(buildAgenda(['Pricing', 'pricing', 'Pricing ']).items.length, 1);
});

test('a pasted wall of lines is capped rather than accepted', () => {
  const a = buildAgenda(Array.from({ length: MAX_ITEMS + 25 }, (_, i) => `item ${i}`));
  assert.equal(a.items.length, MAX_ITEMS);
});

// ── mergeMarks: the monotonicity promise ───────────────────────────────────────────────────
test('a mark with evidence raises the item and stamps when we got to it', () => {
  const a = buildAgenda(['Confirm the budget']);
  const { agenda, changed } = mergeMarks(a, [{ id: 'a1', status: 'touched', evidence: 'about the budget' }], 5000);
  assert.equal(changed, true);
  assert.equal(agenda.items[0].status, 'touched');
  assert.equal(agenda.items[0].evidence, 'about the budget');
  assert.equal(agenda.items[0].firstTouchedMs, 5000);
  assert.equal(agenda.items[0].coveredMs, undefined);
  assert.equal(agenda.version, 1);
});

test('covered stamps coveredMs but never moves the first-touch time', () => {
  const first = mergeMarks(buildAgenda(['Budget']), [{ id: 'a1', status: 'touched', evidence: 'x' }], 1000).agenda;
  const second = mergeMarks(first, [{ id: 'a1', status: 'covered', evidence: 'we agreed 40k' }], 9000).agenda;
  assert.equal(second.items[0].status, 'covered');
  assert.equal(second.items[0].firstTouchedMs, 1000);
  assert.equal(second.items[0].coveredMs, 9000);
});

test('a tick NEVER un-ticks: a later window reporting a lower status is ignored', () => {
  const covered = mergeMarks(buildAgenda(['Budget']), [{ id: 'a1', status: 'covered', evidence: 'agreed' }], 10).agenda;
  const after = mergeMarks(covered, [{ id: 'a1', status: 'touched', evidence: 'mentioned again' }], 999);
  assert.equal(after.changed, false);
  assert.equal(after.agenda.items[0].status, 'covered');
  assert.equal(after.agenda.items[0].evidence, 'agreed');
  assert.equal(after.agenda.version, covered.version, 'an unchanged agenda must not bump the version');
});

test('a tick with no evidence is refused — an unverifiable tick is worse than none', () => {
  const r = mergeMarks(buildAgenda(['Budget']), [{ id: 'a1', status: 'covered' }], 10);
  assert.equal(r.changed, false);
  assert.equal(r.agenda.items[0].status, 'open');
});

test('the model may not invent checklist lines', () => {
  const r = mergeMarks(buildAgenda(['Budget']), [{ id: 'a7', status: 'covered', evidence: 'sure' }], 10);
  assert.equal(r.changed, false);
  assert.equal(r.agenda.items.length, 1);
});

test('merging returns a new agenda and leaves the caller\'s copy alone', () => {
  const before = buildAgenda(['Budget']);
  const after = mergeMarks(before, [{ id: 'a1', status: 'covered', evidence: 'agreed' }], 10).agenda;
  assert.equal(before.items[0].status, 'open');
  assert.equal(after.items[0].status, 'covered');
});

// ── the prompt ─────────────────────────────────────────────────────────────────────────────
test('covered lines leave the prompt — they can never move again', () => {
  const a = mergeMarks(buildAgenda(['Budget', 'Timeline']), [{ id: 'a1', status: 'covered', evidence: 'agreed' }], 10).agenda;
  assert.equal(promptItems(a), '[a2] (open) Timeline');
});

test('no open items, or no speech, means no LLM call at all', () => {
  const a = mergeMarks(buildAgenda(['Budget']), [{ id: 'a1', status: 'covered', evidence: 'agreed' }], 10).agenda;
  assert.equal(buildCoveragePrompt(a, 'anything at all'), null);
  assert.equal(buildCoveragePrompt(buildAgenda(['Budget']), '   '), null);
});

test('the prompt carries the open items and the transcript', () => {
  const p = buildCoveragePrompt(buildAgenda(['Confirm the budget']), 'so about that budget, forty thousand');
  assert.ok(p && p.includes('[a1] (open) Confirm the budget'));
  assert.ok(p.includes('forty thousand'));
});

// ── parseCoverageReply ─────────────────────────────────────────────────────────────────────
test('plain JSON parses', () => {
  const m = parseCoverageReply('{"marks":[{"id":"a1","status":"covered","evidence":"we agreed 40k"}]}');
  assert.deepEqual(m, [{ id: 'a1', status: 'covered', evidence: 'we agreed 40k' }]);
});

test('a fenced or chatty reply still parses', () => {
  const m = parseCoverageReply('Here you go:\n```json\n{"marks":[{"id":"a2","status":"touched","evidence":"q"}]}\n```');
  assert.deepEqual(m, [{ id: 'a2', status: 'touched', evidence: 'q' }]);
});

test('garbage means nothing moved, never a crash', () => {
  for (const bad of ['', null, undefined, 'no', '{', '{"marks":"soon"}', '{"marks":[{"id":"","status":"covered"}]}']) {
    assert.deepEqual(parseCoverageReply(bad as string), []);
  }
});

test('an invented status is dropped, not coerced', () => {
  assert.deepEqual(parseCoverageReply('{"marks":[{"id":"a1","status":"done","evidence":"x"}]}'), []);
});

// ── round-trip + progress ──────────────────────────────────────────────────────────────────
test('an agenda survives the trip through redis JSON', () => {
  const a = mergeMarks(buildAgenda(['Budget', 'Timeline']), [{ id: 'a1', status: 'covered', evidence: 'agreed' }], 42).agenda;
  const back = parseAgenda(JSON.parse(JSON.stringify(a)));
  assert.deepEqual(back, a);
});

test('junk from the store degrades to an empty agenda, not a throw', () => {
  assert.deepEqual(parseAgenda(null), { items: [], version: 0 });
  assert.deepEqual(parseAgenda({ items: [{ id: 'a1' }, null, 7], version: -3 }), { items: [], version: 0 });
});

test('progress counts what the header shows', () => {
  let a = buildAgenda(['One', 'Two', 'Three']);
  a = mergeMarks(a, [{ id: 'a1', status: 'covered', evidence: 'e' }, { id: 'a2', status: 'touched', evidence: 'e' }], 1).agenda;
  assert.deepEqual(agendaProgress(a), { covered: 1, touched: 1, open: 1, total: 3 });
});

console.log(`\n${passed} passed`);
