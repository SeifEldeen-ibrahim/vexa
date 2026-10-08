/** The extension-connect redirect target IS the security of that flow: it decides where a freshly
 *  minted API token is allowed to land. Chrome delivers a `chromiumapp.org` fragment only to the
 *  extension named in the hostname, so the pattern check is what stops a token being redirected
 *  to a web page. */
import { describe, expect, it } from "vitest";
import { validateRedirectUri } from "../extension/redirectTarget";

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);

describe("validateRedirectUri", () => {
  it("accepts a Chrome extension's own loopback", () => {
    const r = validateRedirectUri(`https://${ID}.chromiumapp.org/`, []);
    expect(r).toEqual({ ok: true, redirectUri: `https://${ID}.chromiumapp.org/`, extensionId: ID });
  });

  it("accepts a path and keeps it", () => {
    const r = validateRedirectUri(`https://${ID}.chromiumapp.org/provider_cb`, []);
    expect(r.ok && r.redirectUri).toBe(`https://${ID}.chromiumapp.org/provider_cb`);
  });

  it("refuses any web origin — the token must not be redirectable to a page", () => {
    for (const uri of [
      "https://evil.example/cb",
      "https://nexus.biami.io/cb",
      `http://${ID}.chromiumapp.org/`,
      `https://${ID}.chromiumapp.org.evil.example/`,
      `https://evil.example/?x=https://${ID}.chromiumapp.org/`,
      "javascript:alert(1)",
    ]) {
      expect(validateRedirectUri(uri, []).ok, uri).toBe(false);
    }
  });

  it("refuses a malformed or missing redirect_uri", () => {
    for (const uri of [undefined, null, "", "   ", 42, {}, "https://short.chromiumapp.org/"]) {
      expect(validateRedirectUri(uri as unknown, []).ok).toBe(false);
    }
  });

  it("honours an allowlist when the deployment pins extension ids", () => {
    expect(validateRedirectUri(`https://${ID}.chromiumapp.org/`, [ID]).ok).toBe(true);
    expect(validateRedirectUri(`https://${OTHER}.chromiumapp.org/`, [ID]).ok).toBe(false);
  });

  it("an empty allowlist means 'any extension loopback', not 'none'", () => {
    expect(validateRedirectUri(`https://${OTHER}.chromiumapp.org/`, []).ok).toBe(true);
  });
});
