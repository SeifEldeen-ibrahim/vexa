/**
 * How the STT prompt budget is spent.
 *
 * These exist because of a measured failure, not a hypothetical one: in a live meeting 48 of 73
 * STT calls carried NO prompt, and every mangled product name landed in that group — "Baratik",
 * "Paratic", "Barathek Bible" for Partic, "Claview" for Klaviyo. The calls that did carry context
 * got "Klaviyo" and "PostgreSQL" right.
 *
 * The rules that matter are about what survives when the budget runs out.
 */
import { strict as assert } from 'node:assert';
import {
  STT_PROMPT_CHAR_BUDGET,
  buildSttPrompt,
  isVocabularyEcho,
  parseVocabulary,
  vocabularyPrompt,
} from './prompt.js';

let failures = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

console.log('stt prompt budget');

// ── the vocabulary is the part that cannot be re-derived ──────────────────────────────────

test('the vocabulary is kept when the conversation has to be dropped entirely', () => {
  const vocab = vocabularyPrompt(['Partic', 'Klaviyo', 'Vexa']);
  const out = buildSttPrompt(vocab, 'x'.repeat(5000), 100);
  assert.ok(out!.includes('Partic'), out);
  assert.ok(out!.includes('Klaviyo'), out);
  assert.ok(out!.length <= 100, `${out!.length} > 100`);
});

test('the vocabulary comes FIRST — Whisper drops the beginning when it overflows', () => {
  const out = buildSttPrompt(vocabularyPrompt(['Partic']), 'we were discussing the weather');
  assert.ok(out!.indexOf('Partic') < out!.indexOf('weather'), out);
});

test('an oversized vocabulary is itself trimmed rather than blowing the budget', () => {
  const out = buildSttPrompt('z'.repeat(500), undefined, 100);
  assert.ok(out!.length <= 100, `${out!.length} > 100`);
});

// ── the conversation: newest wins, cut on a word boundary ─────────────────────────────────

test('the RECENT end of the conversation is kept, not the old one', () => {
  const ctx = 'the first thing said a long time ago. the thing just said now.';
  const out = buildSttPrompt(undefined, ctx, 30);
  assert.ok(out!.includes('just said now'), out);
  assert.ok(!out!.includes('first thing'), out);
});

test('a trim lands on a word boundary — never mid-word', () => {
  // A half-word in the prompt is a word the model is invited to complete.
  const out = buildSttPrompt(undefined, 'alpha bravo charlie delta echo', 12);
  assert.ok(!/^[a-z]/.test(out!) || 'alpha bravo charlie delta echo'.split(' ').includes(out!.split(' ')[0]), out);
  assert.equal(out, 'delta echo');
});

test('context that already fits is passed through whole', () => {
  assert.equal(buildSttPrompt(undefined, '  Partic is an ETL.  '), 'Partic is an ETL.');
});

// ── nothing to say ────────────────────────────────────────────────────────────────────────

test('no vocabulary and no context sends NO prompt at all', () => {
  assert.equal(buildSttPrompt(undefined, undefined), undefined);
  assert.equal(buildSttPrompt('', '   '), undefined);
});

test('vocabulary alone is a valid prompt — the 66% case that was sending nothing', () => {
  const out = buildSttPrompt(vocabularyPrompt(['Partic', 'Klaviyo']), '');
  assert.ok(out && out.includes('Partic') && out.includes('Klaviyo'), out);
});

test('context alone still works when no vocabulary is configured', () => {
  assert.equal(buildSttPrompt(undefined, 'Partic is an ETL.'), 'Partic is an ETL.');
});

// ── the operator's setting ────────────────────────────────────────────────────────────────

test('a vocabulary setting is split on commas and newlines', () => {
  assert.deepEqual(parseVocabulary('Partic, Klaviyo\nVexa , BIAMI'),
    ['Partic', 'Klaviyo', 'Vexa', 'BIAMI']);
});

test('stray separators cost one term, never the list', () => {
  assert.deepEqual(parseVocabulary('Partic,,  ,Klaviyo,'), ['Partic', 'Klaviyo']);
  assert.deepEqual(parseVocabulary(undefined), []);
  assert.deepEqual(parseVocabulary('   '), []);
});

test('the vocabulary is rendered as PROSE, not a bare CSV', () => {
  // Whisper conditions on text that looks like speech; a bare list is worth less than a sentence.
  const out = vocabularyPrompt(['Partic', 'Klaviyo']);
  assert.ok(/[A-Za-z].*:.*Partic, Klaviyo\.$/.test(out), out);
  assert.equal(vocabularyPrompt([]), '');
  assert.equal(vocabularyPrompt(['  ']), '');
});

test('the budget leaves room inside a real Whisper prompt window', () => {
  // ~224 tokens at ~4 chars/token. A budget that overflows silently drops the vocabulary, which is
  // the one thing this whole mechanism exists to deliver.
  assert.ok(STT_PROMPT_CHAR_BUDGET <= 896, String(STT_PROMPT_CHAR_BUDGET));
  const out = buildSttPrompt(vocabularyPrompt(['Partic']), 'word '.repeat(1000));
  assert.ok(out!.length <= STT_PROMPT_CHAR_BUDGET, String(out!.length));
});

// ── the model transcribing the PROMPT instead of the audio ────────────────────────────────

const TERMS = ['Partic', 'Klaviyo', 'Vexa', 'BIAMI', 'Matrix', 'ContentMorph', '10x Factory', 'PostgreSQL'];

test('the measured echo is caught', () => {
  // Verbatim from a 1.8-second near-silent window on a real tape.
  assert.equal(isVocabularyEcho(
    'Take Klaviyo, Vexa, BIAMI, Matrix, ContentMorph, 10x Factory, PostgreSQL, ETL, pipeline.', TERMS), true);
});

test('the prompt sentence itself is caught', () => {
  assert.equal(isVocabularyEcho(vocabularyPrompt(TERMS), TERMS), true);
});

test('REAL speech about the products is NOT caught', () => {
  // The whole point of the vocabulary is that these come out right — dropping them would make the
  // guard worse than the bug.
  for (const said of [
    'Partic is an ETL that moves data from one place to another place.',
    'The Partic pipeline will move the data from Klaviyo to PostgreSQL.',
    'So we can ask Vexa to build us this pipeline.',
    'Take Klaviyo as a source and migrate all your data into a PostgreSQL table called customers.',
  ]) assert.equal(isVocabularyEcho(said, TERMS), false, said);
});

test('a genuine short mention is left to the other filters', () => {
  assert.equal(isVocabularyEcho('Partic.', TERMS), false);
  assert.equal(isVocabularyEcho('Partic and Klaviyo.', TERMS), false);
});

test('two names in a row is not enough — three distinct is the bar', () => {
  assert.equal(isVocabularyEcho('Klaviyo, PostgreSQL.', TERMS), false);
  assert.equal(isVocabularyEcho('Klaviyo, PostgreSQL, Partic.', TERMS), true);
});

test('with no vocabulary configured nothing is ever an echo', () => {
  assert.equal(isVocabularyEcho('Klaviyo, PostgreSQL, Partic, Vexa.', []), false);
});

test('ordinary conversation is untouched', () => {
  assert.equal(isVocabularyEcho('Thank you.', TERMS), false);
  assert.equal(isVocabularyEcho('Can you hear me? I think the audio is breaking up.', TERMS), false);
});

if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('  all green');
