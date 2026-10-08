/**
 * registry.ts — the live sessions this process is holding.
 *
 * One microphone per person, so ONE live session per user: a second "Start" is a mistake (two
 * tabs, a forgotten call) and is answered with the session already running rather than a second
 * meeting quietly recording the same room. Ended sessions are kept briefly so the extension can
 * still read the final checklist after pressing Stop; the durable copy is on the meeting row.
 */
import type { LiveSession } from './session.js';

export interface SessionRegistry {
  add(session: LiveSession): void;
  byUid(uid: string): LiveSession | undefined;
  liveForUser(userId: number): LiveSession | undefined;
  forUser(userId: number): LiveSession[];
  all(): LiveSession[];
  liveCount(): number;
  /** Drop ended sessions older than `keepMs`. */
  prune(keepMs: number, now: number): number;
  remove(uid: string): void;
}

export function createRegistry(): SessionRegistry {
  const sessions = new Map<string, LiveSession>();
  const endedAt = new Map<string, number>();

  return {
    add(session) {
      sessions.set(session.sessionUid, session);
    },
    byUid(uid) {
      return sessions.get(uid);
    },
    liveForUser(userId) {
      for (const s of sessions.values()) if (s.userId === userId && !s.ended) return s;
      return undefined;
    },
    forUser(userId) {
      return [...sessions.values()].filter((s) => s.userId === userId);
    },
    all() {
      return [...sessions.values()];
    },
    liveCount() {
      return [...sessions.values()].filter((s) => !s.ended).length;
    },
    prune(keepMs, now) {
      let dropped = 0;
      for (const [uid, s] of sessions) {
        if (!s.ended) {
          endedAt.delete(uid);
          continue;
        }
        const since = endedAt.get(uid);
        if (since === undefined) {
          endedAt.set(uid, now);
          continue;
        }
        if (now - since >= keepMs) {
          sessions.delete(uid);
          endedAt.delete(uid);
          dropped++;
        }
      }
      return dropped;
    },
    remove(uid) {
      sessions.delete(uid);
      endedAt.delete(uid);
    },
  };
}
