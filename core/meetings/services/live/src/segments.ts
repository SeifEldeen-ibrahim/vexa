/**
 * segments.ts — transcript egress onto the EXISTING spine.
 *
 * This service invents no transport. It writes the same two legs the meeting bots write, in the
 * same shapes, so everything downstream treats an in-person call exactly like a bot's meeting:
 *
 *   1. STREAM  `transcription_segments`  — the durable feed meeting-api's collector drains into
 *      Postgres. Envelope: `{type:'transcription', meeting_id, native_meeting_id, owner_user_id,
 *      segments:[…]}`. The collector REQUIRES `meeting_id` + a `segments` LIST; a flat segment is
 *      silently dropped (ingest.py returns 0), which is the one mistake that produces a live
 *      meeting with a permanently empty transcript.
 *   2. PUB/SUB `tc:meeting:{id}:mutable` — the live channel the gateway's `/ws` forwards to the
 *      Nexus terminal, so a call in a room shows up live in the web UI too.
 *
 * At the end of the call a `session_end` envelope rides the SAME stream; the collector turns it
 * into the per-meeting marker the copilot worker and the terminal's SSE read to wrap a meeting up.
 *
 * The redis surface is injected (`xAdd` / `publish`), so the wire format is provable offline.
 */

/** A transcript.v1 segment, as the collector's `_coerce_segment` expects it. */
export interface Segment {
  segment_id: string;
  speaker: string;
  text: string;
  /** Seconds from the start of the call. */
  start: number;
  end: number;
  language?: string | null;
  completed: boolean;
  absolute_start_time?: string;
  absolute_end_time?: string;
}

/** The two redis verbs this module needs. */
export interface RedisEgress {
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}

export const TRANSCRIPTION_STREAM = 'transcription_segments';
export const mutableChannel = (meetingId: number | string): string => `tc:meeting:${meetingId}:mutable`;

export interface SegmentSinkOptions {
  redis: RedisEgress;
  meetingId: number;
  nativeMeetingId: string;
  ownerUserId: number;
  onError?: (err: unknown) => void;
}

export interface SegmentSink {
  publish(segment: Segment): Promise<void>;
  /** Withdraw drafts published earlier, by id.
   *
   *  The pipeline republishes its PENDING tail as a full-replace block, and a draft's id is not
   *  the id its text eventually confirms under (`turn:6:p0` → `turn:6:0`). The stream is
   *  append-only and the store upserts by id, so an id that drops out of the block is not
   *  replaced by anything — it stays in Postgres beside the confirmed line and the saved
   *  transcript reads every sentence twice, once half-finished. That is not cosmetic: it is the
   *  transcript the user reads, shares, and feeds to the copilot. The retraction is what deletes
   *  it, and it is the same envelope the meeting bots send (`transcript_retract` → the
   *  collector's `delete_segments`). */
  retract(segmentIds: readonly string[]): Promise<void>;
  endSession(): Promise<void>;
}

/**
 * Build the sink. Both legs are attempted for every segment; a failure on either is reported
 * through `onError` and swallowed, because losing one line of transcript must never tear down a
 * live capture — the audio keeps arriving whether or not redis blinked.
 */
export function createSegmentSink(opts: SegmentSinkOptions): SegmentSink {
  const { redis, meetingId, nativeMeetingId, ownerUserId } = opts;
  const channel = mutableChannel(meetingId);
  const report = (err: unknown) => opts.onError?.(err);

  return {
    async publish(segment) {
      const payload = JSON.stringify({
        type: 'transcription',
        meeting_id: meetingId,
        native_meeting_id: nativeMeetingId,
        owner_user_id: ownerUserId,
        segments: [segment],
      });
      try {
        await redis.xAdd(TRANSCRIPTION_STREAM, '*', { payload });
      } catch (err) {
        report(err);
      }
      try {
        await redis.publish(channel, JSON.stringify({ type: 'transcript', meeting: { id: meetingId }, segment }));
      } catch (err) {
        report(err);
      }
    },

    async retract(segmentIds) {
      const ids = [...new Set(segmentIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
      if (!ids.length) return;
      const payload = JSON.stringify({
        type: 'transcript_retract',
        meeting_id: meetingId,
        native_meeting_id: nativeMeetingId,
        segment_ids: ids,
      });
      try {
        await redis.xAdd(TRANSCRIPTION_STREAM, '*', { payload });
      } catch (err) {
        report(err);
      }
      try {
        await redis.publish(channel, JSON.stringify({
          type: 'transcript_retract', meeting: { id: meetingId }, segment_ids: ids,
        }));
      } catch (err) {
        report(err);
      }
    },

    async endSession() {
      const payload = JSON.stringify({
        type: 'session_end',
        meeting_id: meetingId,
        native_meeting_id: nativeMeetingId,
      });
      try {
        await redis.xAdd(TRANSCRIPTION_STREAM, '*', { payload });
      } catch (err) {
        report(err);
      }
    },
  };
}
