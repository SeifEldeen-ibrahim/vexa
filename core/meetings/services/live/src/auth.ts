/**
 * auth.ts — who is on the other end of this WebSocket.
 *
 * The extension holds a Nexus API token (minted by the terminal's Google sign-in, exactly like
 * the terminal's own session token). This service does NOT have its own idea of identity: it asks
 * admin-api's internal oracle — `POST /internal/validate`, the same door the gateway uses — and
 * trusts nothing else. FAIL CLOSED everywhere: an unconfigured oracle, an unreachable one, or a
 * malformed answer all deny. The alternative to a closed failure here is streaming one person's
 * meeting into another person's history.
 *
 * Validated identities are cached briefly (`authCacheMs`). A live session re-checks nothing per
 * audio frame — the check happens at the handshake and on each REST call — so the cache exists to
 * keep the extension's polling off admin-api's DB, not to shortcut the handshake.
 */
import { log } from './log.js';

export interface Identity {
  userId: number;
  email: string;
  scopes: string[];
}

export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: number; error: string };

/** The one network call this module makes, injectable so the suite drives it offline. */
export type Fetcher = (url: string, init: RequestInit) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface AuthenticatorOptions {
  adminApiUrl: string;
  internalSecret: string;
  cacheMs: number;
  fetcher?: Fetcher;
  now?: () => number;
  /** Scope a token must carry to drive this lane. The terminal mints `bot,tx,browser`. */
  requiredScope?: string;
}

interface CacheEntry {
  at: number;
  result: AuthResult;
}

export interface Authenticator {
  validate(token: string | null | undefined): Promise<AuthResult>;
  /** Drop a token from the cache — used when a session's token is revoked mid-call. */
  forget(token: string): void;
}

const DENY = (status: number, error: string): AuthResult => ({ ok: false, status, error });

export function createAuthenticator(opts: AuthenticatorOptions): Authenticator {
  const now = opts.now ?? Date.now;
  const requiredScope = opts.requiredScope ?? 'tx';
  const cache = new Map<string, CacheEntry>();
  const fetcher: Fetcher = opts.fetcher
    ?? ((url, init) => fetch(url, init) as unknown as Promise<{ status: number; json(): Promise<unknown> }>);

  async function ask(token: string): Promise<AuthResult> {
    if (!opts.adminApiUrl || !opts.internalSecret) {
      // Never fall back to "trust the caller" — that is the whole point of failing closed.
      return DENY(503, 'identity is not configured (ADMIN_API_URL / INTERNAL_API_SECRET)');
    }
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await fetcher(`${opts.adminApiUrl}/internal/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': opts.internalSecret },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      log.warn('auth', `identity oracle unreachable: ${(err as Error)?.message ?? err}`);
      return DENY(503, 'identity service unavailable');
    }
    if (res.status === 401) return DENY(401, 'invalid or expired token');
    if (res.status === 403) return DENY(503, 'identity service rejected this service');
    if (res.status !== 200) return DENY(503, `identity service returned ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return DENY(502, 'identity service returned no identity');
    }
    const data = (body ?? {}) as { user_id?: unknown; email?: unknown; scopes?: unknown };
    const userId = Number(data.user_id);
    const email = typeof data.email === 'string' ? data.email : '';
    if (!Number.isInteger(userId) || userId <= 0 || !email) {
      return DENY(502, 'identity service returned no identity');
    }
    const scopes = Array.isArray(data.scopes) ? data.scopes.map((s) => String(s)) : [];
    // `legacy` is admin-api's marker for a pre-scopes token; it is all-powerful by construction.
    if (scopes.length && !scopes.includes('legacy') && !scopes.includes(requiredScope)) {
      return DENY(403, `token is missing the '${requiredScope}' scope`);
    }
    return { ok: true, identity: { userId, email, scopes } };
  }

  return {
    async validate(token) {
      const key = (token ?? '').trim();
      if (!key) return DENY(401, 'missing API key');
      const hit = cache.get(key);
      if (hit && now() - hit.at < opts.cacheMs) return hit.result;
      const result = await ask(key);
      // Only successes and settled denials are cached. A 503 (oracle down) is NOT a fact about
      // the token, so caching it would turn a blip into a minutes-long outage for a live call.
      if (result.ok || result.status === 401 || result.status === 403) {
        cache.set(key, { at: now(), result });
      }
      return result;
    },
    forget(token) {
      cache.delete((token ?? '').trim());
    },
  };
}

/**
 * Pull the API key off an incoming request. Three carriers, in order:
 *   • `X-API-Key` — the REST calls (and what the rest of the product uses);
 *   • `Authorization: Bearer …` — convenience for curl and for the extension's fetch;
 *   • the `Sec-WebSocket-Protocol` handshake header, `nexus-token.<key>` — the ONLY way a
 *     browser can authenticate a WebSocket, since `new WebSocket()` takes no headers. Preferred
 *     over `?token=`, which would land in every proxy access log.
 */
export function tokenFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
  const apiKey = one(headers['x-api-key']).trim();
  if (apiKey) return apiKey;
  const auth = one(headers.authorization).trim();
  if (/^bearer\s+/i.test(auth)) {
    const bearer = auth.replace(/^bearer\s+/i, '').trim();
    if (bearer) return bearer;
  }
  for (const proto of one(headers['sec-websocket-protocol']).split(',')) {
    const p = proto.trim();
    if (p.startsWith('nexus-token.')) {
      const tok = p.slice('nexus-token.'.length).trim();
      if (tok) return tok;
    }
  }
  return null;
}

/** The subprotocol the server must echo back, or the browser closes the socket at once. */
export const WS_SUBPROTOCOL_PREFIX = 'nexus-token.';
