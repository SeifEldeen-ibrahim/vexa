/** Where this build points. ONE deployment per build, overridable from storage so a developer can
 *  aim the same extension at a local stack without rebuilding. */

export const DEFAULT_BASE_URL = 'https://nexus.biami.io';

/** The live lane's public prefix (nginx → the nexus-live service). */
export const LIVE_PREFIX = '/live';

/** The connect page, which is also where Google sign-in happens. */
export const CONNECT_PATH = '/extension/connect';

export interface Settings {
  baseUrl: string;
  token: string | null;
  email: string | null;
}

export const DEFAULTS: Settings = { baseUrl: DEFAULT_BASE_URL, token: null, email: null };
