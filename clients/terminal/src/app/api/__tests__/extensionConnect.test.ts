/** The extension-connect redirect target IS the security of that flow: it decides where a freshly
 *  minted API token is allowed to land. Chrome delivers a `chromiumapp.org` fragment only to the
 *  extension named in the hostname, so the pattern check is what stops a token being redirected
 *  to a web page. */
import { describe, expect, it } from "vitest";
import { isSameOriginPost, validateRedirectUri } from "../extension/redirectTarget";

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

/** The Connect control is a form whose answer is a 303 the browser FOLLOWS, so a cross-site
 *  submission would hand a real token to whatever extension the attacker named. The fetch path
 *  never needed this (a cross-site caller cannot read the answer); the navigation does. */
describe("isSameOriginPost", () => {
  const url = "https://nexus.biami.io/api/extension/connect";
  const h = (init: Record<string, string>) => new Headers(init);

  it("accepts the terminal's own form", () => {
    expect(isSameOriginPost(h({ "sec-fetch-site": "same-origin" }), url)).toBe(true);
  });

  it("accepts a user-typed URL or bookmark, which has no initiating site", () => {
    expect(isSameOriginPost(h({ "sec-fetch-site": "none" }), url)).toBe(true);
  });

  it("refuses a submission from another site", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(isSameOriginPost(h({ "sec-fetch-site": site }), url), site).toBe(false);
    }
  });

  it("falls back to Origin when Sec-Fetch-Site is absent", () => {
    expect(isSameOriginPost(h({ origin: "https://nexus.biami.io" }), url)).toBe(true);
    expect(isSameOriginPost(h({ origin: "https://evil.example" }), url)).toBe(false);
  });

  it("treats a request with neither header as same-origin, as a non-browser caller", () => {
    expect(isSameOriginPost(h({}), url)).toBe(true);
  });
});
