"use client";
/** API tokens + GitHub token panels — the user's credential self-serve (list, mint, revoke; save-once
 *  PAT). These render inside the SETTINGS tab (surfaces/settings.tsx — the footer-gear surface,
 *  design-spec meeting-lifecycle-v2 W5); the old "API Tokens" activity-bar item is retired so
 *  integrator config leaves the daily-driver nav. All data flows through /api/tokens, which resolves
 *  the user server-side from the auth cookies — no user_id ever leaves this component (P20). The
 *  minted token value is shown ONCE (copy it now); it is never listed again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../ui-kit";
import { copyText } from "../ui-kit/ContextMenu";
import { listTokens, createToken, revokeToken, TOKEN_SCOPES, type TokenInfo, type TokenScope, type MintedToken } from "./tokensApi";
import { getGitToken, getSkillRepos, setGitToken, setSkillRepo,
  type GitRepoOption, type SavedGitToken, type SkillRepoState } from "./workspaceApi";
import { presentError } from "./apiClient";

const EXPIRIES: Array<{ label: string; seconds?: number }> = [
  { label: "never expires" },
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "30 days", seconds: 30 * 86400 },
  { label: "90 days", seconds: 90 * 86400 },
];

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);

// Scopes speak CAPABILITIES to the user (the raw scope id rides in the tooltip + the API).
const SCOPE_LABELS: Record<string, string> = { bot: "Join meetings", tx: "Read transcripts", browser: "Browse web" };
const scopeLabel = (s: string) => SCOPE_LABELS[s] ?? s;

function TokenRow({ token, onRevoke }: { token: TokenInfo; onRevoke: (id: number) => void }) {
  const [confirming, setConfirming] = useState(false);
  const created = fmtDate(token.created_at);
  const expires = fmtDate(token.expires_at);
  return (
    <div style={{ padding: "7px 9px", borderRadius: 6, display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--t2)" }}>
      <Icon name="key" size={13} />
      <div style={{ minWidth: 0, flex: 1, lineHeight: 1.3 }}>
        <div style={{ color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {token.name || `token #${token.id}`}
        </div>
        <div style={{ fontSize: 11, color: "var(--t3)" }}>
          {token.scopes.map(scopeLabel).join(" · ")}{created ? ` · created ${created}` : ""}{expires ? ` · expires ${expires}` : ""}
        </div>
      </div>
      {confirming ? (
        <>
          <button onClick={() => onRevoke(token.id)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 11.5, padding: 2 }}>revoke</button>
          <button onClick={() => setConfirming(false)} style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", fontSize: 11.5, padding: 2 }}>keep</button>
        </>
      ) : (
        <button title="Revoke token" onClick={() => setConfirming(true)} style={{ background: "none", border: "none", color: "var(--t3)", cursor: "pointer", display: "flex", padding: 2 }}>
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}

/** The one-time reveal: shown right after a mint, then gone forever (the list never carries the value). */
function MintedTokenCard({ minted, onDismiss }: { minted: MintedToken; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { copyText(minted.token); setCopied(true); };
  return (
    <div style={{ margin: "8px 4px", padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel2)" }}>
      <div style={{ fontSize: 11.5, color: "var(--t2)", marginBottom: 6 }}>
        Token created — copy it now, it will <b>not</b> be shown again.
      </div>
      <code style={{ display: "block", fontSize: 11, color: "var(--t1)", wordBreak: "break-all", marginBottom: 8 }}>{minted.token}</code>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={copy} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--t1)", cursor: "pointer" }}>
          <Icon name="copy" size={12} />{copied ? "copied" : "copy"}
        </button>
        <button onClick={onDismiss} style={{ fontSize: 11.5, padding: "3px 8px", borderRadius: 6, border: "none", background: "transparent", color: "var(--t3)", cursor: "pointer" }}>done</button>
      </div>
    </div>
  );
}

function CreateTokenForm({ onCreated }: { onCreated: (t: MintedToken) => void }) {
  const [scopes, setScopes] = useState<TokenScope[]>(["bot", "tx", "browser"]);
  const [name, setName] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (s: TokenScope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = async () => {
    if (scopes.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const minted = await createToken({ scopes, name: name.trim() || undefined, expiresIn: EXPIRIES[expiryIdx].seconds });
      setName("");
      onCreated(minted);
    } catch (e: unknown) {
      setError(presentError(e).headline);  // fail-loud (P18)
    } finally {
      setBusy(false);
    }
  };

  const field = { width: "100%", fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" } as const;
  return (
    <div style={{ margin: "4px 4px 10px", padding: 10, borderRadius: 8, border: "1px solid var(--line)" }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" style={{ ...field, marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
        {TOKEN_SCOPES.map((s) => (
          <label key={s} title={`scope: ${s}`} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--t2)", cursor: "pointer" }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />{scopeLabel(s)}
          </label>
        ))}
      </div>
      <select value={expiryIdx} onChange={(e) => setExpiryIdx(Number(e.target.value))} style={{ ...field, marginBottom: 8 }}>
        {EXPIRIES.map((e, i) => <option key={e.label} value={i}>{e.label}</option>)}
      </select>
      {error && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", marginBottom: 8 }}>⚠ {error}</div>}
      <button onClick={() => void submit()} disabled={busy || scopes.length === 0}
        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)", cursor: busy || scopes.length === 0 ? "default" : "pointer", opacity: busy || scopes.length === 0 ? 0.6 : 1 }}>
        <Icon name="plus" size={12} />{busy ? "creating…" : "Create token"}
      </button>
    </div>
  );
}

/** The SAVE-ONCE reusable GitHub token (git_credentials). Stored server-side; the clear value is never
 *  shown again (only a ••••abcd mask). Applied as the fallback credential for push / pull / publish /
 *  attach across ALL of the user's repos, so they don't re-enter it per repo. */
export function GitHubTokenCard({ onTokenChange }: { onTokenChange?: () => void } = {}) {
  const [state, setState] = useState<SavedGitToken | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void getGitToken().then((s) => { setState(s); setError(null); }).catch((e: unknown) => setError(presentError(e).headline));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const save = async () => {
    if (!value.trim() || busy) return;
    setBusy(true); setError(null);
    // Saving a token changes what OTHER cards can do — the repo picker below is dead without one
    // and cannot know on its own. Without this it kept saying "no GitHub token saved", with its
    // dropdown disabled, until a hard refresh.
    try { const s = await setGitToken(value.trim()); setState(s); setValue(""); setEditing(false); onTokenChange?.(); }
    catch (e: unknown) { setError(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setError(null);
    try { const s = await setGitToken(null); setState(s); setValue(""); setEditing(false); onTokenChange?.(); }
    catch (e: unknown) { setError(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const field = { width: "100%", fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" } as const;
  const btn = { fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)", cursor: "pointer" } as const;
  const showForm = editing || (state !== null && !state.set);

  return (
    <div style={{ margin: "4px 4px 14px", padding: 10, borderRadius: 8, border: "1px solid var(--line)" }}>
      <div style={{ fontSize: 12.5, color: "var(--t1)", marginBottom: 3 }}>GitHub token</div>
      <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.45, marginBottom: 9 }}>
        Saved once and reused for push · pull · publish · attach across all your repos. Stored server-side —
        never shown again. Use a fine-grained, minimally-scoped PAT you can revoke on GitHub anytime.
        For a product repo below it needs <strong>Contents: Read and write</strong> — a read-only token
        pins cleanly and then fails at push time, in the meeting, after someone has said yes.
      </div>
      {error && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", marginBottom: 8 }}>⚠ {error}</div>}
      {state?.set && !showForm && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="key" size={13} style={{ color: "var(--accent)" }} />
          <span style={{ flex: 1, fontSize: 12.5, color: "var(--t2)", fontFamily: "var(--mono)" }}>{state.masked}</span>
          <button disabled={busy} onClick={() => { setEditing(true); setValue(""); }} style={btn}>Replace</button>
          <button disabled={busy} onClick={() => void clear()} style={{ ...btn, color: "var(--danger)" }}>Clear</button>
        </div>
      )}
      {showForm && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input type="password" autoFocus value={value} placeholder="ghp_… (fine-grained PAT)" disabled={busy}
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { setEditing(false); setValue(""); } }} style={field} />
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy || !value.trim()} onClick={() => void save()} style={{ ...btn, background: "var(--accent)", color: "var(--on-accent)", border: "none", opacity: busy || !value.trim() ? 0.5 : 1 }}>{busy ? "Saving…" : "Save token"}</button>
            {state?.set && <button disabled={busy} onClick={() => { setEditing(false); setValue(""); }} style={btn}>Cancel</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A repo chooser that can be typed into.
 *
 *  A native <select> is fine for five options and unusable at a hundred, which is what a real
 *  GitHub account has — so this filters as you type. Type-ahead on a <select> only matches from the
 *  start of the string, and nobody remembers whether a repo is `vexa-vibe-pipe` or `vibe-pipe`;
 *  matching anywhere in `owner/name` is what makes it findable.
 *
 *  A repo the token cannot push to stays visible but unselectable, with the reason next to it. It
 *  matters that it is SHOWN: hiding it would read as "that repo is gone", and the person would go
 *  looking for the repo instead of at the token, which is where the problem is.
 */
function RepoPicker({ repos, value, disabled, placeholder, onPick }: {
  repos: GitRepoOption[];
  value: string;
  disabled?: boolean;
  placeholder: string;
  onPick: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  const current = repos.find((r) => r.url === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setQ(""); }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = needle ? repos.filter((r) => r.full_name.toLowerCase().includes(needle)) : repos;

  const field = { fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line)",
                  background: "var(--panel2)", color: "var(--t1)" } as const;

  return (
    <div ref={box} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen((v) => !v); setQ(""); }}
        style={{ ...field, width: "100%", textAlign: "left", cursor: disabled ? "default" : "pointer",
                 opacity: disabled ? 0.55 : 1, overflow: "hidden", textOverflow: "ellipsis",
                 whiteSpace: "nowrap", color: current ? "var(--t1)" : "var(--t3)" }}
      >
        {current ? current.full_name : placeholder}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 40,
                      background: "var(--bg)", border: "1px solid var(--line2)", borderRadius: 8,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.18)", overflow: "hidden" }}>
          <input
            autoFocus
            value={q}
            placeholder="Search your repos…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setOpen(false); setQ(""); }
              if (e.key === "Enter" && shown.length && shown[0].can_push) {
                onPick(shown[0].url); setOpen(false); setQ("");
              }
            }}
            style={{ ...field, width: "100%", border: "none", borderBottom: "1px solid var(--line)",
                     borderRadius: 0, outline: "none" }}
          />
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {value && (
              <div role="button" tabIndex={0}
                   onClick={() => { onPick(""); setOpen(false); setQ(""); }}
                   style={{ padding: "6px 9px", fontSize: 12, color: "var(--t3)", cursor: "pointer" }}>
                — unpin —
              </div>
            )}
            {shown.length === 0 && (
              <div style={{ padding: "8px 9px", fontSize: 11.5, color: "var(--t3)" }}>
                {repos.length ? "No repo matches that." : "No repos to choose from."}
              </div>
            )}
            {shown.map((r) => (
              <div
                key={r.full_name}
                role="button"
                tabIndex={r.can_push ? 0 : -1}
                onClick={() => { if (r.can_push) { onPick(r.url); setOpen(false); setQ(""); } }}
                title={r.can_push ? r.full_name : "This token can read that repo but not push to it."}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px",
                         fontSize: 12, cursor: r.can_push ? "pointer" : "default",
                         color: r.can_push ? "var(--t1)" : "var(--t3)",
                         background: r.url === value ? "var(--panel2)" : "transparent" }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                               whiteSpace: "nowrap" }}>{r.full_name}</span>
                {!r.can_push && <span style={{ fontSize: 10.5, flex: "none" }}>read-only</span>}
                {r.private && r.can_push && <span style={{ fontSize: 10.5, flex: "none", color: "var(--t3)" }}>private</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


/** Which of your OWN repos backs each product skill.
 *
 *  A repo-backed product (Partic, BIAMI) is built by writing a document into a repo you already own
 *  and pushing it — the product reads from there, so authoring is a commit and nothing is executed
 *  by Vexa. Pinning CLONES the repo into your workspace store, which is why it lives here and not in
 *  a meeting: a clone is a network op, and a meeting is a bad place to discover a bad token. */
export function SkillReposCard({ reloadKey = 0 }: { reloadKey?: number } = {}) {
  const [state, setState] = useState<SkillRepoState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = { fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" } as const;

  const refresh = useCallback(() => {
    void getSkillRepos().then((s) => { setState(s); setError(null); })
      .catch((e: unknown) => setError(presentError(e).headline));
  }, []);
  // `reloadKey` changes when the token above is saved or cleared: the repo list is a function of
  // that credential, so it has to be re-asked rather than waiting for a reload.
  useEffect(() => refresh(), [refresh, reloadKey]);

  const choose = (skill: string, url: string) => {
    setBusy(skill);
    setError(null);
    void setSkillRepo(skill, url).then(refresh)
      .catch((e: unknown) => setError(presentError(e).headline))
      .finally(() => setBusy(null));
  };

  if (!state) return null;                 // first load; the card appears as soon as we know
  if (!state.skills.length) return null;   // a build with no repo-backed product

  return (
    <div style={{ margin: "4px 4px 14px", padding: 10, borderRadius: 8, border: "1px solid var(--line)" }}>
      <div style={{ fontSize: 12.5, color: "var(--t1)", marginBottom: 3 }}>Product repos</div>
      <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.45, marginBottom: 9 }}>
        Where @nexus writes when a meeting asks it to build something. Each product reads from a repo
        you own — pinning one clones it here; nothing is ever run, only written and pushed.
        Turn a product on per meeting from that meeting&rsquo;s @nexus control.
      </div>
      {error && <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", marginBottom: 8 }}>⚠ {error}</div>}
      {!state.token_set && (
        <div style={{ fontSize: 11.5, color: "var(--t3)", marginBottom: 8 }}>
          Save a GitHub token above to choose a repo.
        </div>
      )}
      {state.token_set && state.note && (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)", marginBottom: 8 }}>⚠ {state.note}</div>
      )}
      {state.skills.map((sk) => (
        <div key={sk.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
          <span style={{ width: 96, flex: "none", fontSize: 12.5, color: "var(--t1)" }}>{sk.label}</span>
          <RepoPicker
            repos={state.repos}
            value={sk.pinned?.repo ?? ""}
            disabled={Boolean(busy) || !state.token_set}
            placeholder={`Not set — ${sk.pin_hint}`}
            onPick={(url) => choose(sk.id, url)}
          />
        </div>
      ))}
    </div>
  );
}

export function TokensPanel() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [error, setError] = useState<string | null>(null);  // fail-loud (P18)

  const refresh = useCallback(() => {
    void listTokens().then((t) => { setTokens(t); setError(null); }).catch((e: unknown) => setError(presentError(e).headline));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const onCreated = (t: MintedToken) => { setMinted(t); refresh(); };
  const onRevoke = (id: number) => {
    void revokeToken(id).then(refresh).catch((e: unknown) => setError(presentError(e).headline));
  };

  return (
    <div style={{ padding: "8px" }}>
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--danger)", padding: "6px 9px" }}>⚠ Couldn’t load tokens — {error}</div>}
      {minted && <MintedTokenCard minted={minted} onDismiss={() => setMinted(null)} />}
      <CreateTokenForm onCreated={onCreated} />
      {tokens.map((t) => <TokenRow key={t.id} token={t} onRevoke={onRevoke} />)}
      {tokens.length === 0 && !error && <div style={{ padding: "8px 4px", color: "var(--t3)", fontSize: 12 }}>No API tokens yet.</div>}
    </div>
  );
}
