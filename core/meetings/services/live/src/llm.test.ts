/** L2 — the completion port. Small surface, but it holds the mistake that made the whole coverage
 *  feature look broken for its first real meetings: a reasoning model that spent its entire token
 *  budget thinking returned an EMPTY answer, and an empty answer read as "nothing moved". */
import assert from 'node:assert/strict';
import { chatCompletionsUrl, createHttpCompletion } from './llm.js';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('llm.test.ts');

const reply = (body: unknown, ok = true): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

const port = (fetcher: typeof fetch, over: Record<string, unknown> = {}) =>
  createHttpCompletion({ url: 'https://api.groq.com/openai', token: 't', model: 'm', fetcher, ...over });

await test('a URL is completed to the chat endpoint, once', () => {
  assert.equal(chatCompletionsUrl('https://api.groq.com/openai'), 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://x/v1'), 'https://x/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://x/v1/chat/completions'), 'https://x/v1/chat/completions');
  assert.equal(chatCompletionsUrl(''), '');
});

await test('an answer comes back as text', async () => {
  const p = port(reply({ choices: [{ finish_reason: 'stop', message: { content: '{"marks":[]}' } }] }));
  assert.equal(await p.complete('judge this'), '{"marks":[]}');
});

/** THE BUG. gpt-oss-120b bills its thinking against `max_tokens`; on a real 11-point agenda it
 *  burned 1022 of 1024 on reasoning, stopped for `length`, and sent no content. Returning that as
 *  an empty string made it indistinguishable from a model that had read the transcript and found
 *  nothing — so the checklist silently stopped advancing and `failures` stayed at 0 all meeting. */
await test('a reply truncated by reasoning is a FAILURE, not silence', async () => {
  const p = port(reply({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
  assert.equal(await p.complete('judge this'), null);
});

await test('a whitespace-only or absent content is a failure too', async () => {
  assert.equal(await port(reply({ choices: [{ message: { content: '   ' } }] })).complete('x'), null);
  assert.equal(await port(reply({ choices: [{ message: {} }] })).complete('x'), null);
  assert.equal(await port(reply({ choices: [] })).complete('x'), null);
});

await test('low reasoning effort is asked for, and room is left for the answer', async () => {
  let body: Record<string, unknown> = {};
  const spy = (async (_u: unknown, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  }) as unknown as typeof fetch;
  await port(spy).complete('judge this');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, 0, 'a judgement is not a creative task');
});

await test('an endpoint that rejects reasoning_effort can have it omitted', async () => {
  let body: Record<string, unknown> = {};
  const spy = (async (_u: unknown, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  }) as unknown as typeof fetch;
  await port(spy, { reasoningEffort: '' }).complete('judge this');
  assert.ok(!('reasoning_effort' in body));
});

await test('a rate limit is named as a quota, not reported as a broken judge', async () => {
  const limited = (async () => new Response('{"error":{"message":"rate limit"}}', {
    status: 429,
    headers: { 'retry-after': '7', 'x-ratelimit-remaining-tokens': '12', 'x-ratelimit-limit-tokens': '8000' },
  })) as unknown as typeof fetch;
  const lines: string[] = [];
  const spy = console.error;   // log.warn writes to stderr
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    assert.equal(await port(limited).complete('x'), null);
  } finally {
    console.error = spy;
  }
  const said = lines.join(' ');
  assert.ok(/rate limited/.test(said), said);
  assert.ok(/retry-after 7s/.test(said), said);
  assert.ok(/12 of 8000 tokens left/.test(said), said);
});

await test('an unconfigured port, an HTTP error and a throw all decline quietly', async () => {
  assert.equal(await createHttpCompletion({ url: '', token: '', model: '' }).complete('x'), null);
  assert.equal(await port(reply({ error: 'nope' }, false)).complete('x'), null);
  assert.equal(await port((async () => { throw new Error('offline'); }) as unknown as typeof fetch).complete('x'), null);
});

console.log(`\n${passed} passed`);
