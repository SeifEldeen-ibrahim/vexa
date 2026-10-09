/**
 * coverage.ts — the loop that moves the checklist.
 *
 * Confirmed transcript text arrives as the room talks; every `intervalMs` at most, and only when
 * there is NEW speech and at least one item still open, one completion call judges what moved.
 * Nothing here knows about redis, HTTP or audio — it is driven by `addText` / `tick`, so the
 * cadence is testable with a fake clock and a fake model.
 *
 * Three properties the design is built around:
 *   • NEVER more than one call in flight per session (`running`) — a slow model must not queue up
 *     a backlog of passes that then all land at once with stale windows;
 *   • a model failure is a no-op, not an error: the checklist simply does not advance;
 *   • the final `flush()` at the end of the call ignores the interval, so the last thing said in
 *     the meeting still gets a chance to tick its box.
 */
import {
  buildCoveragePrompt, buildReviewPrompt, mergeMarks, parseCoverageReply, type Agenda,
} from './agenda.js';
import type { CompletionPort } from './llm.js';
import { log } from './log.js';

export interface CoverageRunnerOptions {
  agenda: Agenda;
  completion: CompletionPort;
  /** Minimum gap between passes. */
  intervalMs: number;
  /** How much recent transcript each pass sees. */
  windowChars: number;
  /** Ms since the call started — stamped onto whatever the pass marks. */
  elapsedMs: () => number;
  now?: () => number;
  /** Called (awaited) whenever the agenda actually changed. */
  onChange?: (agenda: Agenda) => void | Promise<void>;
  /** Don't spend a call on a trickle: at least this much new text since the last pass. */
  minNewChars?: number;
}

export interface CoverageRunner {
  /** Record confirmed speech. Drafts must NOT come here — a pending draft is rewritten as the
   *  speaker keeps talking, and re-judging a half-sentence wastes a call per revision. */
  addText(text: string): void;
  /** Run a pass if one is due and worthwhile. Returns true when the agenda changed. */
  tick(): Promise<boolean>;
  /** End-of-call pass: due or not, as long as there is unjudged speech. */
  flush(): Promise<boolean>;
  /** The whole-meeting review, judged against `transcript` rather than the sliding window.
   *
   *  A live pass can only ever see a window, so a point raised early and settled late is never in
   *  one excerpt. This runs once, at the end, over the whole conversation. It can only RAISE a
   *  mark (`mergeMarks`), so a review that sees less than the live passes did cannot undo them.
   *
   *  Honestly: eval/ shows this pass changing nothing on the one real fixture there is, in any
   *  condition tested — because that meeting discusses each topic contiguously, inside a single
   *  window, so it cannot exercise what the review is for. Kept for the long wandering meeting it
   *  does address, at the price of one model call; see eval/README.md's "What is NOT proven". */
  review(transcript: string): Promise<boolean>;
  agenda(): Agenda;
  /** Diagnostics for /live/health and the session's log line. */
  stats(): { passes: number; changes: number; failures: number; pendingChars: number };
}

export function createCoverageRunner(opts: CoverageRunnerOptions): CoverageRunner {
  const now = opts.now ?? Date.now;
  const minNewChars = opts.minNewChars ?? 80;
  let agenda = opts.agenda;
  let window = '';
  let pendingChars = 0;
  let lastRunAt = 0;
  let running = false;
  let passes = 0;
  let changes = 0;
  let failures = 0;

  async function run(prompt: string | null): Promise<boolean> {
    if (!prompt) {
      pendingChars = 0;
      return false;
    }
    running = true;
    lastRunAt = now();
    const unjudged = pendingChars;
    pendingChars = 0;
    try {
      passes++;
      const reply = await opts.completion.complete(prompt);
      if (reply === null) {
        failures++;
        // The window was not judged. Put the new text back on the counter so the next tick
        // retries rather than quietly dropping the only speech that mentioned an item.
        pendingChars += unjudged;
        return false;
      }
      const marks = parseCoverageReply(reply);
      if (!marks.length) return false;
      const merged = mergeMarks(agenda, marks, opts.elapsedMs());
      if (!merged.changed) return false;
      agenda = merged.agenda;
      changes++;
      try {
        await opts.onChange?.(agenda);
      } catch (err) {
        log.warn('coverage', `onChange failed: ${(err as Error)?.message ?? err}`);
      }
      return true;
    } finally {
      running = false;
    }
  }

  return {
    addText(text) {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      window = `${window} ${clean}`.trim();
      if (window.length > opts.windowChars) {
        // Keep the TAIL: an item is marked by what was just said, and the window deliberately
        // overlaps the previous pass so a sentence split across two passes is still judged whole.
        window = window.slice(window.length - opts.windowChars);
      }
      pendingChars += clean.length + 1;
    },

    async tick() {
      if (running) return false;
      if (pendingChars < minNewChars) return false;
      if (now() - lastRunAt < opts.intervalMs) return false;
      return run(buildCoveragePrompt(agenda, window));
    },

    async flush() {
      if (running || pendingChars <= 0) return false;
      return run(buildCoveragePrompt(agenda, window));
    },

    async review(transcript) {
      if (running) return false;
      return run(buildReviewPrompt(agenda, transcript));
    },

    agenda: () => agenda,
    stats: () => ({ passes, changes, failures, pendingChars }),
  };
}
