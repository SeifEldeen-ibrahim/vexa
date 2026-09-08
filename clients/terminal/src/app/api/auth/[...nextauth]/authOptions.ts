/** NextAuth config for the terminal's OAuth broker (Google + Microsoft). Kept in its own module because
 *  an App Router `route.ts` may only export HTTP handlers — re-exporting `authOptions` from there fails
 *  Next's route-type check. NextAuth owns ONLY the OAuth dance; the terminal's auth contract is the
 *  httpOnly `vexa-token` + `vexa-user-info` cookies (read by server.mjs's WS proxy, api/proxyAuth.ts,
 *  and api/auth/me). So `signIn` ends by setting those exact cookies, via the SAME find-or-create+mint
 *  path the direct email login uses (findOrCreateUserToken in ../adminApi.ts). Mirrors the production
 *  webapp route, trimmed and reusing our admin client.
 *
 *  Providers self-gate on env presence, so a deploy with no OAuth creds simply exposes no providers
 *  (the email debug login still works). Credentials come from vexa-secrets (see .env.local).
 */
import { type AuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, findOrCreateUserToken, recordGoogleGrant } from "../adminApi";

const isGoogleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
/** Ask Google, at sign-in, for the one extra read-only scope the in-meeting assistant needs to tell
 *  WHICH ACCOUNT typed a chat message. Off by default: it adds a line to the consent screen and
 *  forces `prompt=consent`, so a deployment that does not use the in-meeting assistant should not
 *  pay for it. */
const googleMeetIdentityEnabled = () =>
  (process.env.VEXA_GOOGLE_MEET_IDENTITY || "").trim().toLowerCase() === "true";
const isMicrosoftEnabled = () =>
  !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

/** Secure cookies behind HTTPS, mirroring the login route's isSecureRequest(). */
function isSecureRequest(): boolean {
  return (
    (process.env.NEXTAUTH_URL || "").startsWith("https://") ||
    (process.env.TERMINAL_URL || "").startsWith("https://") ||
    process.env.NODE_ENV === "production"
  );
}

export const authOptions: AuthOptions = {
  providers: [
    // prompt=select_account forces the provider's account chooser EVERY time, so after logout a user can
    // pick a different account instead of being silently re-authenticated into the last one (the provider
    // keeps its own session — without this it auto-returns the previous identity and logout looks broken).
    ...(isGoogleEnabled()
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            authorization: {
              params: {
                prompt: googleMeetIdentityEnabled() ? "consent select_account" : "select_account",
                // A refresh token is issued ONCE, on a consent-granting authorization — hence
                // `prompt=consent` above. Without both of these a re-login returns an access token
                // that expires in an hour and no way to renew it.
                access_type: googleMeetIdentityEnabled() ? "offline" : "online",
                // Read-only, and only about meeting spaces the user can already see: it grants no
                // ability to join, change or record anything. It is what lets the in-meeting
                // assistant tell WHICH ACCOUNT typed a chat message, since Meet's chat carries only
                // a display name and two accounts can share one.
                scope: googleMeetIdentityEnabled()
                  ? "openid email profile https://www.googleapis.com/auth/meetings.space.readonly"
                  : "openid email profile",
              },
            },
          }),
        ]
      : []),
    ...(isMicrosoftEnabled()
      ? [
          AzureADProvider({
            id: "microsoft",
            name: "Microsoft",
            clientId: process.env.MICROSOFT_CLIENT_ID!,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
            tenantId: process.env.MICROSOFT_TENANT_ID || "common",
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  // Behind an HTTPS reverse proxy, NextAuth infers secure cookies from the URL; match that.
  useSecureCookies: isSecureRequest(),
  pages: { signIn: "/", error: "/" },
  callbacks: {
    /** The load-bearing step: turn a verified OAuth identity into the terminal's `vexa-token` +
     *  `vexa-user-info` cookies, reusing the admin-api find-or-create+mint flow. Deny on any failure. */
    async signIn({ user, account, profile }) {
      const provider = account?.provider;
      if ((provider !== "google" && provider !== "microsoft") || !user.email) return false;

      const result = await findOrCreateUserToken(user.email.toLowerCase());
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error(`[terminal-auth] ${provider} sign-in failed for ${user.email}: ${result.error}`);
        return false;
      }

      // Record the Google grant, if this sign-in carried one. BEST EFFORT and deliberately after
      // the user exists: a failure here must never cost someone their login. Without it the
      // in-meeting assistant simply cannot identify anyone and answers nobody — which is the safe
      // direction to fail in.
      if (provider === "google" && googleMeetIdentityEnabled() && result.user?.id) {
        const sub = (profile as { sub?: string } | undefined)?.sub;
        if (account?.refresh_token || sub) {
          const recorded = await recordGoogleGrant(result.user.id, {
            refresh_token: account?.refresh_token,
            sub,
            scopes: account?.scope,
          });
          if (!recorded) {
            // eslint-disable-next-line no-console
            console.warn(`[terminal-auth] could not record the Google grant for ${user.email} — ` +
              "the in-meeting assistant will not be able to identify this user");
          }
        }
      }

      const opts = {
        httpOnly: true,
        secure: isSecureRequest(),
        sameSite: "lax" as const,
        maxAge: 60 * 60 * 24 * 30,
        path: "/",
      };
      const cookieStore = await cookies();
      cookieStore.set(AUTH_COOKIE, result.token, opts);
      const displayName = user.name || result.user.name || result.user.email.split("@")[0];
      cookieStore.set(USER_INFO_COOKIE, JSON.stringify({ email: result.user.email, name: displayName }), opts);
      return true;
    },
    // Land back on the workbench, HONORING a same-origin callbackUrl so an invite link's ?invite=<token>
    // survives the OAuth round-trip (InviteRedeemer then redeems it post-auth). Off-origin URLs → baseUrl.
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      if (url.startsWith(baseUrl)) return url;
      return baseUrl;
    },
  },
};
