/** POST /api/extension/connect — mint the token the Nexus Chrome extension will hold.
 *
 *  This is the ONLY way a token reaches the extension, and it is deliberately shaped like an
 *  OAuth consent:
 *
 *    • the user must already be signed in (Google, through the terminal's own NextAuth flow) —
 *      identity comes from `currentUser()`, i.e. the validated auth cookie, never from the body;
 *    • it is a POST behind an explicit click on /extension/connect, so merely VISITING a link
 *      (or being navigated to one by another site) cannot mint anything;
 *    • `redirect_uri` must be `https://<extension-id>.chromiumapp.org/...`. That host is
 *      Chrome's own loopback for `chrome.identity.launchWebAuthFlow`, and Chrome delivers the
 *      fragment ONLY to the extension whose id is in the hostname — so the token cannot be
 *      redirected to a web page, and `VEXA_EXTENSION_IDS` can pin it to specific extensions.
 *
 *  TWO response shapes, because the final hop is load-bearing:
 *
 *    • a FORM post answers 303 to the loopback. `launchWebAuthFlow` ends the flow by observing a
 *      navigation to the redirect URL, and a server-issued redirect is one unambiguously — which
 *      is how every real OAuth provider finishes. An in-page `location.replace()` to the same URL
 *      did NOT end the flow in Chrome: the token was minted, the window sat there, and the
 *      extension waited forever with nothing to show the user.
 *    • a JSON post answers JSON, for callers that want the URL rather than to travel to it.
 *
 *  A form post is also a credential-bearing NAVIGATION, so it carries one extra guard the fetch
 *  path does not need: cross-site form submissions are refused. Without it a page elsewhere could
 *  submit this form in a signed-in user's browser and have the token delivered to an extension of
 *  the attacker's choosing. A same-origin check is what NextAuth itself uses.
 *
 *  The token is minted with a stable name so the user can see and revoke it in the terminal's
 *  own API-tokens surface, and with the two scopes the live lane needs — never `browser`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { mintUserToken } from "../../auth/adminApi";
import { currentUser } from "../../tokens/currentUser";
import {
  EXTENSION_SCOPES,
  EXTENSION_TOKEN_NAME,
  isSameOriginPost,
  validateRedirectUri,
} from "../redirectTarget";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

const CONNECT_PAGE = "/extension/connect";

/** Back to the page with a message, keeping the loopback so the button still works.
 *
 *  The Location is RELATIVE on purpose. Behind nginx, `request.url` is the container's own
 *  address (`http://0.0.0.0:3000/...`), so building an absolute URL from it sends the browser to
 *  a host that does not exist outside Docker. A relative reference is resolved by the browser
 *  against the address it actually asked for, which is the public one. */
function backWithError(redirectUri: unknown, error: string): NextResponse {
  const query = new URLSearchParams();
  if (typeof redirectUri === "string" && redirectUri) query.set("redirect_uri", redirectUri);
  query.set("error", error);
  return new NextResponse(null, {
    status: 303,
    headers: { ...NO_STORE, Location: `${CONNECT_PAGE}?${query.toString()}` },
  });
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");

  let redirectUriRaw: unknown;
  if (isForm) {
    const form = await request.formData();
    redirectUriRaw = form.get("redirect_uri");
  } else {
    try {
      redirectUriRaw = ((await request.json()) as { redirect_uri?: unknown }).redirect_uri;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
    }
  }

  const fail = (error: string, status: number) =>
    isForm
      ? backWithError(redirectUriRaw, error)
      : NextResponse.json({ error }, { status, headers: NO_STORE });

  if (isForm && !isSameOriginPost(request.headers, request.url)) return fail("That request did not come from Nexus", 403);

  const me = await currentUser();
  if (!me.ok) return fail(me.error, me.status);

  const target = validateRedirectUri(redirectUriRaw);
  if (!target.ok) return fail(target.error, 400);

  const minted = await mintUserToken(me.userId, {
    scopes: EXTENSION_SCOPES,
    name: EXTENSION_TOKEN_NAME,
  });
  if (!minted.ok || !minted.data?.token) {
    return fail(minted.error || "Failed to mint the extension token", minted.status || 502);
  }

  // The secret crosses ONCE, in the fragment of a URL only Chrome can deliver. A fragment is
  // never sent to a server and never written to an access log.
  const url = new URL(target.redirectUri);
  url.hash = new URLSearchParams({ token: minted.data.token, email: me.email }).toString();

  if (isForm) {
    // 303: the flow ends on a navigation Chrome's identity API observes, and the re-request is a
    // GET so the browser does not re-post this form if the user goes back.
    return NextResponse.redirect(url.toString(), { status: 303, headers: NO_STORE });
  }
  return NextResponse.json({ redirect: url.toString(), email: me.email }, { status: 201, headers: NO_STORE });
}
