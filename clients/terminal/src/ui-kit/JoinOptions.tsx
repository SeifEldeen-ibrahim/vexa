"use client";
/** The bot-name + language row shared by every "send a bot" composer.
 *
 *  Collapsed by default: the rail is quiet at rest by design, and the overwhelming case is "send
 *  the bot with what I used last time". The summary line is what makes the collapsed state honest —
 *  a user who forced German three weeks ago must be able to SEE that without opening anything,
 *  otherwise a silently-remembered language becomes a mystery-transcript bug report.
 */
import { useState } from "react";
import { AUTO_LANGUAGE, languageDisplayName } from "../surfaces/languages";
import { readJoinPrefs, writeJoinPrefs, effectiveBotName, type JoinPrefs } from "../surfaces/joinPrefs";
import { LanguageSelect } from "./LanguageSelect";

/** Read the stored prefs into component state. Call in a `useState` initializer — it touches
 *  localStorage, so it must not run during SSR render. */
export function initialJoinPrefs(): JoinPrefs {
  return typeof window === "undefined" ? { botName: "", language: AUTO_LANGUAGE } : readJoinPrefs();
}

export function JoinOptions({ prefs, onChange }: {
  prefs: JoinPrefs;
  onChange: (next: JoinPrefs) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<JoinPrefs>) => {
    const next = { ...prefs, ...patch };
    onChange(next);
    writeJoinPrefs(patch);
  };
  // The summary names the bot that will ACTUALLY join — the user's choice, else the deployment's.
  const summary = `${effectiveBotName()}${prefs.language !== AUTO_LANGUAGE ? ` · ${languageDisplayName(prefs.language)}` : ""}`;
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5, background: "transparent",
          border: "none", padding: "2px 0", fontSize: 11, color: "var(--t3)", cursor: "pointer",
        }}>
        <span aria-hidden="true" style={{ fontSize: 9 }}>{open ? "▾" : "▸"}</span>
        <span>Options</span>
        {!open && <span style={{ color: "var(--t2)" }}>· {summary}</span>}
      </button>
      {open && (
        <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
          {/* Empty is meaningful — it means "let the deployment name it" — so the placeholder shows
              which name that actually is rather than a generic hint. */}
          <input value={prefs.botName} onChange={(e) => set({ botName: e.target.value })}
            placeholder={effectiveBotName()} aria-label="Bot name"
            style={{
              flex: 1, minWidth: 0, background: "var(--panel)", border: "1px solid var(--line2)",
              borderRadius: 7, padding: "5px 8px", color: "var(--t1)", fontSize: 11.5, outline: "none",
            }} />
          <LanguageSelect value={prefs.language} onChange={(language) => set({ language })} />
        </div>
      )}
    </div>
  );
}
