/** L2 — the cadence and the failure behaviour of the coverage loop, over a fake clock and a
 *  fake model. The cases are the ways a live checklist misbehaves in front of a user. */
import assert from 'node:assert/strict';
import { buildAgenda } from './agenda.js';
import { createCoverageRunner } from './coverage.js';
import type { CompletionPort } from './llm.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('coverage.test.ts');

const model = (replies: Array<string | null>): CompletionPort & { prompts: string[] } => {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      return replies[Math.min(i++, replies.length - 1)] ?? null;
    },
  };
};

const COVERED = '{"marks":[{"id":"a1","status":"covered","evidence":"we agreed forty thousand"}]}';
const SPEECH = 'so about the budget, we looked at the numbers and agreed forty thousand for the quarter';

const runnerOver = (m: CompletionPort, clock: { t: number }, onChange?: (a: unknown) => void) =>
  createCoverageRunner({
    agenda: buildAgenda(['Confirm the budget', 'Agree the timeline']),
    completion: m,
    intervalMs: 20000,
    windowChars: 500,
    elapsedMs: () => clock.t,
    now: () => clock.t,
    onChange,
  });

await test('a pass ticks the box and reports the change', async () => {
  const clock = { t: 100000 };
  const m = model([COVERED]);
  const changed: unknown[] = [];
  const r = runnerOver(m, clock, (a) => changed.push(a));
  r.addText(SPEECH);
  assert.equal(await r.tick(), true);
  assert.equal(r.agenda().items[0].status, 'covered');
  assert.equal(r.agenda().items[0].firstTouchedMs, 100000, 'stamped with the time into the call');
  assert.equal(changed.length, 1);
});

await test('silence spends no model call', async () => {
  const clock = { t: 100000 };
  const m = model([COVERED]);
  const r = runnerOver(m, clock);
  assert.equal(await r.tick(), false);
  assert.equal(m.prompts.length, 0);
});

await test('a trickle of speech spends no model call', async () => {
  const clock = { t: 100000 };
  const m = model([COVERED]);
  const r = runnerOver(m, clock);
  r.addText('yeah');
  assert.equal(await r.tick(), false);
  assert.equal(m.prompts.length, 0);
});

await test('passes are rate-limited to the interval', async () => {
  const clock = { t: 100000 };
  const m = model(['{"marks":[]}']);
  const r = runnerOver(m, clock);
  r.addText(SPEECH);
  await r.tick();
  assert.equal(m.prompts.length, 1);
  r.addText(SPEECH);
  await r.tick();
  assert.equal(m.prompts.length, 1, 'inside the interval, no second call');
  clock.t += 20001;
  r.addText(SPEECH);
  await r.tick();
  assert.equal(m.prompts.length, 2);
});

await test('a model failure leaves the checklist alone and RETRIES the unjudged speech', async () => {
  const clock = { t: 100000 };
  const m = model([null, COVERED]);
  const r = runnerOver(m, clock);
  r.addText(SPEECH);
  assert.equal(await r.tick(), false);
  assert.equal(r.agenda().items[0].status, 'open');
  assert.equal(r.stats().failures, 1);
  clock.t += 20001;
  assert.equal(await r.tick(), true, 'the same speech is judged on the next pass, not dropped');
});

await test('an unparseable reply is simply "nothing moved"', async () => {
  const clock = { t: 100000 };
  const r = runnerOver(model(['I think we talked about the budget?']), clock);
  r.addText(SPEECH);
  assert.equal(await r.tick(), false);
  assert.equal(r.agenda().items[0].status, 'open');
});

await test('only one pass is ever in flight', async () => {
  const clock = { t: 100000 };
  let release: (v: string) => void = () => {};
  let calls = 0;
  const slow: CompletionPort = {
    complete: () => { calls++; return new Promise<string>((res) => { release = res; }); },
  };
  const r = createCoverageRunner({
    agenda: buildAgenda(['Budget']), completion: slow, intervalMs: 0, windowChars: 500,
    elapsedMs: () => clock.t, now: () => clock.t,
  });
  r.addText(SPEECH);
  const first = r.tick();
  r.addText(SPEECH);
  assert.equal(await r.tick(), false, 'a second tick while one is in flight does nothing');
  assert.equal(calls, 1);
  release(COVERED);
  assert.equal(await first, true);
});

await test('flush judges the last thing said even though no interval has passed', async () => {
  const clock = { t: 100000 };
  const m = model([COVERED, '{"marks":[{"id":"a2","status":"covered","evidence":"settled for March"}]}']);
  const r = runnerOver(m, clock);
  r.addText(SPEECH);
  await r.tick();            // consumes the first pass
  clock.t += 10;             // nowhere near the interval
  r.addText('and the timeline is settled for March');
  assert.equal(await r.tick(), false);
  assert.equal(await r.flush(), true, 'the end-of-call pass ignores the interval');
  assert.equal(r.agenda().items[1].status, 'covered');
});

await test('flush with nothing new does not spend a call', async () => {
  const clock = { t: 100000 };
  const m = model([COVERED]);
  const r = runnerOver(m, clock);
  assert.equal(await r.flush(), false);
  assert.equal(m.prompts.length, 0);
});

await test('once everything is covered, no further calls are made', async () => {
  const clock = { t: 100000 };
  const m = model(['{"marks":[{"id":"a1","status":"covered","evidence":"yes"}]}']);
  const r = createCoverageRunner({
    agenda: buildAgenda(['Budget']), completion: m, intervalMs: 0, windowChars: 500,
    elapsedMs: () => clock.t, now: () => clock.t,
  });
  r.addText(SPEECH);
  assert.equal(await r.tick(), true);
  r.addText(SPEECH);
  assert.equal(await r.tick(), false);
  assert.equal(m.prompts.length, 1, 'a fully covered agenda asks nothing');
});

await test('the window keeps the TAIL of a long meeting, with overlap across passes', async () => {
  const clock = { t: 100000 };
  const m = model(['{"marks":[]}']);
  const r = createCoverageRunner({
    agenda: buildAgenda(['Budget']), completion: m, intervalMs: 0, windowChars: 100,
    elapsedMs: () => clock.t, now: () => clock.t,
  });
  r.addText('x'.repeat(200));
  r.addText('the budget is forty thousand');
  await r.tick();
  const prompt = m.prompts[0];
  assert.ok(prompt.includes('the budget is forty thousand'), 'the newest speech must be in the window');
  assert.ok(!prompt.includes('x'.repeat(150)), 'the oldest speech is dropped');
});

console.log(`\n${passed} passed`);
