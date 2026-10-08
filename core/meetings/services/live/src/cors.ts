/**
 * cors.ts — the CORS headers the extension's requests are answered with.
 *
 * Its own module so the invariant can be TESTED: every method the HTTP layer answers must be
 * advertised here. A method missing from the allow-list is invisible on this side and fatal on
 * the other — Chrome refuses the request at the preflight, so the fetch throws before it ever
 * leaves the extension and the user is told "could not reach Nexus" about a service that is
 * perfectly healthy. That is exactly what shipped when agenda templates added PUT and DELETE.
 *
 * Permissive on purpose: same-origin rules do not apply to an extension, and this API carries no
 * cookies — the bearer token IS the whole authorization — so allowing any origin grants nothing
 * that a token holder does not already have.
 */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'X-API-Key, Authorization, Content-Type',
  'Access-Control-Allow-Methods': CORS_METHODS.join(', '),
  'Access-Control-Max-Age': '600',
};
