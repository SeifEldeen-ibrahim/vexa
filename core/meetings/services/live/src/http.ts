/**
 * http.ts — the REST surface the Chrome extension drives, as a PURE request handler.
 *
 * `handle()` takes a decoded request and returns a status + body, so the whole API is testable
 * with no socket, no redis and no browser. `main.ts` wraps it in node:http.
 *
 * Every route but `/health` authenticates the caller's Nexus API token through admin-api and acts
 * ONLY on that user's own sessions. The extension never sees another user's anything, and a
 * session uid is not a capability: it is checked against the caller's identity every time.
 */
import { agendaProgress } from './agenda.js';
import type { Authenticator } from './auth.js';
import { capabilities, type LiveConfig } from './config.js';
import { agendaOf, checklistsFromRows, titleOf } from './checklists.js';
import type { TemplatesClient } from './templates-client.js';
import { log } from './log.js';
import type { MeetingRow, MeetingsClient } from './meetings-client.js';
import type { SessionRegistry } from './registry.js';
import type { LiveSession, StartRequest } from './session.js';

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiDeps {
  cfg: LiveConfig;
  auth: Authenticator;
  meetings: MeetingsClient;
  /** The user's saved agenda templates, which admin-api owns (see templates-client.ts). */
  templates: TemplatesClient;
  registry: SessionRegistry;
  /** Injected so the HTTP layer never imports the pipeline (and the suite can fake a session). */
  startSession: (req: StartRequest, sessionUid: string) =>
    Promise<{ ok: true; session: LiveSession } | { ok: false; status: number; error: string }>;
  newSessionUid: () => string;
  now?: () => number;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const fail = (status: number, error: string): ApiResponse => json(status, { error });

/** Strip the public `/live` prefix (nginx may or may not strip it) and the trailing slash. */
export function normalizePath(raw: string): string {
  const path = (raw || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (path === '/live') return '/';
  return path.startsWith('/live/') ? path.slice('/live'.length) : path;
}

/** The agenda lines a start request may carry: an array of strings, or one textarea blob. */
function agendaLinesFrom(body: unknown): string[] | string | null {
  const b = (body ?? {}) as { agenda?: unknown; checklist?: unknown };
  const raw = b.agenda ?? b.checklist;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  return null;
}

export function createApi(deps: ApiDeps) {
  const now = deps.now ?? Date.now;

  /** The compact shape the History tab lists. */
  const historyRow = (row: MeetingRow) => {
    const agenda = agendaOf(row);
    return {
      meeting_id: row.id,
      session_uid: row.native_meeting_id,
      title: titleOf(row),
      status: row.status,
      started_at: row.start_time,
      ended_at: row.end_time,
      progress: agendaProgress(agenda),
      agenda,
    };
  };

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const path = normalizePath(req.path);
    const method = req.method.toUpperCase();

    // ── open: liveness + what this deployment can actually do ──
    if (method === 'GET' && path === '/health') {
      const caps = capabilities(deps.cfg);
      const ok = caps.identity && caps.stt;
      return json(ok ? 200 : 503, {
        ok,
        service: 'nexus-live',
        capabilities: caps,
        live_sessions: deps.registry.liveCount(),
      });
    }

    // ── everything below is the caller's own ──
    const { tokenFromHeaders } = await import('./auth.js');
    const token = tokenFromHeaders(req.headers);
    const authed = await deps.auth.validate(token);
    if (!authed.ok) return fail(authed.status, authed.error);
    const me = authed.identity;
    // Non-null past this point — validate() refuses an absent token. The `?? ''` keeps the type
    // honest without an unreachable branch, and the templates client answers 401 on an empty key.
    const callerToken = token ?? '';

    if (method === 'GET' && path === '/me') {
      const live = deps.registry.liveForUser(me.userId);
      return json(200, {
        user_id: me.userId,
        email: me.email,
        live_session: live ? live.snapshot() : null,
        capabilities: capabilities(deps.cfg),
      });
    }

    // ── start a call ──
    if (method === 'POST' && path === '/sessions') {
      const existing = deps.registry.liveForUser(me.userId);
      if (existing) {
        // Not an error the user must untangle: hand back the call they already have running.
        return json(409, {
          error: 'a call is already running',
          live_session: existing.snapshot(),
        });
      }
      const lines = agendaLinesFrom(req.body);
      const body = (req.body ?? {}) as { title?: unknown; language?: unknown };
      const started = await deps.startSession(
        {
          identity: me,
          title: typeof body.title === 'string' ? body.title : '',
          agendaLines: lines ?? [],
          language: typeof body.language === 'string' && body.language.trim() ? body.language.trim() : undefined,
        },
        deps.newSessionUid(),
      );
      if (!started.ok) return fail(started.status, started.error);
      deps.registry.add(started.session);
      const snapshot = started.session.snapshot();
      return json(201, {
        ...snapshot,
        // Everything the extension needs to open the audio socket.
        ingest: {
          url: deps.cfg.publicIngestUrl,
          session_uid: snapshot.session_uid,
          subprotocol_prefix: 'nexus-token.',
          sample_rate: 16000,
        },
      });
    }

    // ── the live call ──
    const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/transcript|\/end)?$/);
    if (sessionMatch) {
      const uid = decodeURIComponent(sessionMatch[1]);
      const tail = sessionMatch[2] ?? '';
      const session = deps.registry.byUid(uid);
      // A session this process is not holding may still be a finished call of the caller's —
      // fall through to the durable row rather than 404-ing something they can see in History.
      if (session && session.userId !== me.userId) return fail(404, 'no such session');

      if (method === 'GET' && !tail) {
        if (session) return json(200, session.snapshot());
        const rows = await deps.meetings.listSessions(me.userId, 200);
        if (!rows.ok) return fail(rows.status, rows.error);
        const row = rows.value.find((r) => r.native_meeting_id === uid);
        if (!row) return fail(404, 'no such session');
        return json(200, historyRow(row));
      }

      if (method === 'GET' && tail === '/transcript') {
        if (!session) return fail(404, 'no live transcript for this session');
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
        return json(200, { session_uid: uid, lines: session.lines(limit) });
      }

      if (method === 'POST' && tail === '/end') {
        if (!session) return fail(404, 'no such live session');
        const snapshot = await session.end('stopped by the user');
        return json(200, snapshot);
      }
    }

    // ── history + reusable checklists ──
    if (method === 'GET' && path === '/history') {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 200));
      const rows = await deps.meetings.listSessions(me.userId, limit);
      if (!rows.ok) return fail(rows.status, rows.error);
      const live = new Map(deps.registry.forUser(me.userId).map((s) => [s.sessionUid, s]));
      return json(200, {
        sessions: rows.value.map((row) => {
          const held = live.get(row.native_meeting_id);
          // A call running right now is shown from the LIVE session, which is ahead of the row.
          return held && !held.ended ? { ...historyRow(row), ...held.snapshot() } : historyRow(row);
        }),
      });
    }

    if (method === 'GET' && path === '/checklists') {
      const rows = await deps.meetings.listSessions(me.userId, 60);
      if (!rows.ok) return fail(rows.status, rows.error);
      return json(200, { checklists: checklistsFromRows(rows.value) });
    }

    // ── saved agenda templates ──
    // These are the named agendas a user keeps for a KIND of meeting, and they are NOT derived
    // from past calls the way /checklists is: the user writes them deliberately and edits them.
    // We hold none of it — each call forwards the caller's own token to admin-api, which owns
    // the user document (see templates-client.ts for why that matters).
    if (path === '/templates') {
      if (method === 'GET') {
        const listed = await deps.templates.list(callerToken);
        return listed.ok ? json(200, { templates: listed.value }) : fail(listed.status, listed.error);
      }
      // POST and PUT both mean "save this one", because the extension does not care whether the
      // template already existed — admin-api replaces by id and creates otherwise.
      if (method === 'PUT' || method === 'POST') {
        const body = (req.body ?? {}) as { template?: unknown; name?: unknown; items?: unknown };
        // Accept the template either wrapped or bare, so a caller can POST {name, items}.
        const template = body.template ?? (body.name === undefined ? null : { name: body.name, items: body.items, id: (body as { id?: unknown }).id });
        if (!template) return fail(400, 'a template is required');
        const saved = await deps.templates.save(callerToken, template);
        return saved.ok ? json(200, { templates: saved.value }) : fail(saved.status, saved.error);
      }
      return fail(405, 'method not allowed');
    }

    if (method === 'DELETE' && path.startsWith('/templates/')) {
      const id = decodeURIComponent(path.slice('/templates/'.length));
      if (!id) return fail(400, 'a template id is required');
      const removed = await deps.templates.remove(callerToken, id);
      return removed.ok ? json(200, { templates: removed.value }) : fail(removed.status, removed.error);
    }

    return fail(404, 'no such route');
  }

  /** The janitor: end sessions whose audio stopped arriving, and forget old ended ones.
   *  A browser that was closed mid-call never sends Stop — without this the meeting would stay
   *  `active` forever (and the in-person lane is deliberately exempt from the bot reconcile
   *  sweep, so nothing else would ever close it). */
  async function sweep(): Promise<void> {
    const t = now();
    for (const session of deps.registry.all()) {
      if (session.ended) continue;
      const last = session.lastFrameAt();
      const quietFor = last === null ? t - session.startedAt : t - last;
      if (quietFor >= deps.cfg.idleTimeoutMs) {
        log.info('sweep', `${session.sessionUid}: no audio for ${Math.round(quietFor / 1000)}s — finalizing`);
        try {
          await session.end('no audio (the capture stopped without saying goodbye)');
        } catch (err) {
          log.error('sweep', `${session.sessionUid}: finalize failed: ${(err as Error)?.message ?? err}`);
        }
        continue;
      }
      try {
        await session.tick();
      } catch (err) {
        log.warn('sweep', `${session.sessionUid}: coverage tick failed: ${(err as Error)?.message ?? err}`);
      }
    }
    deps.registry.prune(10 * 60 * 1000, t);
  }

  return { handle, sweep };
}
