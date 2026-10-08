/**
 * api.ts — the client for the Nexus live lane.
 *
 * Every call carries the extension's own API token as `X-API-Key`. The token was minted by the
 * terminal's Google sign-in (see ../../terminal/src/app/extension/connect) and is stored only in
 * this extension's local storage — never in sync storage, which would push it to every browser
 * the user is signed into.
 *
 * `fetch` is injected so the whole client is testable in node.
 */
import { LIVE_PREFIX } from './config.js';
import type {
  HistoryRow, Me, SavedChecklist, SessionSnapshot, StartedSession,
} from './types.js';

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; conflict?: SessionSnapshot };

export interface ApiOptions {
  baseUrl: string;
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class NexusApi {
  private readonly base: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ApiOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '')}${LIVE_PREFIX}`;
    this.token = opts.token;
    this.doFetch = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          'X-API-Key': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        error: timedOut ? 'Nexus did not answer in time' : 'Could not reach Nexus — check your connection',
      };
    }

    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const body = (parsed ?? {}) as { error?: unknown; live_session?: SessionSnapshot };
      const error = typeof body.error === 'string' && body.error
        ? body.error
        : res.status === 401
          ? 'Your Nexus connection expired — connect again'
          : `Nexus returned ${res.status}`;
      return { ok: false, status: res.status, error, conflict: body.live_session };
    }
    return { ok: true, value: parsed as T };
  }

  me(): Promise<ApiResult<Me>> {
    return this.call<Me>('GET', '/me');
  }

  /** Start a call. A 409 carries the call already running, so the caller can offer to resume. */
  start(title: string, agenda: string[]): Promise<ApiResult<StartedSession>> {
    return this.call<StartedSession>('POST', '/sessions', { title, agenda });
  }

  snapshot(uid: string): Promise<ApiResult<SessionSnapshot>> {
    return this.call<SessionSnapshot>('GET', `/sessions/${encodeURIComponent(uid)}`);
  }

  stop(uid: string): Promise<ApiResult<SessionSnapshot>> {
    return this.call<SessionSnapshot>('POST', `/sessions/${encodeURIComponent(uid)}/end`, {});
  }

  transcript(uid: string, limit = 40): Promise<ApiResult<{ lines: Array<{ text: string; at: number }> }>> {
    return this.call('GET', `/sessions/${encodeURIComponent(uid)}/transcript?limit=${limit}`);
  }

  async history(limit = 25): Promise<ApiResult<HistoryRow[]>> {
    const r = await this.call<{ sessions?: HistoryRow[] }>('GET', `/history?limit=${limit}`);
    return r.ok ? { ok: true, value: r.value?.sessions ?? [] } : r;
  }

  async checklists(): Promise<ApiResult<SavedChecklist[]>> {
    const r = await this.call<{ checklists?: SavedChecklist[] }>('GET', '/checklists');
    return r.ok ? { ok: true, value: r.value?.checklists ?? [] } : r;
  }
}
