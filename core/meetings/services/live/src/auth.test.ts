/** L2 — identity, driven over an injected oracle. The cases are the ways this can go wrong
 *  in a way nobody notices: failing OPEN, caching an outage, or accepting a stranger's token. */
import assert from 'node:assert/strict';
import { createAuthenticator, tokenFromHeaders } from './auth.js';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('auth.test.ts');

const oracle = (replies: Array<{ status: number; body?: unknown }>) => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return { status: reply.status, json: async () => reply.body ?? {} };
  };
  return { fetcher, calls, count: () => i };
};

const base = { adminApiUrl: 'http://admin-api:8001', internalSecret: 's3cret', cacheMs: 1000 };
const GOOD = { status: 200, body: { user_id: 7, email: 'a@b.c', scopes: ['bot', 'tx'] } };

await test('a valid token resolves to the user admin-api names', async () => {
  const o = oracle([GOOD]);
  const r = await createAuthenticator({ ...base, fetcher: o.fetcher }).validate('tok');
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.identity, { userId: 7, email: 'a@b.c', scopes: ['bot', 'tx'] });
  assert.equal(o.calls[0].url, 'http://admin-api:8001/internal/validate');
  assert.deepEqual(o.calls[0].body, { token: 'tok' });
});

await test('a 401 from the oracle denies', async () => {
  const r = await createAuthenticator({ ...base, fetcher: oracle([{ status: 401 }]).fetcher }).validate('tok');
  assert.deepEqual(r, { ok: false, status: 401, error: 'invalid or expired token' });
});

await test('an empty key never reaches the oracle', async () => {
  const o = oracle([GOOD]);
  const auth = createAuthenticator({ ...base, fetcher: o.fetcher });
  assert.equal((await auth.validate('')).ok, false);
  assert.equal((await auth.validate(null)).ok, false);
  assert.equal((await auth.validate('   ')).ok, false);
  assert.equal(o.count(), 0);
});

await test('an unconfigured oracle FAILS CLOSED instead of trusting the caller', async () => {
  const r = await createAuthenticator({ ...base, internalSecret: '', fetcher: oracle([GOOD]).fetcher }).validate('tok');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 503);
});

await test('an unreachable oracle denies rather than admitting', async () => {
  const fetcher = async () => { throw new Error('ECONNREFUSED'); };
  const r = await createAuthenticator({ ...base, fetcher }).validate('tok');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 503);
});

await test('a token without the required scope is refused', async () => {
  const o = oracle([{ status: 200, body: { user_id: 7, email: 'a@b.c', scopes: ['browser'] } }]);
  const r = await createAuthenticator({ ...base, fetcher: o.fetcher }).validate('tok');
  assert.equal(r.ok === false && r.status, 403);
});

await test('a legacy (pre-scopes) token is accepted', async () => {
  const o = oracle([{ status: 200, body: { user_id: 7, email: 'a@b.c', scopes: ['legacy'] } }]);
  assert.equal((await createAuthenticator({ ...base, fetcher: o.fetcher }).validate('tok')).ok, true);
});

await test('an identity with no user_id or no email is not an identity', async () => {
  for (const body of [{ email: 'a@b.c' }, { user_id: 7 }, { user_id: 0, email: 'a@b.c' }, {}]) {
    const r = await createAuthenticator({ ...base, fetcher: oracle([{ status: 200, body }]).fetcher }).validate('tok');
    assert.equal(r.ok, false, JSON.stringify(body));
  }
});

await test('a validated token is cached, and expires', async () => {
  const o = oracle([GOOD]);
  let clock = 1000;
  const auth = createAuthenticator({ ...base, fetcher: o.fetcher, now: () => clock });
  await auth.validate('tok');
  await auth.validate('tok');
  assert.equal(o.count(), 1, 'second call inside the window must not re-ask');
  clock += 1001;
  await auth.validate('tok');
  assert.equal(o.count(), 2, 'past the window it re-asks');
});

await test('an oracle OUTAGE is never cached — a blip must not become an outage', async () => {
  const fetcher = async () => { throw new Error('down'); };
  const o = { fetcher, n: 0 };
  let calls = 0;
  const auth = createAuthenticator({ ...base, fetcher: async (...a) => { calls++; return o.fetcher(...a as never); } });
  await auth.validate('tok');
  await auth.validate('tok');
  assert.equal(calls, 2);
});

await test('forget() drops a revoked token from the cache', async () => {
  const o = oracle([GOOD, { status: 401 }]);
  const auth = createAuthenticator({ ...base, fetcher: o.fetcher });
  assert.equal((await auth.validate('tok')).ok, true);
  auth.forget('tok');
  assert.equal((await auth.validate('tok')).ok, false);
});

// ── carriers ───────────────────────────────────────────────────────────────────────────────
await test('the API key is read from X-API-Key, Bearer, or the WS subprotocol', () => {
  assert.equal(tokenFromHeaders({ 'x-api-key': 'k1' }), 'k1');
  assert.equal(tokenFromHeaders({ authorization: 'Bearer k2' }), 'k2');
  assert.equal(tokenFromHeaders({ authorization: 'bearer   k3  ' }), 'k3');
  assert.equal(tokenFromHeaders({ 'sec-websocket-protocol': 'capture.v1, nexus-token.k4' }), 'k4');
  assert.equal(tokenFromHeaders({ 'x-api-key': 'k1', authorization: 'Bearer k2' }), 'k1', 'X-API-Key wins');
  assert.equal(tokenFromHeaders({}), null);
  assert.equal(tokenFromHeaders({ authorization: 'Bearer' }), null);
  assert.equal(tokenFromHeaders({ 'sec-websocket-protocol': 'nexus-token.' }), null);
});

console.log(`\n${passed} passed`);
