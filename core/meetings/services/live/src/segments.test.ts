/** L2 — the wire format. These assertions ARE the contract with meeting-api's collector:
 *  get the envelope wrong and the symptom is a live meeting whose transcript stays empty. */
import assert from 'node:assert/strict';
import { createSegmentSink, mutableChannel, TRANSCRIPTION_STREAM, type Segment } from './segments.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('segments.test.ts');

const fakeRedis = () => {
  const adds: Array<{ key: string; fields: Record<string, string> }> = [];
  const pubs: Array<{ channel: string; message: string }> = [];
  return {
    adds, pubs,
    async xAdd(key: string, _id: string, fields: Record<string, string>) { adds.push({ key, fields }); },
    async publish(channel: string, message: string) { pubs.push({ channel, message }); },
  };
};

const seg: Segment = {
  segment_id: 'u-1', speaker: 'Speaker', text: 'we agreed forty thousand',
  start: 12.5, end: 15.25, language: 'en', completed: true,
};

const sinkOver = (redis: ReturnType<typeof fakeRedis>, onError?: (e: unknown) => void) =>
  createSegmentSink({ redis, meetingId: 42, nativeMeetingId: 'nx-abc', ownerUserId: 7, onError });

await test('a segment lands on the durable stream in the collector envelope', async () => {
  const r = fakeRedis();
  await sinkOver(r).publish(seg);
  assert.equal(r.adds.length, 1);
  assert.equal(r.adds[0].key, TRANSCRIPTION_STREAM);
  const payload = JSON.parse(r.adds[0].fields.payload);
  assert.equal(payload.type, 'transcription');
  assert.equal(payload.meeting_id, 42, 'the collector routes on the NUMERIC row id');
  assert.equal(payload.native_meeting_id, 'nx-abc');
  assert.equal(payload.owner_user_id, 7);
  assert.ok(Array.isArray(payload.segments), 'segments must be a LIST or ingest drops it');
  assert.deepEqual(payload.segments[0], seg);
});

await test('the same segment goes out live on the meeting mutable channel', async () => {
  const r = fakeRedis();
  await sinkOver(r).publish(seg);
  assert.equal(r.pubs[0].channel, mutableChannel(42));
  assert.deepEqual(JSON.parse(r.pubs[0].message), { type: 'transcript', meeting: { id: 42 }, segment: seg });
});

await test('session_end rides the same stream so the meeting gets wrapped up', async () => {
  const r = fakeRedis();
  await sinkOver(r).endSession();
  const payload = JSON.parse(r.adds[0].fields.payload);
  assert.deepEqual(payload, { type: 'session_end', meeting_id: 42, native_meeting_id: 'nx-abc' });
});

await test('a redis failure is reported, never thrown at the capture loop', async () => {
  const errs: unknown[] = [];
  const broken = {
    async xAdd() { throw new Error('stream down'); },
    async publish() { throw new Error('pubsub down'); },
  };
  const sink = createSegmentSink({
    redis: broken, meetingId: 42, nativeMeetingId: 'nx-abc', ownerUserId: 7,
    onError: (e) => errs.push(e),
  });
  await sink.publish(seg);   // must not reject
  await sink.endSession();
  assert.equal(errs.length, 3, 'both legs of publish, plus the end marker');
});

console.log(`\n${passed} passed`);
