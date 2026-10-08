/** Where a freshly minted extension token is allowed to land.
 *
 *  In its own module because an App Router `route.ts` may only export HTTP handlers — exporting a
 *  helper from one fails Next's route-type check (the same reason `authOptions` lives beside its
 *  route rather than in it). That separation is convenient anyway: this is the security decision
 *  of the connect flow, and it is unit-tested on its own.
 *
 *  `https://<extension-id>.chromiumapp.org/…` is Chrome's own loopback for
 *  `chrome.identity.launchWebAuthFlow`, and Chrome delivers the fragment ONLY to the extension
 *  whose id is in that hostname. So this check is what stops a token being redirected to a web
 *  page, and `VEXA_EXTENSION_IDS` can narrow it further to specific extensions.
 */

/** The name every extension token carries, so it is recognizable (and revocable) in the UI. */
export const EXTENSION_TOKEN_NAME = "nexus-extension";

/** `tx` reads/writes meeting + transcript data; `bot` is what the meetings routes are scoped to.
 *  `browser` (provisioned browser sessions) is deliberately NOT granted. */
export const EXTENSION_SCOPES = ["bot", "tx"];

const CHROMIUMAPP = /^https:\/\/([a-p]{32})\.chromiumapp\.org(\/.*)?$/;

/** Optional allowlist (comma-separated extension ids). Unset ⇒ any Chrome extension's own
 *  loopback is accepted, which still cannot be a web origin. */
export function allowedExtensionIds(): string[] {
  return (process.env.VEXA_EXTENSION_IDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export type RedirectTarget =
  | { ok: true; redirectUri: string; extensionId: string }
  | { ok: false; error: string };

export function validateRedirectUri(raw: unknown, allow: string[] = allowedExtensionIds()): RedirectTarget {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "A redirect_uri is required" };
  const match = CHROMIUMAPP.exec(raw.trim());
  if (!match) {
    return { ok: false, error: "redirect_uri must be a Chrome extension loopback (https://<id>.chromiumapp.org/)" };
  }
  const extensionId = match[1];
  if (allow.length && !allow.includes(extensionId)) {
    return { ok: false, error: "That extension is not allowed to connect to this deployment" };
  }
  return { ok: true, redirectUri: raw.trim(), extensionId };
}
