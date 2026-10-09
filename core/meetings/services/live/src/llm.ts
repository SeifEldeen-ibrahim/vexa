/**
 * llm.ts — one completion call, over an OpenAI-compatible chat endpoint.
 *
 * Deliberately the smallest thing that works. The coverage evaluator needs prompt → text and
 * nothing else: no tools, no streaming, no sessions. The default endpoint is the SAME
 * OpenAI-compatible base that already serves this deployment's Whisper (Groq serves chat models
 * next to audio ones), so marking off an agenda needs no credential an operator hasn't already
 * configured. `NEXUS_LIVE_LLM_*` points it elsewhere when that is wanted.
 *
 * A failure here degrades ONE thing: the checklist stops advancing. It must never touch the
 * transcript, so every error is returned, never thrown.
 *
 * REASONING MODELS. The default judge (`openai/gpt-oss-120b`) thinks before it answers, and its
 * thinking is billed against the SAME completion budget as its answer. At the original 1024-token
 * cap a real 11-point agenda spent 1022 tokens reasoning, returned `finish_reason: "length"` and
 * an EMPTY content — which the caller could only read as "the model saw nothing move". That is
 * how a sales 1:1 whose every point was discussed came out 0-of-11 covered: the model never got
 * to speak. So this module does three things about it: it asks for LOW reasoning effort (the
 * judgement is a lookup in a transcript, not a puzzle — it cut reasoning from 1022 tokens to 321
 * and the call from 3.3s to 1.4s), it leaves room for the answer, and it reports a truncated or
 * empty reply as a FAILURE rather than as silence.
 */
import { log } from './log.js';

export interface CompletionPort {
  /** Prompt → text, or null when the model could not be reached. */
  complete(prompt: string): Promise<string | null>;
}

export interface HttpCompletionOptions {
  url: string;
  token: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** 0 by default: this is a judgement about what was said, not a creative task. */
  temperature?: number;
  /** Sent as `reasoning_effort` when set. Empty string omits the field entirely, for an
   *  endpoint that rejects parameters it does not know. */
  reasoningEffort?: string;
  fetcher?: typeof fetch;
}

/** `https://api.groq.com/openai` → `https://api.groq.com/openai/v1/chat/completions`. */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export function createHttpCompletion(opts: HttpCompletionOptions): CompletionPort {
  const url = chatCompletionsUrl(opts.url);
  const doFetch = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const effort = (opts.reasoningEffort ?? 'low').trim();

  return {
    async complete(prompt: string): Promise<string | null> {
      if (!url || !opts.token || !opts.model) {
        log.debug('llm', 'no completion endpoint configured — coverage stays manual');
        return null;
      }
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.token}`,
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: opts.maxTokens ?? 4096,
            temperature: opts.temperature ?? 0,
            ...(effort ? { reasoning_effort: effort } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200);
          // 429 is a quota, not a fault: the deployment is asking faster than its plan allows.
          // Naming it is the difference between "upgrade the endpoint" and "the judge is broken",
          // and the two look identical from the checklist's side.
          const why = res.status === 429
            ? `rate limited by the model endpoint (retry-after ${res.headers.get('retry-after') ?? '?'}s, `
              + `${res.headers.get('x-ratelimit-remaining-tokens') ?? '?'} of `
              + `${res.headers.get('x-ratelimit-limit-tokens') ?? '?'} tokens left this minute)`
            : `completion returned ${res.status}${body ? `: ${body}` : ''}`;
          log.warn('llm', why);
          return null;
        }
        const data = (await res.json()) as {
          choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
        };
        const choice = data?.choices?.[0];
        const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
        if (!content.trim()) {
          // An empty answer is NOT "nothing moved" — the caller cannot tell those apart, and
          // reading one as the other is what made a broken judge look like a cautious one.
          // `length` names the cause: the reply was cut off, almost always by reasoning tokens.
          log.warn('llm', `completion returned no content (finish_reason=${String(choice?.finish_reason ?? 'unknown')})`);
          return null;
        }
        return content;
      } catch (err) {
        log.warn('llm', `completion failed: ${(err as Error)?.message ?? err}`);
        return null;
      }
    },
  };
}

/** A port that always declines — what an unconfigured deployment gets. The checklist then simply
 *  never auto-ticks, which is honest; it does not pretend to have heard anything. */
export const noCompletion: CompletionPort = { async complete() { return null; } };
