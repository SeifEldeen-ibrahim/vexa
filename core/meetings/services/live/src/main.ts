/**
 * main.ts — the composition root of the Nexus live capture host.
 *
 * Two doors, one process:
 *   • HTTP  (`src/http.ts`)   — the extension's control plane: start, stop, poll, history.
 *   • WS    `/ingest`         — the audio: capture.v1 frames from the extension's microphone.
 *
 * Both sit behind nginx at `https://nexus.biami.io/live/…`, and both authenticate the SAME Nexus
 * API token the terminal's Google sign-in mints. Nothing else is exposed: the gateway, admin-api
 * and meeting-api all stay on the compose network.
 *
 * The WebSocket is where the authentication detail matters. A browser cannot set headers on
 * `new WebSocket()`, so the extension offers two subprotocols — `capture.v1` and
 * `nexus-token.<key>` — and we read the token out of the handshake and select `capture.v1` as
 * the negotiated protocol. The token therefore never appears in a URL (and so never in an access
 * log), and never in the response headers either.
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { createClient } from 'redis';
import { decodeAudioFrame } from '@vexa/capture-codec';
import { TranscriptionClient } from '@vexa/transcribe-whisper';
import { createAuthenticator, tokenFromHeaders } from './auth.js';
import { capabilities, loadConfig } from './config.js';
import { createApi, normalizePath } from './http.js';
import { createHttpCompletion, noCompletion } from './llm.js';
import { log, setLogLevel } from './log.js';
import { createMeetingsClient } from './meetings-client.js';
import { createRegistry } from './registry.js';
import { startSession, type SessionDeps } from './session.js';

const MAX_BODY_BYTES = 256 * 1024;
const SWEEP_INTERVAL_MS = 5000;

/** The headers the extension is allowed to send us. Same-origin rules do not apply to an
 *  extension, and this API carries no cookies — the bearer token is the whole authorization —
 *  so a permissive CORS policy here grants nothing a token holder does not already have. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'X-API-Key, Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Max-Age': '600',
};

async function readBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false };
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const caps = capabilities(cfg);
  log.info('boot', `nexus-live starting on :${cfg.port}`);
  log.info('boot', `capabilities — identity:${caps.identity} stt:${caps.stt} coverage:${caps.coverage}`);
  if (!caps.identity) log.error('boot', 'ADMIN_API_URL/INTERNAL_API_SECRET are unset: every request will be refused');
  if (!caps.stt) log.error('boot', 'TRANSCRIPTION_SERVICE_URL/_TOKEN are unset: no call can start');
  if (!caps.coverage) log.warn('boot', 'no completion endpoint: checklists will not tick by themselves');

  // ── dependencies ──
  const redisClient = createClient({ url: cfg.redisUrl });
  redisClient.on('error', (err: unknown) => log.warn('redis', `${(err as Error)?.message ?? err}`));
  await redisClient.connect().catch((err) => {
    // Not fatal at boot: segments would be lost, but the process should come up, report its
    // state on /health and recover when redis returns, rather than crash-loop behind nginx.
    log.error('redis', `initial connect failed: ${(err as Error)?.message ?? err}`);
  });
  const redis = {
    xAdd: (key: string, id: string, fields: Record<string, string>) => redisClient.xAdd(key, id, fields),
    publish: (channel: string, message: string) => redisClient.publish(channel, message),
  };

  const auth = createAuthenticator({
    adminApiUrl: cfg.adminApiUrl,
    internalSecret: cfg.internalSecret,
    cacheMs: cfg.authCacheMs,
  });
  const meetings = createMeetingsClient({
    baseUrl: cfg.meetingApiUrl,
    internalSecret: cfg.internalSecret,
  });
  const completion = caps.coverage
    ? createHttpCompletion({
        url: cfg.llm.url,
        token: cfg.llm.token,
        model: cfg.llm.model,
        maxTokens: cfg.llm.maxTokens,
      })
    : noCompletion;

  const stt = new TranscriptionClient({
    serviceUrl: cfg.stt.url || 'http://unconfigured',
    apiToken: cfg.stt.token || undefined,
    model: cfg.stt.model,
    sampleRate: 16000,
  });

  const sessionDeps: SessionDeps = {
    cfg,
    meetings,
    redis,
    completion,
    transcribe: (pcm, prompt) => stt.transcribe(pcm, undefined, prompt),
  };

  const registry = createRegistry();
  const api = createApi({
    cfg,
    auth,
    meetings,
    registry,
    startSession: (req, uid) => startSession(sessionDeps, req, uid),
    // The session uid is the meeting's native id. Opaque and unguessable: it names a meeting in
    // the user's history, and a guessable one would be an invitation to probe for other calls.
    newSessionUid: () => `nx-${randomUUID()}`,
  });

  // ── HTTP ──
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
      res.end(payload);
      const path = (req.url || '/').split('?')[0];
      log.debug('http', `${req.method} ${path} → ${status} (${Date.now() - started}ms)`);
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const body = await readBody(req);
      if (!body.ok) return send(400, { error: 'the request body must be JSON, and small' });
      const response = await api.handle({
        method: req.method || 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: body.value,
      });
      return send(response.status, response.body);
    } catch (err) {
      log.error('http', `unhandled: ${(err as Error)?.stack ?? err}`);
      return send(500, { error: 'internal error' });
    }
  });

  // ── the audio socket ──
  const wss = new WebSocketServer({
    noServer: true,
    // Never echo the token-bearing subprotocol back; pick the capture one when offered.
    handleProtocols: (protocols) => (protocols.has('capture.v1') ? 'capture.v1' : false),
    maxPayload: 4 * 1024 * 1024,
  });

  server.on('upgrade', async (req, socket, head) => {
    const refuse = (code: number, reason: string) => {
      log.warn('ingest', `handshake refused (${code} ${reason}) from ${req.socket.remoteAddress ?? '?'}`);
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (normalizePath(url.pathname) !== '/ingest') return refuse(404, 'Not Found');

      const token = tokenFromHeaders(req.headers as Record<string, string | string[] | undefined>);
      const authed = await auth.validate(token);
      if (!authed.ok) return refuse(authed.status === 401 ? 401 : 503, 'Unauthorized');

      const uid = (url.searchParams.get('session') || '').trim();
      const session = uid ? registry.byUid(uid) : undefined;
      // The session must exist, be the caller's, and still be running. A socket is an attachment
      // to a call that was STARTED over the control plane — never a way to create one.
      if (!session || session.userId !== authed.identity.userId || session.ended) {
        return refuse(404, 'Not Found');
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        attach(ws, session.sessionUid);
      });
    } catch (err) {
      log.error('ingest', `upgrade failed: ${(err as Error)?.message ?? err}`);
      refuse(500, 'Internal Server Error');
    }
  });

  function attach(ws: WebSocket, uid: string): void {
    let frames = 0;
    let dropped = 0;
    log.info('ingest', `${uid}: capture socket attached`);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const session = registry.byUid(uid);
      if (!session || session.ended) {
        ws.close(1000, 'session ended');
        return;
      }
      if (!isBinary) {
        // Text frames are the extension's events (active-speaker hints and the like). This lane
        // has no speaker identities to bind them to, so they are counted and ignored rather than
        // misapplied — see the note in session.ts.
        return;
      }
      const frame = decodeAudioFrame(data.buffer, data.byteOffset, data.byteLength);
      if (!frame) {
        dropped++;
        return;
      }
      frames++;
      session.feedAudio(frame.speakerIndex, frame.samples, frame.ts);
    });

    ws.on('close', () => {
      log.info('ingest', `${uid}: capture socket closed after ${frames} frames${dropped ? ` (${dropped} undecodable)` : ''}`);
      // NOT an end-of-call: a dropped socket reconnects, and ending the meeting here would turn
      // a lift-lobby wifi blip into a finished meeting. The janitor finalizes a session whose
      // audio really stopped (cfg.idleTimeoutMs).
    });

    ws.on('error', (err) => log.warn('ingest', `${uid}: socket error: ${err?.message ?? err}`));
  }

  // ── the janitor ──
  const sweep = setInterval(() => {
    api.sweep().catch((err) => log.error('sweep', `${(err as Error)?.message ?? err}`));
  }, SWEEP_INTERVAL_MS);

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  log.info('boot', `listening on :${cfg.port} (ingest at ${cfg.publicIngestUrl})`);

  // ── shutdown: finish the calls we are holding, so no meeting is left `active` forever ──
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info('shutdown', `${signal}: finalizing ${registry.liveCount()} live session(s)`);
    clearInterval(sweep);
    server.close();
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    await Promise.allSettled(
      registry.all().filter((s) => !s.ended).map((s) => s.end(`server shutting down (${signal})`)),
    );
    await redisClient.quit().catch(() => { /* already gone */ });
    log.info('shutdown', 'done');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only run when executed, so the suite can import the module.
if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  main().catch((err) => {
    log.error('boot', `failed to start: ${(err as Error)?.stack ?? err}`);
    process.exit(1);
  });
}
