/**
 * meetings-client.ts — this service's only write into the meetings domain.
 *
 * The in-person lane does NOT own meeting records; meeting-api does. We call its internal tier
 * (`/internal/live/sessions`, authenticated as the platform with INTERNAL_API_SECRET and naming
 * the owning user) to claim a row, to end it, and to persist the agenda onto it. Everything else
 * downstream — the collector persisting segments, the terminal's live view, history, the
 * post-meeting notes — then happens because the row exists and the segments carry its id.
 *
 * Every call is BOUNDED and typed: a meeting that cannot get a row must fail the session loudly
 * at start (the user is told "could not start"), never half-start and silently record nothing.
 */
import { log } from './log.js';

export interface MeetingRow {
  id: number;
  user_id: number;
  platform: string;
  native_meeting_id: string;
  status: string;
  start_time: string | null;
  end_time: string | null;
  data: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
}

export type MeetingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export interface MeetingsClientOptions {
  baseUrl: string;
  internalSecret: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface MeetingsClient {
  createSession(userId: number, sessionUid: string, data: Record<string, unknown>): Promise<MeetingsResult<MeetingRow>>;
  endSession(userId: number, meetingId: number): Promise<MeetingsResult<MeetingRow>>;
  patchSession(userId: number, meetingId: number, data: Record<string, unknown>): Promise<MeetingsResult<MeetingRow>>;
  getSession(userId: number, meetingId: number): Promise<MeetingsResult<MeetingRow>>;
  listSessions(userId: number, limit?: number): Promise<MeetingsResult<MeetingRow[]>>;
}

export function createMeetingsClient(opts: MeetingsClientOptions): MeetingsClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10000;
  const doFetch = opts.fetcher ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<MeetingsResult<T>> {
    if (!base || !opts.internalSecret) {
      return { ok: false, status: 503, error: 'meetings internal tier is not configured' };
    }
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.internalSecret}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 204) return { ok: true, value: undefined as T };
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { detail?: unknown };
          if (typeof parsed.detail === 'string') detail = parsed.detail;
        } catch { /* a non-JSON body is its own detail */ }
        return { ok: false, status: res.status, error: detail || `meeting-api returned ${res.status}` };
      }
      return { ok: true, value: (text ? JSON.parse(text) : null) as T };
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      log.warn('meetings', `${method} ${path} failed: ${e.message}`);
      return { ok: false, status: 503, error: timedOut ? 'meeting-api timed out' : 'meeting-api unreachable' };
    }
  }

  return {
    createSession: (userId, sessionUid, data) =>
      call<MeetingRow>('POST', '/internal/live/sessions', { user_id: userId, session_uid: sessionUid, data }),
    endSession: (userId, meetingId) =>
      call<MeetingRow>('POST', `/internal/live/sessions/${meetingId}/end`, { user_id: userId }),
    patchSession: (userId, meetingId, data) =>
      call<MeetingRow>('PATCH', `/internal/live/sessions/${meetingId}`, { user_id: userId, data }),
    getSession: (userId, meetingId) =>
      call<MeetingRow>('GET', `/internal/live/sessions/${meetingId}?user_id=${encodeURIComponent(String(userId))}`),
    async listSessions(userId, limit = 50) {
      const r = await call<{ sessions?: MeetingRow[] }>(
        'GET',
        `/internal/live/sessions?user_id=${encodeURIComponent(String(userId))}&limit=${encodeURIComponent(String(limit))}`,
      );
      if (!r.ok) return r;
      return { ok: true, value: Array.isArray(r.value?.sessions) ? r.value.sessions : [] };
    },
  };
}
