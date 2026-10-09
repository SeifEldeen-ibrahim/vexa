/**
 * coverage-replay.ts — replay a REAL captured meeting through the real coverage runner.
 *
 * The checklist's quality is a judgement, so it cannot be asserted in a unit test — but it can be
 * MEASURED, and it has to be, because every knob here (the prompt, the cadence, the window, the
 * final pass) trades precision against recall and the only honest way to pick is to run the thing
 * against a meeting a human has already labelled.
 *
 * What it replays is the live cadence exactly: confirmed segments are fed in transcript order, a
 * virtual clock advances to each segment's own timestamp, and `tick()` decides for itself when a
 * pass is due — so a knob that only looks good at infinite cadence cannot win here. It then runs
 * the end-of-call `flush()`, and finally the whole-meeting review `end()` does in production.
 *
 * It calls the REAL model, so it needs the deployment's credentials and it costs tokens:
 *
 *   set -a; . deploy/compose/.env; set +a
 *   NEXUS_LIVE_LLM_URL=$TRANSCRIPTION_SERVICE_URL NEXUS_LIVE_LLM_TOKEN=$TRANSCRIPTION_SERVICE_TOKEN \
 *     npx tsx eval/coverage-replay.ts [--model=openai/gpt-oss-120b] [--no-final] [--runs=3]
 *
 * Output is one line per agenda item (expected vs got) plus the exact-match score, so two
 * variants are compared by running it twice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agendaProgress, buildAgenda, type AgendaStatus } from '../src/agenda.js';
import { createCoverageRunner } from '../src/coverage.js';
import { createHttpCompletion, type CompletionPort } from '../src/llm.js';
import { loadConfig } from '../src/config.js';

interface Fixture {
  name: string;
  agenda: string[];
  expected: Record<string, AgendaStatus>;
  segments: Array<{ start: number; text: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback = ''): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The replay fires a meeting's worth of passes in seconds, which trips the endpoint's
 *  tokens-per-minute limit — and a 429 is indistinguishable from "the model saw nothing", so an
 *  unpaced run silently measures the rate limit instead of the prompt. Hold a floor between calls
 *  and retry a declined one once, slowly. Production needs neither: its passes are 20s apart. */
function paced(inner: CompletionPort, gapMs: number): CompletionPort {
  let last = 0;
  return {
    async complete(prompt) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const wait = last + gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        const reply = await inner.complete(prompt);
        if (reply !== null) return reply;
      }
      return null;
    },
  };
}

async function replay(fx: Fixture, model: string, withFinal: boolean) {
  const cfg = loadConfig();
  // A live pass can be LOST — a rate limit, a timeout, a truncated reply — and the end-of-call
  // review is the only thing that can recover what that pass would have marked. `--drop-rate`
  // is how that claim gets tested instead of asserted.
  const dropRate = Number(arg('drop-rate', '0')) || 0;
  let live = 0;
  const completion = paced(createHttpCompletion({
    url: cfg.llm.url, token: cfg.llm.token, model, maxTokens: cfg.llm.maxTokens,
    reasoningEffort: cfg.llm.reasoningEffort,
  }), Number(arg('gap-ms', '16000')) || 16000);
  const judge: CompletionPort = dropRate <= 0 ? completion : {
    async complete(prompt) {
      // Deterministic: drop every Nth LIVE pass. The review (a different frame) never drops.
      const isReview = /just ended/.test(prompt);
      if (!isReview && ++live % Math.max(2, Math.round(1 / dropRate)) !== 0) return null;
      return completion.complete(prompt);
    },
  };

  // Virtual clock: the runner's whole cadence is `now()`-driven, so driving it from the
  // transcript's own timestamps replays the real spacing without waiting four minutes.
  let clock = 0;
  const agenda0 = buildAgenda(fx.agenda);
  const runner = createCoverageRunner({
    agenda: agenda0,
    completion: judge,
    intervalMs: cfg.coverageIntervalMs,
    windowChars: Number(arg('window-chars', String(cfg.coverageWindowChars))) || cfg.coverageWindowChars,
    minNewChars: cfg.coverageMinNewChars,
    elapsedMs: () => clock,
    now: () => clock,
  });

  for (const seg of fx.segments) {
    clock = Math.round(seg.start * 1000);
    runner.addText(seg.text);
    await runner.tick();
  }
  await runner.flush();
  if (withFinal) await runner.review(fx.segments.map((s) => s.text).join(' '));

  const agenda = runner.agenda();
  let exact = 0;
  const rows = agenda.items.map((item) => {
    const want = fx.expected[item.id] ?? 'open';
    if (want === item.status) exact++;
    return { id: item.id, want, got: item.status, text: item.text, evidence: item.evidence ?? '' };
  });
  return { rows, exact, progress: agendaProgress(agenda), stats: runner.stats() };
}

const fx = JSON.parse(readFileSync(join(here, 'fixtures', `${arg('fixture', 'sales-1to1')}.json`), 'utf8')) as Fixture;
const model = arg('model', loadConfig().llm.model);
const withFinal = !flag('no-final');
const runs = Number(arg('runs', '1')) || 1;

console.log(`fixture ${fx.name} · ${fx.segments.length} segments · model ${model} · final pass ${withFinal ? 'on' : 'off'}`
  + ` · window ${arg('window-chars', String(loadConfig().coverageWindowChars))} chars`);
for (let r = 1; r <= runs; r++) {
  const out = await replay(fx, model, withFinal);
  console.log(`\n── run ${r} ─ ${out.progress.covered} covered · ${out.progress.touched} started · ${out.progress.open} not yet ` +
    `(passes ${out.stats.passes}, failures ${out.stats.failures}) → ${out.exact}/${out.rows.length} exact`);
  for (const row of out.rows) {
    const mark = row.want === row.got ? ' ' : '✗';
    console.log(`${mark} ${row.id.padEnd(4)} want ${row.want.padEnd(8)} got ${row.got.padEnd(8)} ${row.text.slice(0, 44).padEnd(46)}${row.evidence.slice(0, 60)}`);
  }
}
