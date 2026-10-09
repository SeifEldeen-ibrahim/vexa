/** L2 — the API the extension drives, over fakes for identity, the meetings domain and the
 *  session pipeline. The cases are the user-visible behaviours and the tenancy boundary. */
import assert from 'node:assert/strict';
import { buildAgenda, type Agenda } from './agenda.js';
import type { Authenticator } from './auth.js';
import { loadConfig } from './config.js';
import { createApi, normalizePath } from './http.js';
import type { MeetingRow, MeetingsClient } from './meetings-client.js';
import { createRegistry } from './registry.js';
import type { LiveSession, StartRequest } from './session.js';
import type { AgendaTemplate, TemplatesClient } from './templates-client.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('http.test.ts');

const ME = { userId: 7, email: 'me@biami.io', scopes: ['tx'] };
const OTHER = { userId: 8, email: 'them@biami.io', scopes: ['tx'] };

const auth = (identity = ME): Authenticator => ({
  async validate(token) {
    if (token === 'mine') return { ok: true, identity };
    if (token === 'theirs') return { ok: true, identity: OTHER };
    return { ok: false, status: 401, error: 'invalid or expired token' };
  },
  forget() {},
});

const cfg = loadConfig({
  ADMIN_API_URL: 'http://admin-api:8001',
  INTERNAL_API_SECRET: 's',
  TRANSCRIPTION_SERVICE_URL: 'http://stt',
  TRANSCRIPTION_SERVICE_TOKEN: 't',
  NEXUS_LIVE_IDLE_TIMEOUT_MS: '1000',
} as NodeJS.ProcessEnv);

let rowId = 500;
const meetingRow = (over: Partial<MeetingRow> = {}): MeetingRow => ({
  id: rowId++, user_id: 7, platform: 'in_person', native_meeting_id: `nx-${rowId}`,
  status: 'completed', start_time: '2026-10-01T09:00:00Z', end_time: '2026-10-01T09:30:00Z',
  created_at: '2026-10-01T09:00:00Z',
  data: { title: 'Past call', agenda: buildAgenda(['Budget']) },
  ...over,
});

const meetings = (rows: MeetingRow[] = [], ended: Array<[number, number]> = []): MeetingsClient & {
  ended: Array<[number, number]>;
} => ({
  ended,
  async createSession() { throw new Error('not used'); },
  async endSession(userId: number, meetingId: number) {
    ended.push([userId, meetingId]);
    return { ok: true, value: rows[0] ?? ({} as MeetingRow) };
  },
  async patchSession() { throw new Error('not used'); },
  async getSession() { throw new Error('not used'); },
  async listSessions() { return { ok: true, value: rows }; },
});

/** A templates store that records the token it was handed: the route's job is to forward the
 *  CALLER'S key, and nothing else proves it does. */
const templates = (seed: AgendaTemplate[] = []): TemplatesClient & {
  tokens: string[]; saved: unknown[]; removed: string[];
} => {
  const self = {
    tokens: [] as string[],
    saved: [] as unknown[],
    removed: [] as string[],
    async list(token: string) { self.tokens.push(token); return { ok: true as const, value: seed }; },
    async save(token: string, template: unknown) {
      self.tokens.push(token);
      self.saved.push(template);
      return { ok: true as const, value: seed };
    },
    async remove(token: string, id: string) {
      self.tokens.push(token);
      self.removed.push(id);
      return { ok: true as const, value: seed };
    },
  };
  return self;
};

/** A session stub — the pipeline itself is proved in its own suite. */
const fakeSession = (uid: string, userId = 7, agenda: Agenda = buildAgenda(['Budget'])): LiveSession & {
  endCalls: string[]; ticks: number; frameAt: number | null;
} => {
  const self = {
    sessionUid: uid, meetingId: 99, userId, startedAt: 1000, ended: false,
    endCalls: [] as string[], ticks: 0, frameAt: 1000 as number | null,
    lastFrameAt: () => self.frameAt,
    feedAudio() {},
    lines: (limit = 50) => [{ text: 'hello', at: 0 }, { text: 'budget', at: 1 }].slice(-limit),
    snapshot: () => ({
      session_uid: uid, meeting_id: 99, status: (self.ended ? 'ended' : 'live') as 'live' | 'ended',
      title: 'Live one', started_at: '2026-10-08T10:00:00Z', ended_at: null, elapsed_ms: 5000,
      agenda, progress: { covered: 0, touched: 0, open: 1, total: 1 },
      audio: { frames: 10, seconds: 3, last_frame_ms_ago: 10 },
      transcript_lines: 2, coverage: { passes: 1, changes: 0, failures: 0 }, warnings: [],
    }),
    async tick() { self.ticks++; },
    async end(reason: string) { self.endCalls.push(reason); self.ended = true; return self.snapshot(); },
  };
  return self as unknown as LiveSession & { endCalls: string[]; ticks: number; frameAt: number | null };
};

const handoverStore = (seed: Array<{ uid: string; userId: number; meetingId: number; at: number }> = []) => {
  const notes = new Map(seed.map((n) => [n.uid, n]));
  return {
    notes,
    forgotten: [] as string[],
    async record(n: { uid: string; userId: number; meetingId: number; at: number }) { notes.set(n.uid, n); },
    async forget(uid: string) { notes.delete(uid); (this as { forgotten: string[] }).forgotten.push(uid); },
    async due(nowMs: number, ttlMs: number) { return [...notes.values()].filter((n) => nowMs - n.at >= ttlMs); },
  };
};

const apiOver = (opts: {
  rows?: MeetingRow[];
  identity?: typeof ME;
  start?: ApiStart;
  registry?: ReturnType<typeof createRegistry>;
  templates?: ReturnType<typeof templates>;
  handover?: ReturnType<typeof handoverStore>;
  now?: () => number;
}) => {
  const registry = opts.registry ?? createRegistry();
  const store = opts.templates ?? templates();
  const notes = opts.handover ?? handoverStore();
  const ended: Array<[number, number]> = [];
  const store2 = meetings(opts.rows ?? [], ended);
  const api = createApi({
    cfg,
    auth: auth(opts.identity),
    meetings: store2,
    templates: store,
    registry,
    handover: notes,
    startSession: opts.start ?? (async (_r, uid) => ({ ok: true, session: fakeSession(uid) })),
    newSessionUid: () => 'nx-new',
    now: opts.now,
  });
  return { api, registry, store, notes, ended };
};
type ApiStart = (r: StartRequest, uid: string) =>
  Promise<{ ok: true; session: LiveSession } | { ok: false; status: number; error: string }>;

const GET = (path: string, token = 'mine', query: Record<string, string> = {}) =>
  ({ method: 'GET', path, query, headers: { 'x-api-key': token }, body: null });
const POST = (path: string, body: unknown, token = 'mine') =>
  ({ method: 'POST', path, query: {}, headers: { 'x-api-key': token }, body });

// ── paths + health ─────────────────────────────────────────────────────────────────────────
await test('the public /live prefix is optional, so either nginx form works', () => {
  assert.equal(normalizePath('/live/sessions'), '/sessions');
  assert.equal(normalizePath('/sessions'), '/sessions');
  assert.equal(normalizePath('/live/sessions/'), '/sessions');
  assert.equal(normalizePath('/live'), '/');
  assert.equal(normalizePath('/live/health?x=1'), '/health');
});

await test('health is open and reports what the deployment can do', async () => {
  const { api } = apiOver({});
  const r = await api.handle({ method: 'GET', path: '/live/health', query: {}, headers: {}, body: null });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { capabilities: unknown }).capabilities, { identity: true, stt: true, coverage: true });
});

await test('every other route needs a valid token', async () => {
  const { api } = apiOver({});
  for (const path of ['/me', '/history', '/checklists', '/sessions/nx-1']) {
    const r = await api.handle(GET(path, 'nope'));
    assert.equal(r.status, 401, path);
  }
  assert.equal((await api.handle(POST('/sessions', {}, 'nope'))).status, 401);
});

// ── starting a call ────────────────────────────────────────────────────────────────────────
await test('starting a call returns the checklist and where to send audio', async () => {
  const { api, registry } = apiOver({});
  const r = await api.handle(POST('/sessions', { title: 'Standup', agenda: ['Blockers', 'Budget'] }));
  assert.equal(r.status, 201);
  const body = r.body as { session_uid: string; ingest: { url: string; subprotocol_prefix: string } };
  assert.equal(body.session_uid, 'nx-new');
  assert.equal(body.ingest.url, cfg.publicIngestUrl);
  assert.equal(body.ingest.subprotocol_prefix, 'nexus-token.');
  assert.ok(registry.liveForUser(7), 'the session is registered');
});

await test('the agenda may arrive as a list or as one textarea blob', async () => {
  const seen: StartRequest[] = [];
  const start: ApiStart = async (r, uid) => { seen.push(r); return { ok: true, session: fakeSession(uid) }; };
  const { api } = apiOver({ start });
  await api.handle(POST('/sessions', { agenda: ['One', 'Two'] }));
  assert.deepEqual(seen[0].agendaLines, ['One', 'Two']);
  const { api: api2 } = apiOver({ start });
  await api2.handle(POST('/sessions', { checklist: 'One\nTwo' }));
  assert.equal(seen[1].agendaLines, 'One\nTwo');
});

await test('a second Start hands back the call already running instead of a second meeting', async () => {
  const { api } = apiOver({});
  await api.handle(POST('/sessions', { title: 'First' }));
  const r = await api.handle(POST('/sessions', { title: 'Second' }));
  assert.equal(r.status, 409);
  assert.equal((r.body as { live_session: { session_uid: string } }).live_session.session_uid, 'nx-new');
});

await test('a start that cannot claim a meeting row fails loudly', async () => {
  const { api, registry } = apiOver({
    start: async () => ({ ok: false, status: 503, error: 'could not start the meeting: meeting-api unreachable' }),
  });
  const r = await api.handle(POST('/sessions', {}));
  assert.equal(r.status, 503);
  assert.equal(registry.liveCount(), 0, 'nothing half-started');
});

// ── the live call ──────────────────────────────────────────────────────────────────────────
await test('the live snapshot and transcript tail are readable by the owner', async () => {
  const { api } = apiOver({});
  await api.handle(POST('/sessions', {}));
  const snap = await api.handle(GET('/sessions/nx-new'));
  assert.equal(snap.status, 200);
  assert.equal((snap.body as { status: string }).status, 'live');
  const tail = await api.handle(GET('/sessions/nx-new/transcript', 'mine', { limit: '1' }));
  assert.deepEqual((tail.body as { lines: unknown[] }).lines, [{ text: 'budget', at: 1 }]);
});

await test('ANOTHER user cannot read or stop my call — it simply does not exist for them', async () => {
  const registry = createRegistry();
  registry.add(fakeSession('nx-mine', 7));
  const { api } = apiOver({ registry, identity: OTHER });
  assert.equal((await api.handle(GET('/sessions/nx-mine', 'theirs'))).status, 404);
  assert.equal((await api.handle(GET('/sessions/nx-mine/transcript', 'theirs'))).status, 404);
  assert.equal((await api.handle(POST('/sessions/nx-mine/end', {}, 'theirs'))).status, 404);
});

await test('stopping ends the session once', async () => {
  const registry = createRegistry();
  const s = fakeSession('nx-1', 7);
  registry.add(s);
  const { api } = apiOver({ registry });
  const r = await api.handle(POST('/sessions/nx-1/end', {}));
  assert.equal(r.status, 200);
  assert.equal((r.body as { status: string }).status, 'ended');
  assert.deepEqual(s.endCalls, ['stopped by the user']);
});

// ── history + checklists ───────────────────────────────────────────────────────────────────
await test('history lists past calls with how much of the checklist was covered', async () => {
  const { api } = apiOver({ rows: [meetingRow({ native_meeting_id: 'nx-old' })] });
  const r = await api.handle(GET('/history'));
  assert.equal(r.status, 200);
  const [row] = (r.body as { sessions: Array<{ title: string; progress: unknown; session_uid: string }> }).sessions;
  assert.equal(row.title, 'Past call');
  assert.deepEqual(row.progress, { covered: 0, touched: 0, open: 1, total: 1 });
});

await test('a finished call is readable by uid from its durable row', async () => {
  const { api } = apiOver({ rows: [meetingRow({ native_meeting_id: 'nx-old' })] });
  const r = await api.handle(GET('/sessions/nx-old'));
  assert.equal(r.status, 200);
  assert.equal((r.body as { title: string }).title, 'Past call');
});

await test('an unknown session is a 404, not an empty success', async () => {
  const { api } = apiOver({ rows: [] });
  assert.equal((await api.handle(GET('/sessions/nope'))).status, 404);
  assert.equal((await api.handle(GET('/nonsense'))).status, 404);
});

await test('checklists offers the lists this user has used before', async () => {
  const { api } = apiOver({ rows: [meetingRow(), meetingRow()] });
  const r = await api.handle(GET('/checklists'));
  const lists = (r.body as { checklists: Array<{ items: string[]; uses: number }> }).checklists;
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].items, ['Budget']);
  assert.equal(lists[0].uses, 2);
});

// ── the janitor ────────────────────────────────────────────────────────────────────────────
await test('a call whose audio stopped is finalized, not left active forever', async () => {
  const registry = createRegistry();
  const s = fakeSession('nx-quiet', 7);
  s.frameAt = 0;                       // last frame long ago
  registry.add(s);
  const { api } = apiOver({ registry, now: () => 5000 });   // idle timeout is 1000ms
  await api.sweep();
  assert.deepEqual(s.endCalls, ['no audio (the capture stopped without saying goodbye)']);
});

await test('a call that is still being heard is ticked, not ended', async () => {
  const registry = createRegistry();
  const s = fakeSession('nx-live', 7);
  s.frameAt = 4900;
  registry.add(s);
  const { api } = apiOver({ registry, now: () => 5000 });
  await api.sweep();
  assert.deepEqual(s.endCalls, []);
  assert.equal(s.ticks, 1);
});


// ── saved agenda templates ─────────────────────────────────────────────────────────────────
// This service stores none of this. The property each test below protects is that the route
// forwards the CALLER'S OWN key, because that is what keeps one user's templates out of
// another user's reach without this service having any privilege at all.
await test('listing templates forwards the caller\'s own key, never a privileged one', async () => {
  const store = templates([{ id: 't-standup', name: 'Weekly standup', items: ['Blockers'] }]);
  const { api } = apiOver({ templates: store });
  const r = await api.handle(GET('/templates', 'theirs'));
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { templates: unknown[] }).templates, [
    { id: 't-standup', name: 'Weekly standup', items: ['Blockers'] },
  ]);
  assert.deepEqual(store.tokens, ['theirs']);
});

await test('a template saves whether it arrives wrapped or bare', async () => {
  const store = templates();
  const { api } = apiOver({ templates: store });
  assert.equal((await api.handle(POST('/templates', { template: { name: 'A', items: ['x'] } }))).status, 200);
  assert.equal((await api.handle(POST('/templates', { name: 'B', items: ['y'] }))).status, 200);
  assert.deepEqual(store.saved, [
    { name: 'A', items: ['x'] },
    { name: 'B', items: ['y'], id: undefined },
  ]);
});

await test('PUT saves too, since the extension does not know if it is new', async () => {
  const store = templates();
  const { api } = apiOver({ templates: store });
  const r = await api.handle({
    method: 'PUT', path: '/templates', query: {}, headers: { 'x-api-key': 'mine' },
    body: { template: { id: 't-a', name: 'A', items: ['x'] } },
  });
  assert.equal(r.status, 200);
  assert.equal(store.saved.length, 1);
});

await test('saving nothing is refused rather than stored as an empty template', async () => {
  const { api, store } = apiOver({});
  const r = await api.handle(POST('/templates', {}));
  assert.equal(r.status, 400);
  assert.deepEqual(store.saved, []);
});

await test('deleting names the template in the path and forwards the key', async () => {
  const store = templates();
  const { api } = apiOver({ templates: store });
  const r = await api.handle({
    method: 'DELETE', path: '/live/templates/t-weekly%20standup', query: {},
    headers: { 'x-api-key': 'mine' }, body: null,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(store.removed, ['t-weekly standup']);
});

await test('templates are refused without a key, like everything else that is the caller\'s own', async () => {
  const { api, store } = apiOver({});
  assert.equal((await api.handle(GET('/templates', 'nope'))).status, 401);
  assert.deepEqual(store.tokens, []);
});

await test('an unsupported method on /templates says so instead of 404', async () => {
  const { api } = apiOver({});
  const r = await api.handle({
    method: 'PATCH', path: '/templates', query: {}, headers: { 'x-api-key': 'mine' }, body: {},
  });
  assert.equal(r.status, 405);
});

// ── resuming a call this process never saw ───────────────────────────────────────────────────
// The gate on the whole feature. A capture socket must never be able to CREATE a meeting, revive
// a finished one, or reach another person's call — it may only pick up a running call of its own.
const ACTIVE = (over: Partial<MeetingRow> = {}) => meetingRow({
  id: 701, native_meeting_id: 'nx-live', status: 'active', end_time: null,
  start_time: new Date(Date.now() - 19 * 60 * 1000).toISOString(),
  data: { title: 'Half-finished', agenda: buildAgenda(['Budget', 'Timeline']) },
  ...over,
});

await test('an active row of my own is resumable, and carries its row and checklist', async () => {
  const seen: StartRequest[] = [];
  const { api, registry } = apiOver({
    rows: [ACTIVE()],
    start: async (r, uid) => { seen.push(r); return { ok: true, session: fakeSession(uid) }; },
  });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].resume?.meetingId, 701);
  assert.equal(seen[0].resume?.agenda.items.length, 2, 'the stored checklist comes back');
  assert.ok((seen[0].resume?.startedAtMs ?? 0) > 0, 'and the original start time');
  assert.ok(registry.byUid('nx-live'), 'the resumed session is registered');
});

await test('a FINISHED call is not resumable — a read transcript must not grow new speech', async () => {
  const { api } = apiOver({ rows: [ACTIVE({ status: 'completed', end_time: '2026-10-01T09:30:00Z' })] });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 409);
});

await test('a socket cannot CREATE a call out of an unknown session', async () => {
  const { api } = apiOver({ rows: [] });
  const r = await api.resumeSession('nx-nope', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok === false && r.status, 404);
});

await test('a socket cannot resume somebody else\'s call', async () => {
  const { api } = apiOver({ rows: [ACTIVE({ user_id: 9 })] });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok === false && r.status, 404);
});

await test('a session still held in memory is returned as-is, not resumed twice', async () => {
  const registry = createRegistry();
  const held = fakeSession('nx-live');
  registry.add(held);
  const starts: unknown[] = [];
  const { api } = apiOver({
    rows: [ACTIVE()], registry,
    start: async (r, uid) => { starts.push(r); return { ok: true, session: fakeSession(uid) }; },
  });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok && r.session === held, true);
  assert.equal(starts.length, 0, 'no second session is built for a call we are already holding');
});

await test('one microphone is one call: another live session blocks a resume', async () => {
  const registry = createRegistry();
  registry.add(fakeSession('nx-other'));
  const { api } = apiOver({ rows: [ACTIVE()], registry });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok === false && r.status, 409);
});

await test('a row with no start time cannot be resumed onto a timeline', async () => {
  const { api } = apiOver({ rows: [ACTIVE({ start_time: '' })] });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok === false && r.status, 409);
});

/** The other half of a handover: a call nobody came back for. The session is in no process's
 *  memory, so the janitor's own loop cannot see it, and the in-person lane is exempt from
 *  meeting-api's reconcile sweep — without this the row stays `active` for good. */
await test('a call nobody resumed is finalized after one idle timeout', async () => {
  const notes = handoverStore([{ uid: 'nx-gone', userId: 7, meetingId: 701, at: 0 }]);
  const { api, ended } = apiOver({ rows: [ACTIVE()], handover: notes, now: () => cfg.idleTimeoutMs + 1 });
  await api.sweep();
  assert.deepEqual(ended, [[7, 701]], 'the meeting is closed, under its own owner');
  assert.equal(notes.notes.size, 0, 'and the note is spent');
});

await test('a fresh handover is left alone — the extension is still reconnecting', async () => {
  // Half an idle timeout old: the extension reconnects every 20s, so this one still has a chance.
  const notes = handoverStore([{ uid: 'nx-gone', userId: 7, meetingId: 701, at: 1000 }]);
  const { api, ended } = apiOver({ rows: [ACTIVE()], handover: notes, now: () => 1000 + cfg.idleTimeoutMs / 2 });
  await api.sweep();
  assert.deepEqual(ended, [], 'not yet — it may still be picked up');
  assert.equal(notes.notes.size, 1);
});

await test('a note for a call that WAS resumed never finalizes it', async () => {
  const registry = createRegistry();
  registry.add(fakeSession('nx-gone'));
  const notes = handoverStore([{ uid: 'nx-gone', userId: 7, meetingId: 701, at: 0 }]);
  const { api, ended } = apiOver({ rows: [ACTIVE()], registry, handover: notes, now: () => cfg.idleTimeoutMs + 1 });
  await api.sweep();
  assert.deepEqual(ended, [], 'it is live in this process — closing it would cut a running call');
});

await test('resuming a call spends its handover note', async () => {
  const notes = handoverStore([{ uid: 'nx-live', userId: 7, meetingId: 701, at: 0 }]);
  const { api } = apiOver({ rows: [ACTIVE()], handover: notes });
  const r = await api.resumeSession('nx-live', { userId: 7, email: 'me@biami.io', scopes: ['tx'] });
  assert.equal(r.ok, true);
  assert.equal(notes.notes.size, 0, 'so the sweep cannot later finalize it');
});

console.log(`\n${passed} passed`);
