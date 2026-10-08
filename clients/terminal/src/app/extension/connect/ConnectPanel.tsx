"use client";
/** The connect surface: sign in, then one deliberate click to hand the extension a token.
 *
 *  The Connect control is a PLAIN FORM, posted to /api/extension/connect, which answers 303 to the
 *  extension's loopback. That matters: `chrome.identity.launchWebAuthFlow` ends the flow when it
 *  sees the window navigate to the redirect URL, and a server redirect is such a navigation
 *  beyond doubt. Doing the same hop with fetch + `location.replace()` minted the token but never
 *  ended the flow — the window just sat there and the extension waited forever. No JavaScript is
 *  involved in the hop that carries the credential.
 */
import { signIn } from "next-auth/react";

// Tokens only — globals.css is the one color source (see surfaces/__tests__/colorTokens.test.ts).
const page = {
  minHeight: "100dvh", display: "grid", placeItems: "center",
  background: "var(--bg)", color: "var(--t1)",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", padding: 24,
} as const;
const card = {
  width: "min(420px, 100%)", border: "1px solid var(--line)", borderRadius: 12,
  background: "var(--panel)", padding: 24,
} as const;
const button = {
  width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 14, fontWeight: 600,
  border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--on-accent)",
  cursor: "pointer",
} as const;
const muted = { fontSize: 12.5, color: "var(--t3)", lineHeight: 1.5 } as const;

export function ConnectPanel({
  redirectUri,
  email,
  error,
}: {
  redirectUri: string;
  email: string | null;
  error?: string | null;
}) {
  // Opened directly in a browser rather than by the extension: say so instead of showing a
  // Connect button that cannot work.
  if (!redirectUri) {
    return (
      <main style={page}>
        <div style={card}>
          <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>Nexus extension</h1>
          <p style={muted}>
            Open this page from the Nexus extension itself — click <b>Connect</b> in the
            extension&apos;s panel. It cannot hand over a credential when opened directly.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={page}>
      <div style={card}>
        <h1 style={{ fontSize: 16, margin: "0 0 4px" }}>Connect the Nexus extension</h1>
        {email ? (
          <>
            <p style={{ ...muted, margin: "0 0 18px" }}>
              Signed in as <b style={{ color: "var(--t1)" }}>{email}</b>. The extension will be
              able to record your in-person meetings and read your own meeting history. You can revoke
              it any time from API tokens in Nexus.
            </p>
            <form method="post" action="/api/extension/connect">
              <input type="hidden" name="redirect_uri" value={redirectUri} />
              <button style={button} type="submit">
                Connect
              </button>
            </form>
          </>
        ) : (
          <>
            <p style={{ ...muted, margin: "0 0 18px" }}>
              Sign in with Google to connect the extension to your Nexus account.
            </p>
            <button
              style={button}
              onClick={() =>
                signIn("google", { callbackUrl: window.location.pathname + window.location.search })
              }
            >
              Continue with Google
            </button>
          </>
        )}
        {error && <p style={{ ...muted, color: "var(--danger)", marginTop: 14 }}>{error}</p>}
      </div>
    </main>
  );
}
