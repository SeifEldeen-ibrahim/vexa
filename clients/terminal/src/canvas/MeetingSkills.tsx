"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Which products this meeting is about.
 *
 * ONE control, not one per product. The header already carries a processing switch and two access
 * grants; five more identical pills would overflow the row and, worse, would teach that a pill means
 * very little — while two of these decide whether a commit can land in the owner's own repo. So the
 * button is a summary and the choosing happens in a popover.
 *
 * Nothing is on until someone turns it on. With none on, the copilot's prompt carries no product
 * vocabulary at all, so it cannot propose one — the control is turning knowledge ON, never turning
 * chatter off.
 *
 * A skill that needs a repo says so at the toggle. "Enabled" and "usable" are different states, and
 * the difference belongs here, where it can be fixed, rather than in the meeting where a proposal
 * would be made and then fail.
 */

export type SkillInfo = {
  id: string;
  label: string;
  repo_backed: boolean;
  pin_hint: string;
};

type SkillsState = {
  available: SkillInfo[];
  enabled: string[];
  missing_repo: string[];
};

// Products exposed by the picker. Uncomment an entry to show it again; the server
// retains every product and its saved meeting settings independently of this list.
const PICKER_PRODUCTS = new Set([
  "partic",
  "biami",
  "matrix",
  // "contentmorph",
  // "tenx",
]);

const EMPTY: SkillsState = { available: [], enabled: [], missing_repo: [] };

export function MeetingSkills({ meetingId, nativeId }: { meetingId: string; nativeId?: string }) {
  const [state, setState] = useState<SkillsState>(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  const query = `native_id=${encodeURIComponent(nativeId ?? meetingId)}&meeting_id=${encodeURIComponent(meetingId)}`;

  useEffect(() => {
    let live = true;
    void fetch(`/api/meeting/skills?${query}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setState({ available: d.available ?? [], enabled: d.enabled ?? [], missing_repo: d.missing_repo ?? [] }); })
      .catch(() => { /* leave it empty — never render a skill as on because a read failed */ });
    return () => { live = false; };
  }, [query]);

  // Close on an outside click. A popover that traps the pointer is worse than the pills it replaces.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (id: string, on: boolean) => {
    if (busy) return;
    setBusy(id);
    const previous = state.enabled;
    // Optimistic, then reconciled from the response — the server owns the set.
    setState((s) => ({ ...s, enabled: on ? [...s.enabled, id] : s.enabled.filter((x) => x !== id) }));
    void fetch("/api/meeting/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meeting_id: meetingId, native_id: nativeId ?? meetingId, skill: id, on }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("refused"))))
      .then((d) => setState((s) => ({ ...s, enabled: d.enabled ?? [], missing_repo: d.missing_repo ?? [] })))
      .catch(() => setState((s) => ({ ...s, enabled: previous })))
      .finally(() => setBusy(null));
  };

  const available = state.available.filter((s) => PICKER_PRODUCTS.has(s.id));
  if (!available.length) return null;

  const on = available.filter((s) => state.enabled.includes(s.id));
  const summary = on.length === 0 ? "no products"
    : on.length <= 2 ? on.map((s) => s.label).join(" · ")
    : `${on.length} products`;

  return (
    <div ref={box} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={on.length
          ? `@nexus can recognise and offer to build: ${on.map((s) => s.label).join(", ")}`
          : "@nexus knows about no products in this meeting, so it will not offer to build anything."}
        style={{
          display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
          background: on.length ? "var(--accent)" : "transparent",
          color: on.length ? "var(--on-accent)" : "var(--t2)",
          border: `1px solid ${on.length ? "var(--accent)" : "var(--line2)"}`,
          borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 600,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: on.length ? "var(--on-accent)" : "var(--t3)", flex: "none" }} />
        {`@nexus: ${summary}`}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30, width: 320,
            background: "var(--bg)", border: "1px solid var(--line2)", borderRadius: 10,
            padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          }}
        >
          <div style={{ fontSize: 11.5, color: "var(--t3)", marginBottom: 8, lineHeight: 1.45 }}>
            What @nexus can recognise and offer to build in this meeting. Off by default — it knows
            nothing about a product until you turn it on here.
          </div>
          {available.map((sk) => {
            const enabled = state.enabled.includes(sk.id);
            const needsRepo = enabled && state.missing_repo.includes(sk.id);
            return (
              <label
                key={sk.id}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 9, padding: "7px 4px",
                  cursor: busy ? "default" : "pointer", opacity: busy === sk.id ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={Boolean(busy)}
                  onChange={(e) => toggle(sk.id, e.target.checked)}
                  style={{ marginTop: 2, flex: "none" }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--t1)" }}>{sk.label}</span>
                  {needsRepo && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--warn, #b26a00)", marginTop: 2 }}>
                      Needs a repo — pin {sk.pin_hint} in Settings before it can build anything.
                    </span>
                  )}
                  {!needsRepo && !sk.repo_backed && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--t3)", marginTop: 2 }}>
                      Preview — it will describe the action, not perform it.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
