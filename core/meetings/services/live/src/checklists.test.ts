/** L2 — "reuse a list I've used before", derived from the user's own past calls. */
import assert from 'node:assert/strict';
import { checklistsFromRows, titleOf } from './checklists.js';
import type { MeetingRow } from './meetings-client.js';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('checklists.test.ts');

let id = 100;
const row = (title: string, items: Array<[string, string]>, createdAt = '2026-10-01T09:00:00Z'): MeetingRow => ({
  id: id++, user_id: 7, platform: 'in_person', native_meeting_id: `nx-${id}`,
  status: 'completed', start_time: createdAt, end_time: null, created_at: createdAt,
  data: {
    title,
    agenda: { version: 1, items: items.map(([text, status], i) => ({ id: `a${i + 1}`, text, status })) },
  },
});

test('a past call becomes a reusable list', () => {
  const [cl] = checklistsFromRows([row('Weekly standup', [['Blockers', 'covered'], ['Next sprint', 'open']])]);
  assert.equal(cl.title, 'Weekly standup');
  assert.deepEqual(cl.items, ['Blockers', 'Next sprint']);
  assert.equal(cl.uses, 1);
  assert.equal(cl.lastCovered, 1);
  assert.equal(cl.lastUsedAt, '2026-10-01T09:00:00Z');
});

test('the same list under a different title is ONE list used twice', () => {
  const lists = checklistsFromRows([
    row('Standup Oct 8', [['Blockers', 'open'], ['Next sprint', 'open']], '2026-10-08T09:00:00Z'),
    row('Standup Oct 1', [['next sprint', 'covered'], ['blockers!', 'covered']], '2026-10-01T09:00:00Z'),
  ]);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].uses, 2);
  assert.equal(lists[0].title, 'Standup Oct 8', 'the newest title is the recognizable one');
});

test('different lists stay separate, newest first', () => {
  const lists = checklistsFromRows([
    row('Client intro', [['Who they are', 'open']], '2026-10-08T09:00:00Z'),
    row('Standup', [['Blockers', 'open']], '2026-10-01T09:00:00Z'),
  ]);
  assert.deepEqual(lists.map((l) => l.title), ['Client intro', 'Standup']);
  assert.notEqual(lists[0].key, lists[1].key);
});

test('a call that had no checklist contributes nothing', () => {
  const bare: MeetingRow = { ...row('No agenda', []), data: { title: 'No agenda' } };
  assert.deepEqual(checklistsFromRows([bare]), []);
});

test('the list is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => row(`Call ${i}`, [[`Topic ${i}`, 'open']]));
  assert.equal(checklistsFromRows(many, 5).length, 5);
});

test('an untitled call is labelled honestly rather than blankly', () => {
  assert.equal(titleOf({ ...row('', []), data: {} }), 'Untitled call');
  assert.equal(titleOf({ ...row('', []), data: { title: '   ' } }), 'Untitled call');
});

console.log(`\n${passed} passed`);
