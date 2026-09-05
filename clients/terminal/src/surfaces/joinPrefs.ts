/** Join preferences — the ONE place a `POST /bots` body is shaped.
 *
 *  Two knobs the 0.11 dashboard had and the terminal lost when `clients/dashboard` was dropped
 *  (deefda3b): the bot's display name, and a FORCED transcription language.
 *
 *  Why a shared builder and not four inline literals: the terminal grew four independent
 *  `fetch("/api/bots", …)` call sites, each spelling the body out by hand, and every one of them
 *  silently omitted `language`. A field that must be present at four sites to work is a field that
 *  will be missing at one of them. `joinBody` is the single producer — a new call site cannot drift
 *  because there is nothing left to spell.
 *
 *  `language` matters beyond parity: Whisper auto-detect is unreliable on the short windows the
 *  live pipeline sends, and forcing the code is the known fix. The terminal could not send it at
 *  all, so the fix was unreachable from the UI.
 *
 *  Storage is per-browser (`localStorage`). A server-persisted per-user default is deliberately NOT
 *  in scope here — it needs an admin-api prefs key, and this restores parity without one.
 *
 *  `bot_name` is OMITTED unless something actually chose it. That is load-bearing, not tidiness:
 *  #1259 made the terminal stop hardcoding `"Vexa"` precisely so the deployment's own
 *  `DEFAULT_BOT_NAME` (compose/helm/Lite, changeable with a restart) takes effect. Sending a
 *  client-side fallback on every join would silently re-break that knob. Precedence is therefore
 *  user's typed name → `NEXT_PUBLIC_DEFAULT_BOT_NAME` (a deliberate image bake-in) → send nothing
 *  and let meeting-api name the bot.
 */
import { AUTO_LANGUAGE, isLanguageCode } from "./languages";
import { defaultBotName } from "./defaultBotName";

const BOT_NAME_KEY = "vexa.join.botName";
const LANGUAGE_KEY = "vexa.join.language";
const RECENT_KEY = "vexa.join.recentLanguages";
const RECENT_MAX = 8;

/** What meeting-api falls back to when no `bot_name` is sent and the deployment sets no
 *  `DEFAULT_BOT_NAME`. Shown as PLACEHOLDER text only — never sent on the wire. */
export const FALLBACK_BOT_NAME = "Vexa";

/** `botName: ""` means "no client-side choice" — the deployment default wins. */
export type JoinPrefs = { botName: string; language: string };

function readLocal(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private mode / blocked site data — prefs degrade to defaults, never throw
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the join still works, the choice just doesn't persist */
  }
}

/** The stored prefs. `botName` is "" when the user has typed none — NOT a fallback string, so the
 *  caller can tell "use the deployment default" from "the user chose the word Vexa". */
export function readJoinPrefs(): JoinPrefs {
  const lang = (readLocal(LANGUAGE_KEY) ?? "").trim();
  return {
    botName: (readLocal(BOT_NAME_KEY) ?? "").trim(),
    // An unknown/corrupt stored code falls back to auto rather than 400-ing the STT backend later.
    language: lang && isLanguageCode(lang) ? lang : AUTO_LANGUAGE,
  };
}

/** The name the bot will actually answer to, for DISPLAY (placeholder / summary line). Mirrors the
 *  wire precedence, with meeting-api's own fallback spelled out at the end. */
export function effectiveBotName(): string {
  return readJoinPrefs().botName || defaultBotName() || FALLBACK_BOT_NAME;
}

export function writeJoinPrefs(update: Partial<JoinPrefs>): void {
  if (update.botName !== undefined) writeLocal(BOT_NAME_KEY, update.botName.trim());
  if (update.language !== undefined && isLanguageCode(update.language)) {
    writeLocal(LANGUAGE_KEY, update.language);
    rememberLanguage(update.language);
  }
}

/** Most-recently-chosen real languages (never `auto`), newest first — the picker floats these to the top. */
export function recentLanguages(): string[] {
  const raw = readLocal(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string" && c !== AUTO_LANGUAGE && isLanguageCode(c)).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function rememberLanguage(code: string): void {
  if (code === AUTO_LANGUAGE) return;
  const next = [code, ...recentLanguages().filter((c) => c !== code)].slice(0, RECENT_MAX);
  writeLocal(RECENT_KEY, JSON.stringify(next));
}

/** The identity of the meeting to send a bot to — whatever the caller already parsed. */
export type JoinTarget = {
  platform: string;
  native_meeting_id: string;
  meeting_url?: string;
};

/** The `POST /bots` request body. BOTH optional keys are omitted rather than defaulted:
 *  `language` because meeting-api forwards the code straight to the STT backend (so `"auto"` would
 *  force a nonexistent language), and `bot_name` because omitting it is what lets the deployment's
 *  `DEFAULT_BOT_NAME` apply (#1259). */
export type JoinRequestBody = JoinTarget & { bot_name?: string; language?: string };

/** Shape ONE `POST /bots` body from a target plus the stored prefs. `overrides` lets a caller pin a
 *  value without touching what the user saved (the meeting-cookbook path does this). */
export function joinBody(target: JoinTarget, overrides?: Partial<JoinPrefs>): JoinRequestBody {
  const prefs = readJoinPrefs();
  // "" / undefined at every level ⇒ send no bot_name at all, so DEFAULT_BOT_NAME still rules.
  const botName = (overrides?.botName ?? prefs.botName ?? "").trim() || defaultBotName();
  const language = overrides?.language ?? prefs.language;
  return {
    platform: target.platform,
    native_meeting_id: target.native_meeting_id,
    ...(target.meeting_url ? { meeting_url: target.meeting_url } : {}),
    ...(botName ? { bot_name: botName } : {}),
    ...(language && language !== AUTO_LANGUAGE && isLanguageCode(language) ? { language } : {}),
  };
}
