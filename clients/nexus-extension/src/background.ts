/**
 * background.ts — the service worker: the one owner of a call's state.
 *
 * Everything with a lifetime longer than a UI click lives here: the stored credential, the
 * offscreen microphone document, the ingest WebSocket, and the poll that keeps the checklist
 * fresh. The side panel is a VIEW — it asks for state, renders it, and sends intents. Closing
 * the panel therefore cannot stop a recording, which is the behaviour a person in a meeting
 * expects when they switch tabs.
 *
 * MV3 kills an idle worker, which would take the socket with it. Two things keep this honest:
 *   • an alarm (`chrome.alarms`) wakes the worker every 20 s, re-opens the socket if it died, and
 *     re-polls the snapshot — so a sleeping worker self-heals rather than silently stopping;
 *   • the SERVICE's own janitor finalizes a call whose audio stopped arriving, so even a browser
 *     that was closed outright leaves a properly completed meeting rather than one stuck live.
 */
import { NexusApi } from './api.js';
import { encodeAudioFrame, MIC_CHANNEL } from './capture-codec.js';
import { CONNECT_PATH, DEFAULTS, type Settings } from './config.js';
import type { ExtensionState, SessionSnapshot, StartedSession } from './types.js';

/** Worker-console breadcrumbs. Kept in the shipped build on purpose: when sign-in or a call fails
 *  for a user, "chrome://extensions → service worker" is the only window into this process, and a
 *  silent worker is the hardest thing to support. Never logs the token. */
const log = (...parts: unknown[]): void => console.log('[nexus]', ...parts);

const KEEPALIVE_ALARM = 'nexus-keepalive';
const KEEPALIVE_MINUTES = 0.34; // ~20 s — the floor Chrome honours for a repeating alarm
const POLL_MS = 4000;

// ── stored settings ─────────────────────────────────────────────────────────────────────────
// `chrome.storage.local`, never `sync`: a credential must not be replicated to every browser
// the user is signed into.
async function settings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(['baseUrl', 'token', 'email'])) as Partial<Settings>;
  return {
    baseUrl: stored.baseUrl?.trim() || DEFAULTS.baseUrl,
    token: stored.token ?? null,
    email: stored.email ?? null,
  };
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

async function api(): Promise<NexusApi | null> {
  const s = await settings();
  return s.token ? new NexusApi({ baseUrl: s.baseUrl, token: s.token }) : null;
}

// ── in-memory call state ────────────────────────────────────────────────────────────────────
interface Live {
  uid: string;
  ingestUrl: string;
  socket: WebSocket | null;
  frames: number;
  micOn: boolean;
  snapshot: SessionSnapshot | null;
  stopping: boolean;
}

let live: Live | null = null;
let lastError: string | null = null;
let notices: string[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** The panel re-renders from this, and only this. */
async function state(): Promise<ExtensionState> {
  const s = await settings();
  return {
    connected: !!s.token,
    email: s.email,
    phase: live ? (live.stopping ? 'stopping' : 'live') : 'idle',
    session: live?.snapshot ?? null,
    capture: {
      mic: live?.micOn ?? false,
      socket: live?.socket?.readyState === WebSocket.OPEN,
      frames: live?.frames ?? 0,
    },
    micPermission: micPermission,
    error: lastError,
    notices: [...notices],
  };
}

let micPermission: ExtensionState['micPermission'] = 'unknown';

/** Tell the panel something changed. No listener (panel closed) is not an error. */
function announce(): void {
  void state().then((s) => chrome.runtime.sendMessage({ type: 'state-changed', state: s }).catch(() => {}));
}

// ── the credential: Google sign-in, through the terminal ────────────────────────────────────
/**
 * Open the terminal's connect page inside Chrome's auth flow. The user signs in with Google
 * there (the terminal is the OAuth broker — this extension never talks to Google), clicks
 * Connect once, and Chrome hands the resulting fragment back to THIS extension only.
 */
async function connect(): Promise<{ ok: boolean; error?: string }> {
  const res = await attemptConnect();
  if (!res.ok) {
    // The reason has to live in STATE, not only in this reply. The panel re-renders from state
    // immediately after the click, so an error held only here was painted and then wiped in the
    // same breath — which is why a failing sign-in looked like a sign-in that did nothing.
    lastError = res.error ?? 'Sign-in did not finish';
    announce();
  }
  return res;
}

async function attemptConnect(): Promise<{ ok: boolean; error?: string }> {
  const s = await settings();
  const redirectUri = chrome.identity.getRedirectURL();
  const url = `${s.baseUrl.replace(/\/+$/, '')}${CONNECT_PATH}?redirect_uri=${encodeURIComponent(redirectUri)}`;
  let redirect: string | undefined;
  log('connect: opening the sign-in window at', url);
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (err) {
    const message = (err as Error)?.message || 'the sign-in window was closed';
    log('connect: the flow failed —', message);
    return { ok: false, error: `Sign-in did not finish: ${message}` };
  }
  if (!redirect) return { ok: false, error: 'Sign-in did not finish' };
  // The URL itself carries the token in its fragment, so log only its shape.
  log('connect: the flow came back with a redirect, fragment present:', new URL(redirect).hash.length > 1);

  const fragment = new URL(redirect).hash.replace(/^#/, '');
  const params = new URLSearchParams(fragment);
  const token = params.get('token');
  const email = params.get('email');
  if (!token) {
    // Name the parameters, never their values: one of them would be the credential.
    const present = [...params.keys()].join(', ') || 'nothing at all';
    log('connect: the redirect carried no token — parameters present:', present);
    return { ok: false, error: `Nexus did not return a credential (the sign-in came back with ${present})` };
  }

  await saveSettings({ token, email: email ?? null });
  // Prove it works now rather than at the start of a meeting.
  const client = new NexusApi({ baseUrl: s.baseUrl, token });
  const me = await client.me();
  if (!me.ok) {
    log('connect: the credential did not work against', s.baseUrl, '—', me.status, me.error);
    await saveSettings({ token: null, email: null });
    return { ok: false, error: me.error };
  }
  log('connect: signed in as', me.value.email);
  notices = me.value.capabilities?.coverage
    ? []
    : ['This deployment has no model configured for agenda coverage, so the checklist will not tick by itself.'];
  await saveSettings({ email: me.value.email });
  lastError = null;
  announce();
  return { ok: true };
}

async function disconnect(): Promise<void> {
  if (live) await stopCall();
  await saveSettings({ token: null, email: null });
  lastError = null;
  announce();
}

// ── the microphone ──────────────────────────────────────────────────────────────────────────
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Record the in-person meeting the user started through its microphone.',
  });
}

async function startMic(): Promise<{ ok: boolean; error?: string }> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-capture' })) as
    { ok: boolean; error?: string } | undefined;
  if (res?.ok) {
    micPermission = 'granted';
    return { ok: true };
  }
  if (res?.error === 'microphone-permission') {
    micPermission = 'denied';
    // The grant cannot be taken from an offscreen document, so send the user to the one page
    // that can ask for it.
    await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
    return { ok: false, error: 'Nexus needs permission to use your microphone — allow it in the tab that just opened, then press Start again.' };
  }
  return { ok: false, error: `The microphone could not be opened (${res?.error ?? 'unknown'})` };
}

async function stopMic(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' });
  } catch { /* no offscreen document */ }
  try {
    await chrome.offscreen.closeDocument();
  } catch { /* already closed */ }
}

// ── the audio socket ────────────────────────────────────────────────────────────────────────
async function openSocket(): Promise<void> {
  if (!live || live.stopping) return;
  if (live.socket && (live.socket.readyState === WebSocket.OPEN || live.socket.readyState === WebSocket.CONNECTING)) return;
  const s = await settings();
  if (!s.token) return;
  const url = `${live.ingestUrl}?session=${encodeURIComponent(live.uid)}`;
  // A browser cannot set headers on a WebSocket, so the credential rides a subprotocol. The
  // server selects `capture.v1` and never echoes the token back.
  const socket = new WebSocket(url, ['capture.v1', `nexus-token.${s.token}`]);
  socket.binaryType = 'arraybuffer';
  live.socket = socket;
  socket.addEventListener('open', () => {
    lastError = null;
    announce();
  });
  socket.addEventListener('close', () => {
    if (live && live.socket === socket) live.socket = null;
    announce();
    // The alarm re-opens it. A dropped socket is not the end of a call: the service keeps the
    // meeting alive for its idle window, so a wifi blip costs seconds of audio, not the meeting.
  });
  socket.addEventListener('error', () => {
    lastError = 'The connection to Nexus dropped — reconnecting';
    announce();
  });
}

function sendPcm(pcm: number[], ts: number): void {
  const socket = live?.socket;
  if (!live || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeAudioFrame(MIC_CHANNEL, ts, Float32Array.from(pcm)));
  live.frames++;
}

// ── the call ────────────────────────────────────────────────────────────────────────────────
async function startCall(title: string, agenda: string[]): Promise<{ ok: boolean; error?: string }> {
  if (live) return { ok: false, error: 'A call is already running' };
  const client = await api();
  if (!client) return { ok: false, error: 'Connect to Nexus first' };

  // The microphone FIRST: if it cannot be opened there is no point creating a meeting, and a
  // meeting with no audio is the failure this ordering exists to avoid.
  const mic = await startMic();
  if (!mic.ok) {
    lastError = mic.error ?? 'The microphone could not be opened';
    announce();
    return { ok: false, error: lastError };
  }

  const started = await client.start(title, agenda);
  if (!started.ok) {
    await stopMic();
    if (started.status === 409 && started.conflict) {
      // Adopt the call the server says is running — the user pressed Start twice, or the worker
      // was restarted mid-meeting.
      await adopt(started.conflict);
      return { ok: true };
    }
    lastError = started.error;
    announce();
    return { ok: false, error: started.error };
  }

  const session = started.value as StartedSession;
  live = {
    uid: session.session_uid,
    ingestUrl: session.ingest.url,
    socket: null,
    frames: 0,
    micOn: true,
    snapshot: session,
    stopping: false,
  };
  notices = session.warnings ?? [];
  lastError = null;
  await openSocket();
  startPolling();
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
  announce();
  return { ok: true };
}

/** Re-attach to a call the server is holding (worker restart, or a double Start). */
async function adopt(snapshot: SessionSnapshot): Promise<void> {
  const s = await settings();
  live = {
    uid: snapshot.session_uid,
    // The service's public ingest URL is deployment config; derive it from the base URL, which
    // is the same thing nginx fronts.
    ingestUrl: `${s.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/live/ingest`,
    socket: null,
    frames: 0,
    micOn: false,
    snapshot,
    stopping: false,
  };
  const mic = await startMic();
  live.micOn = mic.ok;
  if (!mic.ok) lastError = mic.error ?? null;
  await openSocket();
  startPolling();
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
  announce();
}

async function stopCall(): Promise<{ ok: boolean; error?: string }> {
  if (!live) return { ok: false, error: 'No call is running' };
  live.stopping = true;
  announce();
  const uid = live.uid;
  // Stop capturing BEFORE telling the service to finalize, so the last turn is not cut off by
  // audio arriving after the final coverage pass.
  await stopMic();
  try {
    live.socket?.close(1000, 'call ended');
  } catch { /* already closed */ }
  stopPolling();
  await chrome.alarms.clear(KEEPALIVE_ALARM);

  const client = await api();
  let final: SessionSnapshot | null = null;
  if (client) {
    const stopped = await client.stop(uid);
    if (stopped.ok) final = stopped.value;
    else lastError = stopped.error;
  }
  live = null;
  // Keep the final checklist on screen: the panel reads it from `lastFinished` until the user
  // starts something else.
  lastFinished = final;
  announce();
  return { ok: true };
}

let lastFinished: SessionSnapshot | null = null;

// ── polling the checklist ───────────────────────────────────────────────────────────────────
function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => void refresh(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function refresh(): Promise<void> {
  if (!live) return;
  const client = await api();
  if (!client) return;
  const snap = await client.snapshot(live.uid);
  if (!snap.ok) {
    if (snap.status === 404) {
      // The service finalized it (its idle janitor, or a restart) — stop pretending it is live.
      lastFinished = live.snapshot;
      live = null;
      stopPolling();
      lastError = 'The call was finalized by Nexus';
      announce();
    }
    return;
  }
  live.snapshot = snap.value;
  if (snap.value.status === 'ended') {
    lastFinished = snap.value;
    live = null;
    stopPolling();
    await stopMic();
  }
  announce();
}

// ── wiring ──────────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // The offscreen document's audio: the hottest path in the extension.
  if (msg?.type === 'pcm') {
    sendPcm(msg.pcm as number[], msg.ts as number);
    return false;
  }
  if (msg?.type === 'mic-granted') {
    micPermission = 'granted';
    announce();
    return false;
  }

  (async () => {
    switch (msg?.type) {
      case 'state': {
        const s = await state();
        respond({ ...s, session: s.session ?? lastFinished });
        return;
      }
      case 'connect': respond(await connect()); return;
      case 'disconnect': await disconnect(); respond({ ok: true }); return;
      case 'start': respond(await startCall(String(msg.title ?? ''), (msg.agenda as string[]) ?? [])); return;
      case 'stop': respond(await stopCall()); return;
      case 'grant-mic':
        await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
        respond({ ok: true });
        return;
      case 'history': {
        const client = await api();
        respond(client ? await client.history() : { ok: false, status: 401, error: 'Connect to Nexus first' });
        return;
      }
      case 'checklists': {
        const client = await api();
        respond(client ? await client.checklists() : { ok: false, status: 401, error: 'Connect to Nexus first' });
        return;
      }
      case 'transcript': {
        const client = await api();
        respond(client && live ? await client.transcript(live.uid) : { ok: false, status: 404, error: 'No live call' });
        return;
      }
      default:
        respond({ ok: false, error: 'unknown request' });
    }
  })();
  return true; // the response is async
});

/** The worker was woken: heal whatever died while it slept. */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM || !live) return;
  void (async () => {
    await openSocket();
    await refresh();
  })();
});

chrome.action.onClicked.addListener((tab) => {
  void chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
