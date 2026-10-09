/**
 * session.ts — one in-person call, from first frame to final tick.
 *
 * The shape of the lane:
 *
 *   extension mic ─► capture.v1 frames ─► ChunkedTranscriber (pyannote CUT-ONLY)
 *                                            │  turn closed → hosted Whisper
 *                                            ├─► segment sink ─► transcription_segments
 *                                            │                   (collector → Postgres → terminal)
 *                                            └─► coverage runner ─► the checklist ticks
 *
 * SPEAKER NAMES. There are none, and this is deliberate rather than unfinished. One microphone
 * in a room gives the segmenter speaker-CHANGE boundaries and nothing else — it does no
 * clustering, no embeddings, no voiceprints — so the honest label for every turn is "no idea who
 * said this". Publishing `seg_3` or "Speaker 3" would imply a third person; the lane publishes an
 * EMPTY speaker instead, the same convention the desktop host uses for an unattributed turn.
 *
 * TIME. Frame timestamps come from the browser's clock (`Date.now()` at capture). They are used
 * as-is for ordering inside the pipeline (the codec's contract), but every published segment is
 * stamped RELATIVE to the session's first frame, so a client with a skewed clock produces a
 * transcript that still starts at zero.
 */
import { ChunkedTranscriber, type ChunkSegment } from '@vexa/mixed-pipeline';
import type { TranscriptionResult } from '@vexa/transcribe-whisper';
import { agendaProgress, buildAgenda, type Agenda } from './agenda.js';
import type { Identity } from './auth.js';
import type { LiveConfig } from './config.js';
import { createCoverageRunner, type CoverageRunner } from './coverage.js';
import type { CompletionPort } from './llm.js';
import { log } from './log.js';
import type { MeetingsClient } from './meetings-client.js';
import { createSegmentSink, type RedisEgress, type Segment, type SegmentSink } from './segments.js';

export type Transcribe = (pcm: Float32Array, prompt?: string) => Promise<TranscriptionResult>;

export interface SessionDeps {
  cfg: LiveConfig;
  meetings: MeetingsClient;
  redis: RedisEgress;
  completion: CompletionPort;
  transcribe: Transcribe;
  now?: () => number;
  /** Injected for the suite; production uses the real pipeline. */
  makeTranscriber?: typeof ChunkedTranscriber.create;
}

export interface StartRequest {
  identity: Identity;
  title: string;
  agendaLines: string[] | string;
  language?: string;
}

/** What the extension polls while the call runs. */
export interface SessionSnapshot {
  session_uid: string;
  meeting_id: number;
  status: 'live' | 'ended';
  title: string;
  started_at: string;
  ended_at: string | null;
  elapsed_ms: number;
  agenda: Agenda;
  progress: ReturnType<typeof agendaProgress>;
  /** Observable health, so the extension can say "we are not hearing anything". */
  audio: { frames: number; seconds: number; last_frame_ms_ago: number | null };
  transcript_lines: number;
  coverage: { passes: number; changes: number; failures: number };
  /** Present when the lane itself is degraded (no STT configured, no model, …). */
  warnings: string[];
}

export interface LiveSession {
  readonly sessionUid: string;
  readonly meetingId: number;
  readonly userId: number;
  readonly startedAt: number;
  feedAudio(channel: number, pcm: Float32Array, tsMs: number): void;
  /** Transcript lines so far (newest last) — the extension shows the tail. */
  lines(limit?: number): Array<{ text: string; at: number }>;
  snapshot(): SessionSnapshot;
  tick(): Promise<void>;
  end(reason: string): Promise<SessionSnapshot>;
  readonly ended: boolean;
  lastFrameAt(): number | null;
}

const RECENT_LINES = 200;

export async function startSession(
  deps: SessionDeps,
  req: StartRequest,
  sessionUid: string,
): Promise<{ ok: true; session: LiveSession } | { ok: false; status: number; error: string }> {
  const now = deps.now ?? Date.now;
  const title = String(req.title ?? '').trim().slice(0, 512) || 'Live meeting';
  const agenda0 = buildAgenda(req.agendaLines ?? []);
  const warnings: string[] = [];
  if (!deps.cfg.stt.url || !deps.cfg.stt.token) {
    // Without STT there is no transcript and therefore nothing to mark off. Refuse at the door:
    // a session that records nothing is worse than a clear failure, because the user believes
    // their meeting is being captured.
    return { ok: false, status: 503, error: 'transcription is not configured on this deployment' };
  }

  // 1. Claim the meetings row FIRST. No row, no session: every segment needs its id.
  const created = await deps.meetings.createSession(req.identity.userId, sessionUid, {
    title,
    source: 'nexus-extension',
    agenda: agenda0,
    agenda_progress: agendaProgress(agenda0),
  });
  if (!created.ok) {
    return { ok: false, status: created.status === 503 ? 503 : 502, error: `could not start the meeting: ${created.error}` };
  }
  const meetingId = created.value.id;
  const startedAt = now();
  const startedWall = new Date(startedAt).toISOString();

  const sink: SegmentSink = createSegmentSink({
    redis: deps.redis,
    meetingId,
    nativeMeetingId: sessionUid,
    ownerUserId: req.identity.userId,
    onError: (err) => log.warn('session', `${sessionUid}: segment egress failed: ${(err as Error)?.message ?? err}`),
  });

  let agenda = agenda0;
  let coverage: CoverageRunner;
  const persistAgenda = async (next: Agenda): Promise<void> => {
    agenda = next;
    const r = await deps.meetings.patchSession(req.identity.userId, meetingId, {
      agenda: next,
      agenda_progress: agendaProgress(next),
    });
    if (!r.ok) log.warn('session', `${sessionUid}: could not persist the agenda: ${r.error}`);
  };

  coverage = createCoverageRunner({
    agenda: agenda0,
    completion: deps.completion,
    intervalMs: deps.cfg.coverageIntervalMs,
    windowChars: deps.cfg.coverageWindowChars,
    minNewChars: deps.cfg.coverageMinNewChars,
    elapsedMs: () => now() - startedAt,
    now,
    onChange: persistAgenda,
  });
  if (!deps.cfg.llm.url || !deps.cfg.llm.token) {
    warnings.push('agenda coverage is not configured — the checklist will not tick by itself');
  }

  // 2. The capture pipeline. One transcriber: one room, one mixed stream.
  let firstFrameTs: number | null = null;
  let frames = 0;
  let samples = 0;
  let lastFrameAt: number | null = null;
  const recent: Array<{ text: string; at: number }> = [];
  // The whole conversation, for the end-of-call review — `recent` is a capped tail for the panel
  // and cannot serve as the record. Bounded by config for the same reason the prompt is.
  let full = '';
  let totalLines = 0;
  let ended = false;

  const relSeconds = (tsMs: number): number => {
    if (firstFrameTs === null) return 0;
    return Math.max(0, (tsMs - firstFrameTs) / 1000);
  };

  const toSegment = (c: ChunkSegment, completed: boolean): Segment => {
    const start = relSeconds(c.startMs);
    const end = Math.max(start, relSeconds(c.endMs));
    return {
      segment_id: `${sessionUid}-${c.segmentId}`,
      // No speaker identity exists for a room mic — see the header note.
      speaker: '',
      text: c.text,
      start,
      end,
      language: c.language || null,
      completed,
      absolute_start_time: new Date(startedAt + start * 1000).toISOString(),
      absolute_end_time: new Date(startedAt + end * 1000).toISOString(),
    };
  };

  // RETRACT THE DRAFTS THAT DROPPED OUT. The pipeline republishes its pending tail as a
  // full-replace block, and a draft confirms under a DIFFERENT id (`turn:6:p0` → `turn:6:0`), so
  // nothing ever overwrites the draft row. Left alone, every sentence of the saved transcript
  // appears twice — once half-heard, once finished — which is exactly what the first real calls
  // produced. Diff the pending id set on each publish and withdraw whatever left it, the same
  // reconciliation the meeting bots do (bot/src/pipeline.ts). One turn is open at a time, so a
  // single set tracks the lane.
  let pendingIds = new Set<string>();
  const reconcilePending = (pending: readonly ChunkSegment[]): void => {
    const next = new Set(pending.map((c) => `${sessionUid}-${c.segmentId}`));
    const gone = [...pendingIds].filter((id) => !next.has(id));
    pendingIds = next;
    if (gone.length) void sink.retract(gone);
  };

  const emit = (confirmed: ChunkSegment[], pending: ChunkSegment[]): void => {
    for (const c of confirmed) {
      const text = (c.text || '').trim();
      void sink.publish(toSegment(c, true));
      if (!text) continue;
      totalLines++;
      recent.push({ text, at: Math.round(relSeconds(c.startMs) * 1000) });
      while (recent.length > RECENT_LINES) recent.shift();
      full = full ? `${full} ${text}` : text;
      if (full.length > deps.cfg.coverageReviewChars) full = full.slice(full.length - deps.cfg.coverageReviewChars);
      // Only CONFIRMED text is judged: a pending draft is rewritten as the speaker keeps
      // talking, and re-judging each revision would spend a model call per keystroke of speech.
      coverage.addText(text);
    }
    // Reconcile BEFORE publishing the survivors, so a draft that just confirmed is withdrawn
    // rather than orphaned, and a draft still in the block is never retracted-then-republished.
    reconcilePending(pending);
    for (const c of pending) {
      if ((c.text || '').trim()) void sink.publish(toSegment(c, false));
    }
  };

  const create = deps.makeTranscriber ?? ChunkedTranscriber.create;
  const transcriber = await create({
    language: req.language,
    transcribe: deps.transcribe,
    publish: (_speaker, confirmed, pending) => emit(confirmed, pending),
    publishPending: (_speaker, pending) => emit([], pending),
    // The turn's pending is gone (tail emptied, turn closed): withdraw it. The panel re-renders
    // from the snapshot and would forget it anyway — but the durable store would not.
    clearPending: () => { reconcilePending([]); },
    rename: (_old, _next, segs) => {
      // Nothing can be renamed in this lane (no identities), but a late re-publish of the same
      // ids is still the pipeline's way of correcting TEXT — forward it as confirmed.
      emit(segs, []);
    },
    log: (m) => log.debug('pipeline', `${sessionUid}: ${m}`),
    onError: (fault) => {
      const f = fault as { kind?: string; detail?: string; message?: string };
      log.warn('pipeline', `${sessionUid}: STT fault [${f?.kind ?? 'unknown'}] ${f?.detail ?? f?.message ?? ''}`);
    },
  });

  log.info('session', `${sessionUid}: started for user ${req.identity.userId} → meeting ${meetingId} (${agenda0.items.length} checklist items)`);

  // A judge that is being asked and is not answering looks exactly like a judge that has heard
  // nothing worth marking — and for the first real calls it WAS the second explanation, silently,
  // for a whole meeting (see llm.ts on the token budget). Say so instead: the panel shows
  // warnings, so a broken judge now costs a user one glance rather than a transcript read
  // afterwards and a shrug.
  const coverageWarnings = (): string[] => {
    const s = coverage.stats();
    if (s.failures >= 2 && s.failures * 2 >= s.passes) {
      return [`the agenda judge is not answering (${s.failures} of ${s.passes} passes) — the checklist may be behind`];
    }
    return [];
  };

  const snapshot = (): SessionSnapshot => ({
    session_uid: sessionUid,
    meeting_id: meetingId,
    status: ended ? 'ended' : 'live',
    title,
    started_at: startedWall,
    ended_at: ended ? new Date(now()).toISOString() : null,
    elapsed_ms: now() - startedAt,
    agenda,
    progress: agendaProgress(agenda),
    audio: {
      frames,
      seconds: Math.round(samples / 16000),
      last_frame_ms_ago: lastFrameAt === null ? null : now() - lastFrameAt,
    },
    transcript_lines: totalLines,
    coverage: {
      passes: coverage.stats().passes,
      changes: coverage.stats().changes,
      failures: coverage.stats().failures,
    },
    warnings: [...warnings, ...coverageWarnings()],
  });

  return {
    ok: true,
    session: {
      sessionUid,
      meetingId,
      userId: req.identity.userId,
      startedAt,
      get ended() { return ended; },
      lastFrameAt: () => lastFrameAt,

      feedAudio(_channel, pcm, tsMs) {
        if (ended) return;
        const ts = Number.isFinite(tsMs) ? tsMs : now();
        if (firstFrameTs === null) firstFrameTs = ts;
        frames++;
        samples += pcm.length;
        lastFrameAt = now();
        transcriber.feedAudio(pcm, ts);
      },

      lines(limit = 50) {
        return recent.slice(Math.max(0, recent.length - limit));
      },

      snapshot,

      async tick() {
        if (ended) return;
        await coverage.tick();
      },

      async end(reason) {
        if (ended) return snapshot();
        ended = true;
        log.info('session', `${sessionUid}: ending (${reason}) after ${Math.round((now() - startedAt) / 1000)}s, ${totalLines} lines`);
        // Let the pipeline finish the turn it is holding, so the last sentence of the meeting is
        // not lost — then judge the checklist one final time against it.
        try {
          await transcriber.settled();
        } catch (err) {
          log.warn('session', `${sessionUid}: pipeline did not settle: ${(err as Error)?.message ?? err}`);
        }
        try {
          await transcriber.dispose();
        } catch { /* disposing a dead pipeline is not an error worth surfacing */ }
        // Nothing may outlive the call as a draft: a pending tail the pipeline never got to
        // confirm would otherwise sit in the transcript forever, unmarked, as if it were speech.
        reconcilePending([]);
        try {
          await coverage.flush();
        } catch (err) {
          log.warn('session', `${sessionUid}: final coverage pass failed: ${(err as Error)?.message ?? err}`);
        }
        // Then judge the meeting WHOLE. Every live pass saw a window, so a point raised early and
        // answered late was never in one excerpt; this is the pass the stored record is worth.
        try {
          await coverage.review(full);
        } catch (err) {
          log.warn('session', `${sessionUid}: end-of-call review failed: ${(err as Error)?.message ?? err}`);
        }
        agenda = coverage.agenda();
        // The durable record: the agenda, its coverage, and how the call ended.
        await deps.meetings.patchSession(req.identity.userId, meetingId, {
          agenda,
          agenda_progress: agendaProgress(agenda),
          live_session: {
            ended_reason: reason,
            frames,
            audio_seconds: Math.round(samples / 16000),
            transcript_lines: totalLines,
            coverage: coverage.stats(),
          },
        });
        await sink.endSession();
        const endResult = await deps.meetings.endSession(req.identity.userId, meetingId);
        if (!endResult.ok) {
          log.warn('session', `${sessionUid}: could not mark the meeting completed: ${endResult.error}`);
        }
        return snapshot();
      },
    },
  };
}
