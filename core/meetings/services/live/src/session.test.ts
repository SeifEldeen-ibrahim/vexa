/** L3 — one call, end to end, with the pipeline faked at its seam: audio in → a transcript
 *  segment on the spine → the checklist ticked → the meeting row closed. This is the test that
 *  proves the PARTS ARE WIRED TOGETHER; each part has its own L2 suite above. */
import assert from 'node:assert/strict';
import type { ChunkedTranscriber, ChunkedTranscriberCallbacks, ChunkSegment } from '@vexa/mixed-pipeline';
import { loadConfig } from './config.js';
import type { CompletionPort } from './llm.js';
import type { MeetingRow, MeetingsClient } from './meetings-client.js';
import { startSession, type SessionDeps } from './session.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('session.test.ts');

const IDENTITY = { userId: 7, email: 'me@biami.io', scopes: ['tx'] };

const cfg = loadConfig({
  ADMIN_API_URL: 'http://admin-api:8001',
  INTERNAL_API_SECRET: 's',
  TRANSCRIPTION_SERVICE_URL: 'http://stt',
  TRANSCRIPTION_SERVICE_TOKEN: 't',
  NEXUS_LIVE_COVERAGE_INTERVAL_MS: '1',
} as Record<string, string>);

function harness(opts: { reply?: string | null; createFails?: boolean } = {}) {
  const adds: Array<Record<string, unknown>> = [];
  const pubs: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const ended: number[] = [];
  let row: MeetingRow = {
    id: 77, user_id: 7, platform: 'in_person', native_meeting_id: 'nx-1', status: 'active',
    start_time: '2026-10-08T10:00:00Z', end_time: null, data: {},
  };

  const meetings: MeetingsClient = {
    async createSession(_u, uid, data) {
      if (opts.createFails) return { ok: false, status: 503, error: 'meeting-api unreachable' };
      row = { ...row, native_meeting_id: uid, data: data as Record<string, unknown> };
      return { ok: true, value: row };
    },
    async patchSession(_u, _id, data) {
      patches.push(data);
      row = { ...row, data: { ...row.data, ...data } };
      return { ok: true, value: row };
    },
    async endSession(_u, id) {
      ended.push(id);
      row = { ...row, status: 'completed', end_time: '2026-10-08T10:30:00Z' };
      return { ok: true, value: row };
    },
    async getSession() { return { ok: true, value: row }; },
    async listSessions() { return { ok: true, value: [row] }; },
  };

  const completion: CompletionPort = {
    async complete() {
      return opts.reply === undefined
        ? '{"marks":[{"id":"a1","status":"covered","evidence":"agreed forty thousand"}]}'
        : opts.reply;
    },
  };

  // The pipeline's seam: the test drives `publish` itself, exactly as the real transcriber would
  // when a turn closes.
  let cb: ChunkedTranscriberCallbacks | null = null;
  let settled = 0;
  let disposed = 0;
  const fed: Array<{ n: number; ts: number }> = [];
  const makeTranscriber = async (callbacks: ChunkedTranscriberCallbacks) => {
    cb = callbacks;
    return {
      feedAudio: (pcm: Float32Array, ts: number) => { fed.push({ n: pcm.length, ts }); },
      async settled() { settled++; },
      async dispose() { disposed++; },
    } as unknown as ChunkedTranscriber;
  };

  const deps: SessionDeps = {
    cfg,
    meetings,
    redis: {
      async xAdd(_k, _i, fields) { adds.push(JSON.parse(String(fields.payload))); },
      async publish(_c, message) { pubs.push(message); },
    },
    completion,
    transcribe: async () => ({ text: '', language: 'en', language_probability: 1, duration: 0, segments: [] }),
    makeTranscriber,
  };

  const chunk = (over: Partial<ChunkSegment> = {}): ChunkSegment => ({
    text: 'okay so on the budget, we went through the numbers line by line and we are all '
      + 'agreed on forty thousand for the quarter, and I will send the sheet round after this',
    startMs: 1_700_000_010_000, endMs: 1_700_000_014_000, language: 'en', segmentId: 'seg_1',
    ...over,
  });

  return {
    deps, adds, pubs, patches, ended, fed, chunk,
    publish: (confirmed: ChunkSegment[], pending: ChunkSegment[] = []) => cb!.publish('seg_1', confirmed, pending),
    counts: () => ({ settled, disposed }),
    row: () => row,
  };
}

const START = { identity: IDENTITY, title: 'Budget review', agendaLines: ['Confirm the budget', 'Agree the timeline'] };

await test('a call claims a meeting row carrying its checklist', async () => {
  const h = harness();
  const started = await startSession(h.deps, START, 'nx-1');
  assert.equal(started.ok, true);
  const snap = started.ok && started.session.snapshot();
  assert.equal(snap && snap.meeting_id, 77);
  assert.equal(snap && snap.agenda.items.length, 2);
  assert.equal(snap && snap.progress.open, 2);
  assert.equal(snap && snap.title, 'Budget review');
});

await test('a call that cannot claim a row never starts', async () => {
  const h = harness({ createFails: true });
  const started = await startSession(h.deps, START, 'nx-1');
  assert.equal(started.ok, false);
  assert.equal(started.ok === false && started.status, 503);
  assert.ok(started.ok === false && /could not start the meeting/.test(started.error));
});

await test('a confirmed turn lands on the transcript spine, timed from the call start', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([h.chunk()]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.adds.length, 1);
  const seg = (h.adds[0].segments as Array<Record<string, unknown>>)[0];
  assert.equal(h.adds[0].meeting_id, 77);
  assert.equal(seg.segment_id, 'nx-1-seg_1');
  assert.equal(seg.completed, true);
  assert.equal(seg.start, 10, 'relative to the FIRST frame, not the browser clock');
  assert.equal(seg.end, 14);
  assert.equal(seg.speaker, '', 'one room mic cannot attribute a voice, so it claims nobody');
  assert.equal(h.pubs.length, 1, 'and it goes out live for the terminal too');
});

await test('a pending draft is published live but is NOT judged against the checklist', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([], [h.chunk({ segmentId: 'seg_2' })]);
  await new Promise((r) => setImmediate(r));
  assert.equal((h.adds[0].segments as Array<Record<string, unknown>>)[0].completed, false);
  await s.session.tick();
  assert.equal(s.session.snapshot().agenda.items[0].status, 'open', 'drafts must not tick boxes');
});

await test('what the room actually said ticks the box, and persists onto the row', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([h.chunk()]);
  await new Promise((r) => setImmediate(r));
  await s.session.tick();
  const snap = s.session.snapshot();
  assert.equal(snap.agenda.items[0].status, 'covered');
  assert.equal(snap.agenda.items[0].evidence, 'agreed forty thousand');
  assert.deepEqual(snap.progress, { covered: 1, touched: 0, open: 1, total: 2 });
  const persisted = h.patches.at(-1) as { agenda: { items: Array<{ status: string }> } };
  assert.equal(persisted.agenda.items[0].status, 'covered', 'the tick is durable, not just in memory');
});

await test('ending a call settles the pipeline, judges the last words, and completes the meeting', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([h.chunk()]);
  await new Promise((r) => setImmediate(r));
  const final = await s.session.end('stopped by the user');
  assert.equal(final.status, 'ended');
  assert.equal(final.agenda.items[0].status, 'covered', 'the final pass ran');
  assert.deepEqual(h.counts(), { settled: 1, disposed: 1 });
  assert.deepEqual(h.ended, [77]);
  assert.ok(h.adds.some((a) => a.type === 'session_end'), 'the spine is told the session ended');
  const last = h.patches.at(-1) as { live_session?: { ended_reason?: string; transcript_lines?: number } };
  assert.equal(last.live_session?.ended_reason, 'stopped by the user');
  assert.equal(last.live_session?.transcript_lines, 1);
});

await test('ending twice is harmless', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  await s.session.end('stopped by the user');
  await s.session.end('stopped again');
  assert.deepEqual(h.ended, [77], 'the meeting is completed exactly once');
});

await test('audio after the end is ignored rather than resurrecting the call', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  await s.session.end('stopped by the user');
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_020_000);
  assert.equal(h.fed.length, 0);
});

await test('with no model configured the transcript still records; the checklist just waits', async () => {
  const h = harness({ reply: null });
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([h.chunk()]);
  await new Promise((r) => setImmediate(r));
  await s.session.tick();
  assert.equal(h.adds.length, 1, 'the transcript is unaffected');
  assert.equal(s.session.snapshot().agenda.items[0].status, 'open');
  assert.equal(s.session.snapshot().coverage.failures, 1, 'and the failure is visible, not hidden');
});

await test('a deployment with no STT refuses to start a call rather than record silence', async () => {
  const h = harness();
  const blind: SessionDeps = {
    ...h.deps,
    cfg: loadConfig({ ADMIN_API_URL: 'u', INTERNAL_API_SECRET: 's' } as Record<string, string>),
  };
  const started = await startSession(blind, START, 'nx-1');
  assert.equal(started.ok, false);
  assert.ok(started.ok === false && /transcription is not configured/.test(started.error));
});

/** The duplicate-transcript bug, in the shape it actually appeared: a real 1:1 was stored with
 *  90 rows for 68 lines of speech, every other row a half-finished draft of the line beside it.
 *  Drafts carry their own ids (`turn:6:p0`), confirm under a different one (`turn:6:0`), and the
 *  store upserts by id — so the draft is replaced by nothing and the saved transcript stutters. */
await test('a draft that confirms is RETRACTED, so the stored transcript says it once', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);

  // The pipeline's real sequence: a draft, then the same speech confirmed under a new id.
  h.publish([], [h.chunk({ segmentId: 'turn:6:p0', text: 'so look a few announce' })]);
  h.publish([h.chunk({ segmentId: 'turn:6:0', text: 'so look, a few announcements.' })], []);
  await new Promise((r) => setImmediate(r));

  const retracts = h.adds.filter((a) => a.type === 'transcript_retract');
  assert.equal(retracts.length, 1, 'the draft is withdrawn');
  assert.deepEqual(retracts[0].segment_ids, ['nx-1-turn:6:p0']);
  assert.equal(retracts[0].meeting_id, 77);
  // And the live channel hears it too, so an open terminal drops the draft instead of keeping it.
  assert.ok(h.pubs.some((p) => JSON.parse(p).type === 'transcript_retract'));
});

await test('a draft still in the pending block is not retracted and republished', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([], [h.chunk({ segmentId: 'turn:6:p0', text: 'so look a few' })]);
  h.publish([], [h.chunk({ segmentId: 'turn:6:p0', text: 'so look a few announcements' })]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.adds.filter((a) => a.type === 'transcript_retract').length, 0);
});

await test('no draft outlives the call', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([], [h.chunk({ segmentId: 'turn:9:p0', text: 'and the last thing I wanted to' })]);
  await s.session.end('stopped by the user');
  const retracted = h.adds.filter((a) => a.type === 'transcript_retract')
    .flatMap((a) => a.segment_ids as string[]);
  assert.deepEqual(retracted, ['nx-1-turn:9:p0'], 'an unconfirmed tail is withdrawn, not left as speech');
});

/** The whole-meeting review is the pass the stored record is judged on, so it has to actually
 *  run at the end of a call — and it has to be handed the conversation, not the live window. */
await test('ending a call reviews the whole meeting', async () => {
  const prompts: string[] = [];
  const h = harness();
  h.deps.completion = { async complete(p) { prompts.push(p); return '{"marks":[]}'; } };
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([h.chunk({ segmentId: 'turn:1:0' })], []);
  await new Promise((r) => setImmediate(r));
  await s.session.end('stopped by the user');
  assert.ok(prompts.length >= 1);
  const review = prompts[prompts.length - 1];
  assert.ok(/just ended/.test(review), 'the last pass is the end-of-call review');
  assert.ok(review.includes('forty thousand for the quarter'), 'and it carries the transcript');
});

await test('a judge that stops answering is reported, not mistaken for a quiet one', async () => {
  const h = harness({ reply: null });
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  assert.deepEqual(s.session.snapshot().warnings, [], 'nothing to report before anything is asked');
  for (let i = 0; i < 3; i++) {
    h.publish([h.chunk({ segmentId: `turn:${i}:0` })], []);
    await new Promise((r) => setImmediate(r));
    // The configured interval is 1ms, so the passes need distinct milliseconds to be due.
    await new Promise((r) => setTimeout(r, 3));
    await s.session.tick();
  }
  const warn = s.session.snapshot().warnings.join(' ');
  assert.ok(/not answering/.test(warn), warn);
  assert.ok(/checklist may be behind/.test(warn));
});

// ── resume ────────────────────────────────────────────────────────────────────────────────────
// A session lives in this process's memory, so a restart loses it and the extension reconnects to
// a process that never heard of the call. These are the two ways resuming could make things WORSE
// than the 404 it replaces: overwriting the transcript it means to continue, and rewinding its
// clock to zero.
// A FIXED clock, because "19 minutes in" is the whole assertion: reading it off Date.now() made
// the elapsed check depend on how long the test itself took (it failed by one millisecond).
const NOW = 1_700_000_000_000;
const NINETEEN_MIN = 19 * 60 * 1000;
const RESUME = (over: Record<string, unknown> = {}) => ({
  identity: IDENTITY,
  title: 'Budget review',
  agendaLines: [],
  resume: {
    meetingId: 77,
    startedAtMs: NOW - NINETEEN_MIN,   // picked up 19 minutes in
    agenda: { items: [
      { id: 'a1', text: 'Confirm the budget', status: 'covered' as const, evidence: 'agreed 40k' },
      { id: 'a2', text: 'Agree the timeline', status: 'open' as const },
    ], version: 3 },
  },
  ...over,
});

await test('a resumed call keeps its row instead of claiming a second one', async () => {
  const h = harness();
  h.deps.now = () => NOW;
  const created: unknown[] = [];
  const inner = h.deps.meetings.createSession;
  h.deps.meetings.createSession = async (...a: Parameters<typeof inner>) => { created.push(a); return inner(...a); };
  const s = (await startSession(h.deps, RESUME(), 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  assert.equal(s.ok, true);
  assert.equal(created.length, 0, 'no second meeting row');
  assert.equal(s.session.meetingId, 77);
});

await test('a resumed call keeps the ticks already earned', async () => {
  const h = harness();
  h.deps.now = () => NOW;
  const s = (await startSession(h.deps, RESUME(), 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  const snap = s.session.snapshot();
  assert.equal(snap.progress.covered, 1, 'the covered item survives the restart');
  assert.equal(snap.agenda.items[0].evidence, 'agreed 40k');
});

await test('resumed segment ids CANNOT collide with what is already stored', async () => {
  // The pipeline numbers turns from scratch, and the store upserts by (meeting_id, segment_id):
  // without a distinct prefix the resumed call would overwrite the transcript line by line.
  const h = harness();
  h.deps.now = () => NOW;
  const s = (await startSession(h.deps, RESUME(), 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), NOW);
  h.publish([h.chunk({ segmentId: 'turn:0:0' })], []);
  await new Promise((r) => setImmediate(r));
  const seg = (h.adds[0].segments as Array<Record<string, unknown>>)[0];
  assert.notEqual(seg.segment_id, 'nx-1-turn:0:0', 'must NOT reuse the original id');
  assert.match(String(seg.segment_id), /^nx-1-r\d+-turn:0:0$/);
});

await test('a resumed transcript continues the call clock, it does not rewind to zero', async () => {
  const h = harness();
  h.deps.now = () => NOW;
  const s = (await startSession(h.deps, RESUME(), 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), NOW);
  h.publish([h.chunk({ startMs: NOW, endMs: NOW + 4000 })], []);
  await new Promise((r) => setImmediate(r));
  const seg = (h.adds[0].segments as Array<Record<string, unknown>>)[0];
  assert.equal(Number(seg.start), NINETEEN_MIN / 1000, 'the first resumed second is 19 minutes in, not 0');
  assert.equal(s.session.snapshot().elapsed_ms, NINETEEN_MIN, 'and the call reads as 19 minutes old');
  // The absolute stamp must agree, or the terminal would draw it at the wrong wall-clock time.
  assert.equal(seg.absolute_start_time, new Date(NOW).toISOString());
});

await test('an un-resumed call keeps the original id shape', async () => {
  const h = harness();
  const s = (await startSession(h.deps, START, 'nx-1')) as { ok: true; session: import('./session.js').LiveSession };
  s.session.feedAudio(1000, new Float32Array(1600), 1_700_000_000_000);
  h.publish([h.chunk({ segmentId: 'turn:0:0' })], []);
  await new Promise((r) => setImmediate(r));
  const seg = (h.adds[0].segments as Array<Record<string, unknown>>)[0];
  assert.equal(seg.segment_id, 'nx-1-turn:0:0', 'nothing already stored changes shape');
});

console.log(`\n${passed} passed`);
