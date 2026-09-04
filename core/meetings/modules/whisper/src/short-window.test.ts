/**
 * P5 gate: a window below the shortest clip a backend will price is never put on the wire.
 * Hosted STT rejects it — Groq answers `400 "Audio file is too short. Minimum audio length is
 * 0.01 seconds."` — and a bad_request is non-retryable, so a run of slivers walks the meeting
 * into `stt_degraded` and ends the call. The adapter answers an empty result instead: there is
 * no speech in a sliver to return, and the pipeline treats it as it treats silence.
 * Run: npm test (chained)  or  npx tsx src/short-window.test.ts
 */
import { TranscriptionClient } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;
/** Replace global fetch with a 200 stub that COUNTS calls. */
function countingFetch(): () => number {
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ text: 'ok', language: 'en', duration: 0.1, segments: [] }), { status: 200 });
  };
  return () => calls;
}

async function run() {
  const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', sampleRate: 16000 });

  // 8 ms at 16 kHz — under every backend's floor.
  {
    const calls = countingFetch();
    const r = await client.transcribe(new Float32Array(128).fill(0.05), 'en');
    check('a sliver is never sent', calls() === 0, `${calls()} request(s) made`);
    check('a sliver returns an empty result, not a fault', r.text === '' && r.segments.length === 0,
      `text=${JSON.stringify(r.text)} segments=${r.segments.length}`);
  }

  // 0.1 s at 16 kHz — real audio, must still go.
  {
    const calls = countingFetch();
    await client.transcribe(new Float32Array(1600).fill(0.05), 'en');
    check('a real window is still sent', calls() === 1, `${calls()} request(s) made`);
  }

  globalThis.fetch = realFetch;
  console.log(failed === 0 ? '\n✅ short-window: all checks passed' : `\n❌ short-window: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
