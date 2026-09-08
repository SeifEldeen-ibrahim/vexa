/**
 * prompt.ts — how the STT prompt budget is spent.
 *
 * Whisper accepts an optional `prompt`: text that biases decoding toward the words it contains. It
 * is the documented remedy for the one failure a general model cannot avoid — a name it has never
 * heard. Left empty, a live meeting produced "Baratik", "Paratic" and "Barathek Bible" for the same
 * spoken product, and "Claview" for Klaviyo.
 *
 * The window is roughly 224 tokens; past that the model DROPS the beginning, so what goes in and in
 * what order is the whole decision:
 *
 *   VOCABULARY FIRST. It is the part that cannot be re-derived from anything else in the system —
 *   nothing downstream can turn "Baratik" back into "Partic" — so it is the last thing to be given
 *   up, and it survives even when the conversation has to be trimmed to nothing.
 *
 *   THEN THE MOST RECENT CONVERSATION. Whisper is transcribing what comes NEXT, so the sentence
 *   just spoken is worth more than one from five minutes ago. When it does not fit, the OLD end is
 *   dropped and the trim lands on a word boundary — a half-word in the prompt is a word the model
 *   is being invited to complete.
 */

/** Characters of prompt to spend. ~224 tokens at ~4 chars/token, with room for a trailing period. */
export const STT_PROMPT_CHAR_BUDGET = 880;

/** Turns a vocabulary list into the sentence form Whisper biases best on: prose, not a CSV. The
 *  model conditions on text that looks like speech, so a bare comma list is worth less than a
 *  sentence containing the same words. */
export function vocabularyPrompt(terms: readonly string[]): string {
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  if (!clean.length) return '';
  return `The speakers use these names: ${clean.join(', ')}.`;
}

/** Split a comma/newline-separated vocabulary setting into terms. Deliberately permissive: this is
 *  operator input typed into an env var, and one stray comma must not cost the whole list. */
export function parseVocabulary(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Trim `text` to at most `limit` characters, KEEPING THE END and cutting at a word boundary. */
function keepTail(text: string, limit: number): string {
  if (limit <= 0) return '';
  const t = text.trim();
  if (t.length <= limit) return t;
  const tail = t.slice(t.length - limit);
  const space = tail.search(/\s/);
  return (space >= 0 ? tail.slice(space + 1) : tail).trim();
}

/**
 * Compose the prompt sent with one audio window: the vocabulary, then as much of the recent
 * conversation as still fits.
 *
 * Returns `undefined` when there is nothing worth sending, so a caller passes no prompt part at all
 * rather than an empty one.
 */
export function buildSttPrompt(
  vocabulary: string | undefined,
  context: string | undefined,
  limit: number = STT_PROMPT_CHAR_BUDGET,
): string | undefined {
  const vocab = (vocabulary ?? '').trim();
  const head = vocab.length > limit ? keepTail(vocab, limit) : vocab;
  const room = limit - head.length - (head ? 1 : 0);
  const tail = keepTail(context ?? '', room);
  const out = [head, tail].filter(Boolean).join(' ');
  return out || undefined;
}

/** Words too common to count as evidence of anything. */
const FILLER = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'take', 'use',
  'these', 'names', 'speakers', 'uses', 'used', 'with', 'for', 'on', 'at', 'by', 'it']);

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Did the model transcribe the PROMPT instead of the audio?
 *
 * Whisper conditions on the prompt, and on a window with little or no speech in it that
 * conditioning is the strongest signal present — so it emits the prompt back. Measured on a real
 * tape: a 1.8-second near-silent window answered "Take Klaviyo, Vexa, BIAMI, Matrix, ContentMorph,
 * 10x Factory, PostgreSQL, ETL, pipeline." That is a fabricated line, and it would be published
 * into a meeting transcript attributed to whoever's turn it was.
 *
 * The tell is not that the text contains the names — a real sentence about Partic does too — but
 * that it is almost NOTHING BUT the list: several terms, and hardly a word that is not one. A
 * genuine utterance carries its own words between them.
 */
export function isVocabularyEcho(text: string, terms: readonly string[]): boolean {
  const vocab = new Set(terms.flatMap((t) => words(t)));
  if (!vocab.size) return false;
  const said = words(text).filter((w) => !FILLER.has(w));
  if (said.length < 3) return false;                  // too short to tell; other filters own this
  const hits = said.filter((w) => vocab.has(w));
  const distinct = new Set(hits).size;
  // Three or more DISTINCT names, and the text is essentially just them.
  return distinct >= 3 && hits.length / said.length >= 0.7;
}
