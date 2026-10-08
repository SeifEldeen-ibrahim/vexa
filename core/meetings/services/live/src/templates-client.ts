/**
 * templates-client.ts — the user's saved agenda templates, which this service does NOT own.
 *
 * A template is per-PERSON data ("the agenda I use for a weekly standup"), so it lives in the
 * identity service's user document alongside their webhook and calendar settings, and admin-api
 * owns it. This client is a thin forwarder to admin-api's USER tier.
 *
 * The important property is what it does NOT need: no admin key, no internal secret, no
 * privilege of its own. It passes along the CALLER'S OWN API token, so admin-api resolves the
 * owner from that token and this service cannot read or write one user's templates while acting
 * for another — the ownership decision stays in the one service that owns users.
 */
import { log } from './log.js';

export interface AgendaTemplate {
  id: string;
  name: string;
  items: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export type TemplatesResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export interface TemplatesClientOptions {
  /** admin-api's base URL (loopback inside the stack). */
  baseUrl: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface TemplatesClient {
  list(token: string): Promise<TemplatesResult<AgendaTemplate[]>>;
  save(token: string, template: unknown): Promise<TemplatesResult<AgendaTemplate[]>>;
  remove(token: string, templateId: string): Promise<TemplatesResult<AgendaTemplate[]>>;
}

const PATH = '/user/live-templates';

export function createTemplatesClient(opts: TemplatesClientOptions): TemplatesClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10000;
  const doFetch = opts.fetcher ?? fetch;

  async function call(
    method: string,
    token: string,
    path: string,
    body?: unknown,
  ): Promise<TemplatesResult<AgendaTemplate[]>> {
    if (!base) return { ok: false, status: 503, error: 'templates are not available on this deployment' };
    if (!token) return { ok: false, status: 401, error: 'missing API key' };
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          // The caller's OWN key — never a privileged one.
          'X-API-Key': token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        // admin-api reports a rejected template as FastAPI's `detail`; pass the user's own words
        // of explanation through rather than inventing one.
        const detail = (parsed as { detail?: unknown })?.detail;
        const error = typeof detail === 'string' && detail ? detail : `templates service returned ${res.status}`;
        return { ok: false, status: res.status, error };
      }
      const list = (parsed as { templates?: unknown })?.templates;
      return { ok: true, value: Array.isArray(list) ? (list as AgendaTemplate[]) : [] };
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      log.warn('templates', `${method} ${path} failed: ${e.name || 'error'}`);
      return {
        ok: false,
        status: timedOut ? 504 : 502,
        error: timedOut ? 'the templates service did not answer in time' : 'could not reach the templates service',
      };
    }
  }

  return {
    list: (token) => call('GET', token, PATH),
    save: (token, template) => call('PUT', token, PATH, { template }),
    remove: (token, templateId) => call('DELETE', token, `${PATH}/${encodeURIComponent(templateId)}`),
  };
}
