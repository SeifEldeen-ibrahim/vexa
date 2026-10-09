/**
 * handover.ts — the calls a dying process leaves behind for the next one.
 *
 * A session lives in memory, so when this process goes away the call it was holding has to be
 * SOMEBODY's problem. There are only two honest outcomes, and the difference matters to whoever
 * is still talking in the room:
 *
 *   • the next process picks it up (resumeSession, driven by the extension's own reconnect) — the
 *     transcript continues, one meeting, a gap of seconds;
 *   • nobody picks it up, and the meeting has to be FINALIZED, or the row stays `active` forever
 *     and the lane is deliberately exempt from meeting-api's reconcile sweep, so nothing else
 *     would ever close it.
 *
 * This is the note that makes the second case possible. It is written on the way down, read on
 * the way up, and forgotten the moment a call is resumed — so a row left `active` outlives its
 * process by at most the idle timeout, exactly the promise the janitor already makes for a
 * browser that was closed mid-call.
 *
 * Deliberately redis, not memory: the point is to survive the process. Deliberately tiny — a
 * hash of {uid: json} — because a handover that needs its own schema is a handover that will be
 * wrong after the next change.
 */
import { log } from './log.js';

export const HANDOVER_KEY = 'nexus:live:handover';

export interface HandoverNote {
  uid: string;
  userId: number;
  meetingId: number;
  /** Wall-clock ms when the holding process let go. */
  at: number;
}

/** The two redis verbs this needs, injected so the store is provable without a server. */
export interface HandoverRedis {
  hSet(key: string, field: string, value: string): Promise<unknown>;
  hDel(key: string, field: string): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

export interface HandoverStore {
  /** Leave a note that this call is nobody's, as of `at`. */
  record(note: HandoverNote): Promise<void>;
  /** The call was picked up (or finalized) — the note is spent. */
  forget(uid: string): Promise<void>;
  /** Notes older than `ttlMs`: calls nobody came back for. */
  due(nowMs: number, ttlMs: number): Promise<HandoverNote[]>;
}

export function createHandoverStore(redis: HandoverRedis): HandoverStore {
  const parse = (raw: string): HandoverNote | null => {
    try {
      const n = JSON.parse(raw) as Partial<HandoverNote>;
      if (!n || typeof n.uid !== 'string' || !n.uid) return null;
      if (typeof n.userId !== 'number' || typeof n.meetingId !== 'number') return null;
      if (typeof n.at !== 'number' || !Number.isFinite(n.at)) return null;
      return { uid: n.uid, userId: n.userId, meetingId: n.meetingId, at: n.at };
    } catch {
      return null;
    }
  };

  return {
    async record(note) {
      // Never throw: this runs during shutdown, and a redis blink must not stop the process from
      // exiting — it only costs the next process its chance to tidy up.
      try {
        await redis.hSet(HANDOVER_KEY, note.uid, JSON.stringify(note));
      } catch (err) {
        log.warn('handover', `could not record ${note.uid}: ${(err as Error)?.message ?? err}`);
      }
    },

    async forget(uid) {
      try {
        await redis.hDel(HANDOVER_KEY, uid);
      } catch (err) {
        log.warn('handover', `could not forget ${uid}: ${(err as Error)?.message ?? err}`);
      }
    },

    async due(nowMs, ttlMs) {
      let all: Record<string, string> = {};
      try {
        all = (await redis.hGetAll(HANDOVER_KEY)) ?? {};
      } catch (err) {
        log.warn('handover', `could not read: ${(err as Error)?.message ?? err}`);
        return [];
      }
      const out: HandoverNote[] = [];
      for (const [uid, raw] of Object.entries(all)) {
        const note = parse(raw);
        if (!note) {
          // Unreadable note: drop it rather than keep failing on it forever.
          void this.forget(uid);
          continue;
        }
        if (nowMs - note.at >= ttlMs) out.push(note);
      }
      return out;
    },
  };
}
