/** L2 — the API client, over an injected fetch. The cases are the failures a user would
 *  otherwise see as a blank panel. */
import assert from 'node:assert/strict';
import { NexusApi } from './api.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('api.test.ts');

const reply = (status: number, body: unknown) => ({
  calls: [] as Array<{ url: string; init: RequestInit }>,
  fetcher(url: string, init: RequestInit) {
    this.calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as Response);
  },
});

const apiOver = (f: { fetcher: (u: string, i: RequestInit) => Promise<Response> }) =>
  new NexusApi({ baseUrl: 'https://nexus.biami.io', token: 'tok', fetcher: f.fetcher.bind(f) as typeof fetch });

/** The regression that cost an evening: the client used to keep the global `fetch` as a field
 *  and call it as a method, which Chrome rejects with "Illegal invocation". Every other test here
 *  injects a fetcher, so this is the ONE case that exercises the default — and it fails the way a
 *  service worker does, by refusing a receiver that is not the global scope. */
await test('the default fetch is called with the global as its receiver, not the client', async () => {
  const realFetch = globalThis.fetch;
  let seen = 0;
  const strict = function (this: unknown): Promise<Response> {
    // Chrome's own rule: the global function demands the global object (or nothing) as receiver.
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
    }
    seen++;
    return Promise.resolve({ ok: true, status: 200, text: async () => '{"user_id":1,"email":"a@b.c"}' } as Response);
  };
  globalThis.fetch = strict as typeof fetch;
  try {
    // No `fetcher` — the production path.
    const res = await new NexusApi({ baseUrl: 'https://nexus.biami.io', token: 'tok' }).me();
    assert.equal(seen, 1);
    assert.ok(res.ok, `the default fetch path failed: ${res.ok ? '' : res.error}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('calls go to the /live prefix carrying the API key', async () => {
  const f = reply(200, { user_id: 7, email: 'me@biami.io' });
  await apiOver(f).me();
  assert.equal(f.calls[0].url, 'https://nexus.biami.io/live/me');
  assert.equal((f.calls[0].init.headers as Record<string, string>)['X-API-Key'], 'tok');
});

await test('a trailing slash on the base URL does not double up', async () => {
  const f = reply(200, {});
  await new NexusApi({ baseUrl: 'https://nexus.biami.io/', token: 't', fetcher: f.fetcher.bind(f) as typeof fetch }).me();
  assert.equal(f.calls[0].url, 'https://nexus.biami.io/live/me');
});

await test('start sends the title and the checklist', async () => {
  const f = reply(201, { session_uid: 'nx-1', ingest: { url: 'wss://x/live/ingest' } });
  const r = await apiOver(f).start('Standup', ['Blockers', 'Budget']);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { title: 'Standup', agenda: ['Blockers', 'Budget'] });
});

await test('a 409 hands back the call already running so the panel can offer to resume', async () => {
  const live = { session_uid: 'nx-old', status: 'live' };
  const r = await apiOver(reply(409, { error: 'a call is already running', live_session: live })).start('x', []);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 409);
  assert.deepEqual(r.ok === false && r.conflict, live);
});

await test('a 401 says what the user must DO, not what the server returned', async () => {
  const r = await apiOver(reply(401, { error: 'invalid or expired token' })).me();
  assert.equal(r.ok === false && r.error, 'invalid or expired token');
  const bare = await apiOver(reply(401, {})).me();
  assert.match(bare.ok === false ? bare.error : '', /connect again/);
});

await test('an unreachable Nexus is a plain sentence, not a stack trace', async () => {
  const api = new NexusApi({
    baseUrl: 'https://nexus.biami.io', token: 't',
    fetcher: (() => Promise.reject(new Error('Failed to fetch'))) as unknown as typeof fetch,
  });
  const r = await api.me();
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /Could not reach Nexus/);
});

await test('a timeout says so', async () => {
  const err = new Error('t'); err.name = 'TimeoutError';
  const api = new NexusApi({
    baseUrl: 'https://nexus.biami.io', token: 't',
    fetcher: (() => Promise.reject(err)) as unknown as typeof fetch,
  });
  const r = await api.me();
  assert.match(r.ok === false ? r.error : '', /did not answer in time/);
});

await test('history and checklists unwrap to plain arrays, empty when absent', async () => {
  const h = await apiOver(reply(200, { sessions: [{ meeting_id: 1 }] })).history();
  assert.equal(h.ok && h.value.length, 1);
  const empty = await apiOver(reply(200, {})).history();
  assert.deepEqual(empty.ok && empty.value, []);
  const c = await apiOver(reply(200, { checklists: [{ key: 'cl_1' }] })).checklists();
  assert.equal(c.ok && c.value.length, 1);
});

await test('a non-JSON error body still produces a usable message', async () => {
  const api = new NexusApi({
    baseUrl: 'https://nexus.biami.io', token: 't',
    fetcher: (() => Promise.resolve({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' } as Response)) as unknown as typeof fetch,
  });
  const r = await api.me();
  assert.equal(r.ok === false && r.error, 'Nexus returned 502');
});

console.log(`\n${passed} passed`);
