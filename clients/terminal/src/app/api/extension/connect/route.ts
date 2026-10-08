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
 *  The token is minted with a stable name so the user can see and revoke it in the terminal's
 *  own API-tokens surface, and with the two scopes the live lane needs — never `browser`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { mintUserToken } from "../../auth/adminApi";
import { currentUser } from "../../tokens/currentUser";
import { EXTENSION_SCOPES, EXTENSION_TOKEN_NAME, validateRedirectUri } from "../redirectTarget";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function POST(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return NextResponse.json({ error: me.error }, { status: me.status, headers: NO_STORE });

  let body: { redirect_uri?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const target = validateRedirectUri(body.redirect_uri);
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400, headers: NO_STORE });

  const minted = await mintUserToken(me.userId, {
    scopes: EXTENSION_SCOPES,
    name: EXTENSION_TOKEN_NAME,
  });
  if (!minted.ok || !minted.data?.token) {
    return NextResponse.json(
      { error: minted.error || "Failed to mint the extension token" },
      { status: minted.status || 502, headers: NO_STORE },
    );
  }

  // The secret crosses ONCE, in the fragment of a URL only Chrome can deliver. A fragment is
  // never sent to a server and never written to an access log.
  const url = new URL(target.redirectUri);
  url.hash = new URLSearchParams({ token: minted.data.token, email: me.email }).toString();
  return NextResponse.json({ redirect: url.toString(), email: me.email }, { status: 201, headers: NO_STORE });
}
