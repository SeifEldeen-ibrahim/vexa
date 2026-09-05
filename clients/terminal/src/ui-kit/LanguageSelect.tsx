"use client";
/** A searchable language picker painted from the terminal's own tokens.
 *
 *  The 0.11 dashboard's picker was radix Popover + ScrollArea + cmdk. This tree carries none of
 *  those for a plain combobox, and a new dependency here would need a FINOS Category-A review
 *  (ADR-0004) for a dropdown — so this is built from the primitives already present, following
 *  ContextMenu.tsx's outside-click / Escape discipline.
 *
 *  Recents float to the top because a user forces the SAME language nearly every time; scrolling
 *  100 entries to re-pick "German" every meeting is the thing that makes a picker feel expensive.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUTO_LANGUAGE,
  WHISPER_LANGUAGE_CODES,
  WHISPER_LANGUAGE_NAMES,
  languageDisplayName,
} from "../surfaces/languages";
import { recentLanguages } from "../surfaces/joinPrefs";

const PANEL_W = 232;

export function LanguageSelect({ value, onChange, title }: {
  value: string;
  onChange: (code: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The ordered code list for the CURRENT query: auto first, then recents, then everything else.
  // With a query active the recents block is dropped — a search is an explicit "find me this one".
  const codes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const hits = WHISPER_LANGUAGE_CODES.filter(
        (c) => c.toLowerCase().includes(q) || WHISPER_LANGUAGE_NAMES[c].toLowerCase().includes(q),
      );
      return "auto-detect".includes(q) || "auto".startsWith(q) ? [AUTO_LANGUAGE, ...hits] : hits;
    }
    const recent = recentLanguages();
    const seen = new Set(recent);
    return [AUTO_LANGUAGE, ...recent, ...WHISPER_LANGUAGE_CODES.filter((c) => !seen.has(c))];
  }, [query, open]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const closeOutside = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  // Keep the highlighted row in view while arrowing through 100 entries.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const pick = (code: string) => { onChange(code); setOpen(false); setQuery(""); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setQuery(""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((i) => Math.min(i + 1, codes.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); if (codes[cursor]) pick(codes[cursor]); }
  };

  const forced = value !== AUTO_LANGUAGE;
  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "none" }}>
      <button type="button" title={title ?? "Transcription language"} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5, maxWidth: 150,
          background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 7,
          padding: "5px 8px", fontSize: 11.5, cursor: "pointer",
          color: forced ? "var(--t1)" : "var(--t3)",
        }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {languageDisplayName(value)}
        </span>
        <span aria-hidden="true" style={{ fontSize: 9, color: "var(--t3)" }}>▾</span>
      </button>
      {open && (
        <div role="listbox" aria-label="Transcription language"
          style={{
            position: "absolute", zIndex: 60, top: "calc(100% + 4px)", left: 0, width: PANEL_W,
            background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.35)", overflow: "hidden",
          }}>
          <div style={{ padding: 6, borderBottom: "1px solid var(--line2)" }}>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
              placeholder="Search languages…" aria-label="Search languages"
              style={{
                width: "100%", background: "var(--panel)", border: "1px solid var(--line2)",
                borderRadius: 6, padding: "5px 7px", color: "var(--t1)", fontSize: 11.5, outline: "none",
              }} />
          </div>
          <div ref={listRef} style={{ maxHeight: 244, overflowY: "auto", padding: 4 }}>
            {codes.length === 0 && (
              <div style={{ padding: "8px 8px", fontSize: 11.5, color: "var(--t3)" }}>No language matches that.</div>
            )}
            {codes.map((code, i) => (
              <button key={code} type="button" role="option" aria-selected={code === value} data-idx={i}
                onClick={() => pick(code)} onMouseEnter={() => setCursor(i)}
                style={{
                  display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left",
                  background: i === cursor ? "var(--panel)" : "transparent", border: "none",
                  borderRadius: 6, padding: "5px 7px", fontSize: 11.5, cursor: "pointer",
                  color: code === value ? "var(--t1)" : "var(--t2)",
                  fontWeight: code === value ? 600 : 400,
                }}>
                <span aria-hidden="true" style={{ width: 10, flex: "none", color: "var(--accent)" }}>
                  {code === value ? "✓" : ""}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {languageDisplayName(code)}
                </span>
                {code !== AUTO_LANGUAGE && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--t3)" }}>{code}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
