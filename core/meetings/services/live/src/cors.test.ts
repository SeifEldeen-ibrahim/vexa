/** The guard for a failure that is silent on this side and fatal on the other.
 *
 *  A route the HTTP layer answers with a method the CORS allow-list does not advertise works
 *  perfectly under curl and cannot work at all from the extension: Chrome rejects it at the
 *  preflight, the fetch throws, and the user is told to check their connection. So rather than
 *  restating the constant, this reads the ROUTE TABLE and demands every method it matches on be
 *  advertised — which is the thing that actually went wrong when templates added PUT and DELETE.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORS, CORS_METHODS } from './cors.js';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('cors.test.ts');

const httpSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'http.ts'), 'utf8');

test('every method the route table answers is advertised to the browser', () => {
  const matched = new Set(
    [...httpSource.matchAll(/method === '([A-Z]+)'/g)].map((m) => m[1]),
  );
  assert.ok(matched.size >= 4, `expected to find the route table's methods, found ${[...matched]}`);
  const advertised = new Set(CORS['Access-Control-Allow-Methods'].split(',').map((s) => s.trim()));
  for (const method of matched) {
    assert.ok(advertised.has(method), `${method} is answered by a route but missing from CORS`);
  }
});

test('a preflight is answerable at all — OPTIONS is advertised', () => {
  assert.ok(CORS['Access-Control-Allow-Methods'].includes('OPTIONS'));
});

test('the API key header the client sends is allowed', () => {
  const allowed = CORS['Access-Control-Allow-Headers'].toLowerCase();
  for (const header of ['x-api-key', 'authorization', 'content-type']) {
    assert.ok(allowed.includes(header), `${header} must be allowed`);
  }
});

test('the advertised list and the declared one cannot drift apart', () => {
  assert.equal(CORS['Access-Control-Allow-Methods'], CORS_METHODS.join(', '));
});

console.log(`\n${passed} passed`);
