/** One source of truth for whether the debug email login is on.
 *
 *  Lives in its own module because BOTH the route that enforces it (login/route.ts) and the route
 *  that advertises it to the login card (instance/route.ts) need it — and an App Router `route.ts`
 *  may only export HTTP handlers, so neither can export it to the other (same constraint that put
 *  NextAuth's config in [...nextauth]/authOptions.ts).
 *
 *  Default is OFF. login/route.ts mints a full session from an email address alone — no password, no
 *  proof of ownership — so it is only ever safe on a loopback dev box. Any deploy reachable from the
 *  internet leaves VEXA_ALLOW_DIRECT_LOGIN unset and signs in through OAuth.
 */
export function directLoginEnabled(): boolean {
  return (process.env.VEXA_ALLOW_DIRECT_LOGIN || "").toLowerCase() === "true";
}
