/** L2 — the checklist's presentation. What a user sees is a product decision, so it is pinned. */
import assert from 'node:assert/strict';
import { audioHealth, clock, historyWhen, progressLine, sortForDisplay, statusLabel, whenCovered } from './agenda-view.js';
import type { Agenda } from './types.js';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('agenda-view.test.ts');

const agenda: Agenda = {
  version: 3,
  items: [
    { id: 'a1', text: 'Budget', status: 'covered', evidence: 'agreed 40k', coveredMs: 252000, firstTouchedMs: 120000 },
    { id: 'a2', text: 'Timeline', status: 'open' },
    { id: 'a3', text: 'Owners', status: 'touched', firstTouchedMs: 300000 },
    { id: 'a4', text: 'Risks', status: 'open' },
  ],
};

test('what is NOT dealt with comes first; the user\'s own order holds inside a group', () => {
  assert.deepEqual(sortForDisplay(agenda).map((i) => i.id), ['a2', 'a4', 'a3', 'a1']);
});

test('the header states the three groups rather than one percentage', () => {
  assert.equal(progressLine({ covered: 1, touched: 1, open: 2, total: 4 }), '1 of 4 covered · 1 started · 2 not yet');
  assert.equal(progressLine({ covered: 4, touched: 0, open: 0, total: 4 }), '4 of 4 covered');
  assert.equal(progressLine({ covered: 0, touched: 0, open: 0, total: 0 }), 'No checklist for this call');
});

test('statuses are said in plain words', () => {
  assert.equal(statusLabel('covered'), 'covered');
  assert.equal(statusLabel('touched'), 'started');
  assert.equal(statusLabel('open'), 'not yet');
});

test('the clock reads as a meeting length', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(9000), '0:09');
  assert.equal(clock(252000), '4:12');
  assert.equal(clock(3600000 + 125000), '1:02:05');
  assert.equal(clock(-5), '0:00');
});

test('an item says when the room got to it', () => {
  assert.equal(whenCovered(agenda.items[0]), '4:12');
  assert.equal(whenCovered(agenda.items[2]), '5:00');
  assert.equal(whenCovered(agenda.items[1]), null);
});

test('the capture indicator is honest about not hearing anything', () => {
  assert.equal(audioHealth(null, 'idle').text, 'Not recording');
  assert.equal(audioHealth({ audio: { frames: 0, last_frame_ms_ago: null } }, 'live').text, 'Waiting for the microphone…');
  assert.equal(audioHealth({ audio: { frames: 10, last_frame_ms_ago: 200 } }, 'live').tone, 'ok');
  const stalled = audioHealth({ audio: { frames: 10, last_frame_ms_ago: 30000 } }, 'live');
  assert.equal(stalled.tone, 'bad');
  assert.match(stalled.text, /Not hearing anything/);
});

test('history shows a time today and a date before that', () => {
  const now = new Date('2026-10-08T18:00:00Z');
  assert.ok(historyWhen('2026-10-08T09:30:00Z', now).length > 0);
  assert.match(historyWhen('2026-09-30T09:30:00Z', now), /Sep|9/);
  assert.equal(historyWhen(null, now), '');
  assert.equal(historyWhen('not a date', now), '');
});

console.log(`\n${passed} passed`);
