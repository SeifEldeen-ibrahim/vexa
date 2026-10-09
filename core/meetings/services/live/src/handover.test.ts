/** L2 — the note a dying process leaves about the call it was holding. Small, but it is the only
 *  thing standing between "a restart loses a meeting" and "a row stays `active` forever". */
import assert from 'node:assert/strict';
import { createHandoverStore, HANDOVER_KEY, type HandoverRedis } from './handover.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('handover.test.ts');

const fakeRedis = (seed: Record<string, string> = {}): HandoverRedis & { data: Record<string, string> } => {
  const data = { ...seed };
  return {
    data,
    async hSet(key, field, value) { assert.equal(key, HANDOVER_KEY); data[field] = value; return 1; },
    async hDel(key, field) { assert.equal(key, HANDOVER_KEY); delete data[field]; return 1; },
    async hGetAll(key) { assert.equal(key, HANDOVER_KEY); return { ...data }; },
  };
};

const NOTE = { uid: 'nx-1', userId: 7, meetingId: 77, at: 1_000_000 };

await test('a note survives as data, keyed by the session', async () => {
  const r = fakeRedis();
  await createHandoverStore(r).record(NOTE);
  assert.deepEqual(JSON.parse(r.data['nx-1']), NOTE);
});

await test('a resumed call forgets its note, so the sweep cannot finalize a running meeting', async () => {
  const r = fakeRedis();
  const store = createHandoverStore(r);
  await store.record(NOTE);
  await store.forget('nx-1');
  assert.deepEqual(r.data, {});
  assert.deepEqual(await store.due(2_000_000, 1000), []);
});

await test('only notes older than the timeout come due', async () => {
  const store = createHandoverStore(fakeRedis({
    'nx-old': JSON.stringify({ ...NOTE, uid: 'nx-old', at: 1_000_000 }),
    'nx-new': JSON.stringify({ ...NOTE, uid: 'nx-new', at: 1_900_000 }),
  }));
  const due = await store.due(2_000_000, 600_000);
  assert.deepEqual(due.map((n) => n.uid), ['nx-old'], 'the fresh one still has time to be resumed');
});

await test('an unreadable note is dropped, not retried forever', async () => {
  const r = fakeRedis({ 'nx-junk': 'not json', 'nx-partial': '{"uid":"nx-partial"}' });
  const store = createHandoverStore(r);
  assert.deepEqual(await store.due(2_000_000, 0), []);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.data, {}, 'both are gone');
});

await test('a redis that is down never breaks a shutdown', async () => {
  const dead: HandoverRedis = {
    async hSet() { throw new Error('ECONNREFUSED'); },
    async hDel() { throw new Error('ECONNREFUSED'); },
    async hGetAll() { throw new Error('ECONNREFUSED'); },
  };
  const store = createHandoverStore(dead);
  await store.record(NOTE);          // must not throw — this runs as the process exits
  await store.forget('nx-1');
  assert.deepEqual(await store.due(Date.now(), 0), []);
});

console.log(`\n${passed} passed`);
