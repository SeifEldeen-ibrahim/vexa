"use client";
/** API tokens + GitHub token panels — the user's credential self-serve (list, mint, revoke; save-once
 *  PAT). These render inside the SETTINGS tab (surfaces/settings.tsx — the footer-gear surface,
 *  design-spec meeting-lifecycle-v2 W5); the old "API Tokens" activity-bar item is retired so
 *  integrator config leaves the daily-driver nav. All data flows through /api/tokens, which resolves
 *  the user server-side from the auth cookies — no user_id ever leaves this component (P20). The
 *  minted token value is shown ONCE (copy it now); it is never listed again.
 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../ui-kit";
import { copyText } from "../ui-kit/ContextMenu";
import { listTokens, createToken, revokeToken, TOKEN_SCOPES, type TokenInfo, type TokenScope, type MintedToken } from "./tokensApi";
import { getGitToken, getSkillRepos, setGitToken, setSkillRepo,
  type SavedGitToken, type SkillRepoState } from "./workspaceApi";
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
export function GitHubTokenCard() {
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
    try { const s = await setGitToken(value.trim()); setState(s); setValue(""); setEditing(false); }
    catch (e: unknown) { setError(presentError(e).headline); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setError(null);
    try { const s = await setGitToken(null); setState(s); setValue(""); setEditing(false); }
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

/** Which of your OWN repos backs each product skill.
 *
 *  A repo-backed product (Partic, BIAMI) is built by writing a document into a repo you already own
 *  and pushing it — the product reads from there, so authoring is a commit and nothing is executed
 *  by Vexa. Pinning CLONES the repo into your workspace store, which is why it lives here and not in
 *  a meeting: a clone is a network op, and a meeting is a bad place to discover a bad token. */
export function SkillReposCard() {
  const [state, setState] = useState<SkillRepoState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = { fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--t1)" } as const;

  const refresh = useCallback(() => {
    void getSkillRepos().then((s) => { setState(s); setError(null); })
      .catch((e: unknown) => setError(presentError(e).headline));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const choose = (skill: string, url: string) => {
    setBusy(skill);
    setError(null);
    void setSkillRepo(skill, url).then(refresh)
      .catch((e: unknown) => setError(presentError(e).headline))
      .finally(() => setBusy(null));
  };

  if (!state?.skills?.length) return null;

  return (
    <div style={{ margin: "4px 4px 14px", padding: 10, borderRadius: 8, border: "1px solid var(--line)" }}>
      <div style={{ fontSize: 12.5, color: "var(--t1)", marginBottom: 3 }}>Product repos</div>
      <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.45, marginBottom: 9 }}>
        Where @vexa writes when a meeting asks it to build something. Each product reads from a repo
        you own — pinning one clones it here; nothing is ever run, only written and pushed.
        Turn a product on per meeting from that meeting&rsquo;s @vexa control.
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
          <select
            value={sk.pinned?.repo ?? ""}
            disabled={Boolean(busy) || !state.token_set}
            onChange={(e) => choose(sk.id, e.target.value)}
            style={{ ...field, flex: 1, minWidth: 0, opacity: busy === sk.id ? 0.55 : 1 }}
          >
            <option value="">{sk.pinned ? "— unpin —" : `Not set — ${sk.pin_hint}`}</option>
            {state.repos.map((r) => (
              <option key={r.full_name} value={r.url} disabled={!r.can_push}>
                {r.full_name}{r.can_push ? "" : "  (read-only for this token)"}
              </option>
            ))}
          </select>
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
