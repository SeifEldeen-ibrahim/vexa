/** /extension/connect — where the Nexus Chrome extension gets its credential.
 *
 *  The extension opens this page inside `chrome.identity.launchWebAuthFlow`. Signed out, it is
 *  the ordinary Google sign-in (the same NextAuth flow the workbench uses, which find-or-creates
 *  the user and mints their session). Signed in, it asks for one explicit click, then hands the
 *  token back through Chrome's extension loopback — see ../../api/extension/connect/route.ts for
 *  why that click and that redirect target are the security of this flow.
 */
import { currentUser } from "../../api/tokens/currentUser";
import { ConnectPanel } from "./ConnectPanel";

export const dynamic = "force-dynamic";

export default async function ExtensionConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");
  // launchWebAuthFlow's own loopback, which the extension passes in.
  const redirectUri = one(params.redirect_uri);
  const me = await currentUser();

  return (
    <ConnectPanel
      redirectUri={redirectUri}
      email={me.ok ? me.email : null}
    />
  );
}
