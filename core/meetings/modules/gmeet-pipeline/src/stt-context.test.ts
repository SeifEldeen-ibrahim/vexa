/**
 * The STT CONTEXT WINDOW, measured from a live meeting.
 *
 * Whisper's `prompt` biases decoding toward the words it contains. The pipeline used to pass
 * `getLastConfirmedText(speakerId)` — the last confirmed line of the stream the audio arrived on.
 * Meet re-binds a stream per TURN, and a fresh stream's confirmed text is empty, so every pause
 * longer than a second sent NO context: on a real meeting 48 of 73 calls carried none, and every
 * mangled product name ("Baratik", "Paratic", "Barathek Bible", "Claview") landed in that group.
 *
 * A conversation does not restart when the speaker pauses. These pin that it no longer does.
 * Run: npx tsx src/stt-context.test.ts
 */
import { createGmeetPipeline, type TranscriptSink, type TranscriptionResult } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const said = (text: string): TranscriptionResult => ({
  text, language: 'en', duration: 1,
  segments: [{ start: 0, end: 1, text, avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.2 }],
});

const SILENT_SINK: TranscriptSink = { segment: () => {}, draft: () => {}, finalize: () => {} };
const ONE_SEC = () => new Float32Array(16000).fill(0.1);

/** Drive N turns, each on its OWN channel-turn key, and return the prompt seen on each call. */
async function promptsOverTurns(lines: string[], sameChannel = true): Promise<Array<string | undefined>> {
  const prompts: Array<string | undefined> = [];
  let n = 0;
  const pipe = createGmeetPipeline({
    transcribe: async (_pcm, prompt) => { prompts.push(prompt); return said(lines[Math.min(n++, lines.length - 1)]); },
    sink: SILENT_SINK,
    onsetGapMs: 1,          // any gap ends the turn → the next onset re-binds a NEW stream
  });
  for (let i = 0; i < lines.length; i++) {
    // A fresh channel-turn each time: the exact condition that used to blank the context.
    pipe.feedAudio(sameChannel ? 0 : i, `Speaker${sameChannel ? '' : i}`, ONE_SEC(), i * 5000);
    await pipe.flush();
  }
  await pipe.dispose();
  return prompts;
}

async function run() {
  // ── the fix: context survives the turn boundary ─────────────────────────────────────────
  {
    const prompts = await promptsOverTurns([
      'Partic is an ETL that moves data.',
      'Take Klaviyo as a source.',
      'And migrate it into PostgreSQL.',
    ]);
    check('the first window has no conversation yet (nothing has been said)', prompts[0] === undefined, JSON.stringify(prompts[0]));
    check('the SECOND turn carries what the first turn said — the 48-of-73 fix',
      !!prompts[1] && prompts[1]!.includes('Partic'), JSON.stringify(prompts[1]));
    check('context ACCUMULATES rather than replacing',
      !!prompts[2] && prompts[2]!.includes('Partic') && prompts[2]!.includes('Klaviyo'), JSON.stringify(prompts[2]));
  }

  // ── it is the MEETING's context, not one speaker's ──────────────────────────────────────
  {
    const prompts = await promptsOverTurns(['Partic is an ETL.', 'What does it connect to?'], false);
    check('a different speaker still hears what was said before them',
      !!prompts[1] && prompts[1]!.includes('Partic'), JSON.stringify(prompts[1]));
  }

  // ── it stays bounded ────────────────────────────────────────────────────────────────────
  {
    const lines = Array.from({ length: 40 }, (_, i) => `utterance number ${i} with several words in it.`);
    const prompts = await promptsOverTurns(lines);
    const last = prompts[prompts.length - 1] ?? '';
    check('a long meeting does not grow the prompt without limit', last.length < 4000, `${last.length} chars`);
    check('and what it keeps is the RECENT end', last.includes('number 38') || last.includes('number 37'), last.slice(-120));
  }

  // ── a repeat is not new context ─────────────────────────────────────────────────────────
  {
    const prompts = await promptsOverTurns(['Partic is an ETL.', 'Partic is an ETL.', 'Yes.']);
    const dupes = (prompts[2] ?? '').split('Partic is an ETL.').length - 1;
    check('a re-confirmation of the same text is not stacked twice', dupes === 1, JSON.stringify(prompts[2]));
  }

  if (failed) { console.error(`\n❌ stt-context: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ stt-context: the transcriber is given the MEETING\'s recent conversation, across turns and speakers, bounded.');
}
run().catch((e) => { console.error(e); process.exit(1); });
