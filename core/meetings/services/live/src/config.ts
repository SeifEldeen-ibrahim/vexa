/**
 * config.ts — every environment knob this service reads, resolved once, in one place.
 *
 * The lane deliberately re-uses credentials the deployment ALREADY has rather than asking an
 * operator for new ones:
 *   • STT is the same hosted Whisper the bots use (TRANSCRIPTION_SERVICE_*).
 *   • The coverage evaluator defaults to that SAME base URL and token — the Groq endpoint serves
 *     chat models next to Whisper on one OpenAI-compatible surface — so a deployment that can
 *     transcribe can also mark off an agenda, with nothing new to configure. NEXUS_LIVE_LLM_*
 *     overrides each field independently when the two should differ.
 *   • Identity is admin-api's internal oracle, exactly as the gateway uses it.
 */

export interface LiveConfig {
  port: number;
  /** Public WS URL handed back to the extension on session start (behind nginx). */
  publicIngestUrl: string;
  redisUrl: string;
  adminApiUrl: string;
  meetingApiUrl: string;
  internalSecret: string;
  stt: { url: string; token: string; model: string };
  llm: { url: string; token: string; model: string; maxTokens: number; reasoningEffort: string };
  /** How often the coverage evaluator may run, per session. */
  coverageIntervalMs: number;
  /** Transcript characters carried into each coverage pass (sliding window). */
  coverageWindowChars: number;
  /** New speech required before a pass is worth a model call (a "yeah" is not an agenda item). */
  coverageMinNewChars: number;
  /** Transcript carried into the ONE end-of-call review pass. Bigger than the live window on
   *  purpose — the review's whole point is to see the conversation whole — but still bounded,
   *  because the endpoint is rate-limited per minute and an unbounded prompt turns the last act
   *  of a long meeting into a 429. Past the bound the review reads the tail and the live passes
   *  carry the earlier part, which is where they work best anyway (one topic per window). */
  coverageReviewChars: number;
  /** A session with no audio for this long is finalized by the janitor. */
  idleTimeoutMs: number;
  /** How long a validated API key is trusted without re-asking admin-api. */
  authCacheMs: number;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): LiveConfig {
  const str = (key: string, fallback = ''): string => (env[key] ?? '').trim() || fallback;
  const num = (key: string, fallback: number): number => {
    const raw = Number.parseInt((env[key] ?? '').trim(), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const sttUrl = str('TRANSCRIPTION_SERVICE_URL');
  const sttToken = str('TRANSCRIPTION_SERVICE_TOKEN');
  return {
    port: num('NEXUS_LIVE_PORT', 8120),
    publicIngestUrl: str('NEXUS_LIVE_PUBLIC_INGEST_URL', 'wss://nexus.biami.io/live/ingest'),
    redisUrl: str('REDIS_URL', 'redis://redis:6379/0'),
    adminApiUrl: str('ADMIN_API_URL', 'http://admin-api:8001').replace(/\/+$/, ''),
    meetingApiUrl: str('MEETING_API_URL', 'http://meeting-api:8080').replace(/\/+$/, ''),
    internalSecret: str('INTERNAL_API_SECRET'),
    stt: {
      url: sttUrl,
      token: sttToken,
      model: str('TRANSCRIPTION_MODEL', 'whisper-1'),
    },
    llm: {
      // Same door as STT unless told otherwise — see the header note.
      url: str('NEXUS_LIVE_LLM_URL', sttUrl).replace(/\/+$/, ''),
      token: str('NEXUS_LIVE_LLM_TOKEN', sttToken),
      // The judgement model. gpt-oss-120b was chosen against the real prompt on this
      // deployment's endpoint: every candidate marked a settled item correctly and left an
      // untouched one alone, but only this one also obeyed "being introduced is not being
      // discussed" — it refused to tick an item that had merely been announced as the next
      // topic. A false tick is the expensive error here, so precision wins over the ~500ms
      // the smaller models save.
      model: str('NEXUS_LIVE_LLM_MODEL', 'openai/gpt-oss-120b'),
      // Room for the answer AFTER the model has finished thinking — see llm.ts's header for the
      // 1024-token cap that silently swallowed every judgement on a real agenda.
      maxTokens: num('NEXUS_LIVE_LLM_MAX_TOKENS', 2048),
      // 'low' unless overridden; '' omits the parameter for an endpoint that rejects it.
      reasoningEffort: (env.NEXUS_LIVE_LLM_REASONING_EFFORT ?? 'low').trim(),
    },
    coverageIntervalMs: num('NEXUS_LIVE_COVERAGE_INTERVAL_MS', 20000),
    coverageWindowChars: num('NEXUS_LIVE_COVERAGE_WINDOW_CHARS', 6000),
    coverageMinNewChars: num('NEXUS_LIVE_COVERAGE_MIN_NEW_CHARS', 80),
    coverageReviewChars: num('NEXUS_LIVE_COVERAGE_REVIEW_CHARS', 24000),
    idleTimeoutMs: num('NEXUS_LIVE_IDLE_TIMEOUT_MS', 10 * 60 * 1000),
    authCacheMs: num('NEXUS_LIVE_AUTH_CACHE_MS', 60000),
    logLevel: str('LOG_LEVEL', 'info'),
  };
}

/** What the service can and cannot do with the configuration it was given — reported by
 *  /live/health so a misconfigured deployment is visible instead of silently transcript-less. */
export function capabilities(cfg: LiveConfig): { identity: boolean; stt: boolean; coverage: boolean } {
  return {
    identity: !!(cfg.adminApiUrl && cfg.internalSecret),
    stt: !!(cfg.stt.url && cfg.stt.token),
    coverage: !!(cfg.llm.url && cfg.llm.token && cfg.llm.model),
  };
}
