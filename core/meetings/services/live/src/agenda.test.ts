/** L2 — the checklist rules. Pure in, pure out: no network, no clock, no redis.
 *  What is proved here is what makes the ticks trustworthy, so each case names the
 *  user-visible failure it prevents. */
import assert from 'node:assert/strict';
import {
  agendaProgress, buildAgenda, buildCoveragePrompt, buildReviewPrompt, mergeMarks, parseAgenda,
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

// ── one remark covers one line ─────────────────────────────────────────────────────────────
/** THE 9-OF-11 BUG, the mirror of the 0-of-11 one below. A colleague ran a sales 1:1 and the
 *  panel said 9 of 11 covered after a dozen sentences. The transcript had not covered nine
 *  points; one sentence about two slipped deals had been offered as the evidence for four of
 *  them, and a pipeline figure for three more. Capping the repeats took that call from 9 covered
 *  to 5 (hand label: 3) and the full meeting from 11 to 10 (hand label: 8) — eval/README.md has
 *  both runs. */
test('the same remark cannot cover a second line — it is capped at started', () => {
  const a = buildAgenda(['Missed opportunities', 'Progress on deals', 'Blockers']);
  const quote = 'Two big deals slipped, one pushed to next month';
  const r = mergeMarks(a, [
    { id: 'a1', status: 'covered', evidence: quote },
    { id: 'a2', status: 'covered', evidence: quote },
    { id: 'a3', status: 'covered', evidence: quote },
  ], 1000).agenda;
  assert.deepEqual(r.items.map((i) => i.status), ['covered', 'touched', 'touched']);
  // Capped, not dropped: the topic really did come up, and the quote stays so the user can judge.
  assert.equal(r.items[1].evidence, quote);
});

test('a remark re-clipped by a later pass is still the same remark', () => {
  const first = mergeMarks(buildAgenda(['Missed opportunities', 'Blockers']),
    [{ id: 'a1', status: 'covered', evidence: 'Two big deals slipped, one pushed to next month' }], 1000).agenda;
  // A different pass, a different clip of the same sentence, different punctuation and case.
  const second = mergeMarks(first,
    [{ id: 'a2', status: 'covered', evidence: 'two big deals slipped — one pushed to next month!' }], 9000).agenda;
  assert.equal(second.items[1].status, 'touched');
});

test('a line capped on a shared remark can still be covered later on its own quote', () => {
  const shared = 'Two big deals slipped, one pushed to next month';
  let a = mergeMarks(buildAgenda(['Missed opportunities', 'Blockers']),
    [{ id: 'a1', status: 'covered', evidence: shared }, { id: 'a2', status: 'covered', evidence: shared }], 1000).agenda;
  assert.equal(a.items[1].status, 'touched');
  a = mergeMarks(a, [{ id: 'a2', status: 'covered', evidence: 'procurement has frozen every new vendor until April' }], 60000).agenda;
  assert.equal(a.items[1].status, 'covered');
  assert.equal(a.items[1].coveredMs, 60000);
  // ...and the first touch still records when the topic actually arose, not when it was settled.
  assert.equal(a.items[1].firstTouchedMs, 1000);
});

test('a passing remark may honestly touch several lines — only covered is capped', () => {
  const quote = 'we will come back to pricing and the timeline together';
  const r = mergeMarks(buildAgenda(['Pricing', 'Timeline']), [
    { id: 'a1', status: 'touched', evidence: quote },
    { id: 'a2', status: 'touched', evidence: quote },
  ], 10).agenda;
  assert.deepEqual(r.items.map((i) => i.status), ['touched', 'touched']);
});

test('two different remarks about one topic both count', () => {
  const r = mergeMarks(buildAgenda(['Last week results', 'Pipeline']), [
    { id: 'a1', status: 'covered', evidence: 'we closed two deals, 18,000 pounds against a 15,000 target' },
    { id: 'a2', status: 'covered', evidence: 'the pipeline is at 480k, down from 520 last week' },
  ], 10).agenda;
  assert.deepEqual(r.items.map((i) => i.status), ['covered', 'covered']);
});

test('a line re-marked on its OWN earlier quote is not capped against itself', () => {
  const quote = 'the budget is agreed at forty thousand';
  let a = mergeMarks(buildAgenda(['Budget']), [{ id: 'a1', status: 'touched', evidence: quote }], 10).agenda;
  a = mergeMarks(a, [{ id: 'a1', status: 'covered', evidence: quote }], 20).agenda;
  assert.equal(a.items[0].status, 'covered');
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

/** THE 0-OF-11 BUG. The frame used to ask what the excerpt had "moved", and the model answered
 *  that question honestly: each pass sees a window overlapping the last one, so almost nothing
 *  has newly moved, and a real 11-point sales 1:1 ended 0 covered after 14 passes. Asking for
 *  STANDING is safe only because `mergeMarks` forbids a regression in code — so the prompt must
 *  say out loud that a repeated judgement is welcome, or the next edit will quietly restore the
 *  conservatism. */
test('the prompt asks where each item STANDS, and invites a repeated judgement', () => {
  const p = buildCoveragePrompt(buildAgenda(['Confirm the budget']), 'we agreed forty thousand')!;
  assert.ok(/stands/i.test(p), 'it asks for standing, not for what changed');
  assert.ok(/even if an earlier pass already reported it/i.test(p));
  assert.ok(/only ever move forward/i.test(p), 'and says why repeating is free');
});

test('both frames refuse the two marks that would be lies', () => {
  for (const p of [
    buildCoveragePrompt(buildAgenda(['Confirm the budget']), 'we agreed forty thousand')!,
    buildReviewPrompt(buildAgenda(['Confirm the budget']), 'we agreed forty thousand')!,
  ]) {
    assert.ok(/wording resembles the topic/i.test(p), 'the agenda is not evidence');
    assert.ok(/being introduced is not being discussed/i.test(p));
    assert.ok(/quoted from the transcript/i.test(p), 'evidence is demanded');
  }
});

test('a line the room said it SKIPPED must stay out of the answer', () => {
  // "the timeline we did not get to yet" is a mention of the timeline, and the looser frame
  // marked it started. Saying a thing was not discussed is not discussing it.
  for (const p of [
    buildCoveragePrompt(buildAgenda(['Agree the timeline']), 'the timeline we did not get to yet')!,
    buildReviewPrompt(buildAgenda(['Agree the timeline']), 'the timeline we did not get to yet')!,
  ]) {
    assert.ok(/SKIPPED, deferred, or not reached/.test(p));
    assert.ok(/not discussing it/.test(p));
  }
});

test('a covered item does not reach "covered" by decision alone', () => {
  // Most agenda lines ask for an update, not a verdict. The old frame required "a conclusion,
  // decision or clear answer", which no conversational line like "Announcements" ever meets.
  const p = buildCoveragePrompt(buildAgenda(['Announcements']), 'we moved production into the lab')!;
  assert.ok(/decision is NOT required/i.test(p));
});

test('the review frame is a finished meeting, and carries the transcript it is given', () => {
  const p = buildReviewPrompt(buildAgenda(['Confirm the budget']), 'the whole conversation')!;
  assert.ok(/just ended/i.test(p));
  assert.ok(p.includes('the whole conversation'));
  assert.ok(p.includes('[a1] (open) Confirm the budget'));
});

test('a review with nothing left open asks nothing', () => {
  const a = mergeMarks(buildAgenda(['Budget']), [{ id: 'a1', status: 'covered', evidence: 'agreed' }], 10).agenda;
  assert.equal(buildReviewPrompt(a, 'the whole conversation'), null);
  assert.equal(buildReviewPrompt(buildAgenda(['Budget']), '  '), null);
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
