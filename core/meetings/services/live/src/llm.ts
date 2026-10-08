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
            max_tokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200);
          log.warn('llm', `completion returned ${res.status}${body ? `: ${body}` : ''}`);
          return null;
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = data?.choices?.[0]?.message?.content;
        return typeof content === 'string' ? content : null;
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
