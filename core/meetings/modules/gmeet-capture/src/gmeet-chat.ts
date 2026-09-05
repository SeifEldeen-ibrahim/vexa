/**
 * Google Meet chat reader + sender — SHARED browser module, mirror of teams-chat.ts / zoom-chat.ts.
 *
 * Two capabilities the audio lanes cannot provide:
 *   - READ:  each new chat message as { sender, text }, emitted once. The bot's host turns these
 *            into transcript.v1 `chat` segments (source:'chat'), exactly as the jitsi lane does.
 *   - SEND:  type into Meet's composer and submit, so a control-plane `chat_send` act lands in the
 *            room. Jitsi has this via the app's own API; Meet has no API, so this is DOM-driven.
 *
 * Two Meet-specific constraints shape everything here:
 *
 * 1. THE PANEL MUST BE OPEN. Meet unmounts the chat panel's message list when the side panel is
 *    closed, so a closed panel has no messages in the DOM at all — there is nothing to observe.
 *    `ensureGmeetChatOpen()` clicks the toolbar's chat button and the reader re-checks on its poll,
 *    because Meet re-collapses the panel on some layout changes. This is PARTICIPANT-VISIBLE: the
 *    bot sits with its chat panel open. That is a deliberate cost of the capability, not a bug.
 *
 * 2. THE COMPOSER IS REACT-CONTROLLED. Assigning `.value` updates the DOM node but not React's
 *    internal state, so Meet sends an EMPTY message (or nothing). `setReactValue` goes through the
 *    native property setter and dispatches a bubbling `input` event, which is what React listens
 *    for. Getting this wrong fails silently — the message looks typed and never arrives.
 *
 * Selectors are defensive and ordered most-specific-first: Meet's DOM is obfuscated and changes
 * without notice, so `getState()` reports what matched plus a structural dump, and selectors can be
 * tuned from live telemetry instead of a guess-and-redeploy loop.
 */

export interface GmeetChatMessage { sender: string; text: string }

export interface GmeetChatOptions {
  log?: (m: string) => void;
  onMessage: (msg: GmeetChatMessage) => void;
  /** The bot's own display name — its own messages are never emitted (see `isSelf`). */
  selfName?: string;
  /** Poll interval for container re-attach + panel re-open (ms). Default 2000. */
  pollMs?: number;
  /** Keep the chat panel open. Default true — with it closed there is nothing to read. */
  autoOpen?: boolean;
}

export interface GmeetChat {
  destroy(): void;
  getState(): {
    matchedContainer: string | null;
    panelOpen: boolean;
    seen: number;
    recent: GmeetChatMessage[];
    candidates: Array<{ sel: string; count: number }>;
    sample: { sel: string; structure: string[] } | null;
  };
}

// The scrollable message list inside the chat side panel.
export const gmeetChatContainerSelectors: string[] = [
  'div[aria-live="polite"][role="log"]',
  'div[jsname="xySENc"]',                       // long-lived Meet chat message-list jsname
  '[aria-label*="Messages from" i]',
  '[role="log"]',
  'div[jscontroller][data-message-list]',
];
// One message row. Meet groups consecutive messages from one sender under a single header.
export const gmeetChatMessageSelectors: string[] = [
  'div[data-message-id]',
  'div[jsname="dTKtvb"]',
  'div[data-sender-name]',
  '[role="listitem"]',
];
export const gmeetChatSenderSelectors: string[] = [
  'div[data-sender-name]',
  'div[jsname="dDGoyd"]',
  '[class*="senderName" i]',
];
export const gmeetChatTextSelectors: string[] = [
  'div[data-message-text]',
  'div[jsname="dTKtvb"] div[jscontroller]',
  'div[dir="auto"]',
];
// The toolbar button that opens the chat panel, and the composer inside it.
export const gmeetChatToggleSelectors: string[] = [
  'button[aria-label*="Chat with everyone" i]',
  'button[aria-label*="chat" i]',
];
export const gmeetChatInputSelectors: string[] = [
  'textarea[aria-label*="Send a message" i]',
  'textarea[placeholder*="Send a message" i]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'textarea[jsname="YPqjbf"]',
];
export const gmeetChatSendSelectors: string[] = [
  'button[aria-label*="Send a message" i]',
  'button[aria-label*="Send message" i]',
];

/** Text this module has SENT, with a timestamp. The reader drops these on the way back in.
 *
 *  Suppressing by sender name alone is not enough and was proved so live: Meet renders the bot's own
 *  message with no resolvable author, so it read its own reply back as an unknown participant. The
 *  text a moment after we typed it is the reliable signal; the name is the unreliable one. */
const sentRecently = new Map<string, number>();
const SENT_TTL_MS = 60_000;

function rememberSent(text: string): void {
  const now = Date.now();
  sentRecently.set(text.trim(), now);
  for (const [k, t] of sentRecently) if (now - t > SENT_TTL_MS) sentRecently.delete(k);
}

/** Did THIS bot type `text` in the last minute? Compared on a normalised form, because Meet
 *  collapses whitespace and may truncate what it renders back. */
export function wasSentByUs(text: string): boolean {
  const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
  const probe = norm(text);
  if (!probe) return false;
  const now = Date.now();
  for (const [k, t] of sentRecently) {
    if (now - t > SENT_TTL_MS) { sentRecently.delete(k); continue; }
    const mine = norm(k);
    if (mine === probe || mine.startsWith(probe) || probe.startsWith(mine)) return true;
  }
  return false;
}

/** Short leaf texts Meet renders INSIDE a message row that are UI, not a person. Without this the
 *  leaf-text fallback picks the first one it meets — live, that made a message's author "keep"
 *  (the Google Keep save action). */
const CHROME_WORDS = new Set([
  'keep', 'save', 'copy', 'pin', 'pinned', 'more', 'options', 'delete', 'reply', 'you',
  'send', 'edit', 'report', 'translate', 'jump to bottom', 'everyone',
]);

function firstMatch(root: ParentNode, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Is the chat panel currently mounted (i.e. is there anything to read)? */
export function isGmeetChatOpen(): boolean {
  return !!firstMatch(document, gmeetChatContainerSelectors) || !!firstMatch(document, gmeetChatInputSelectors);
}

/** Click the toolbar chat button when the panel is closed. Returns true if a click was issued. */
export function ensureGmeetChatOpen(): boolean {
  if (isGmeetChatOpen()) return false;
  const toggle = firstMatch(document, gmeetChatToggleSelectors) as HTMLElement | null;
  if (!toggle) return false;
  toggle.click();
  return true;
}

/** Write a value into a React-controlled field so React itself sees the change.
 *  A plain `el.value = x` updates the node and NOT React's state, and Meet then submits nothing. */
function setReactValue(el: HTMLElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else (el as HTMLTextAreaElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Send one message into the Meet chat. Returns false when the composer isn't reachable (panel
 *  closed and un-openable, or a Meet build whose selectors have moved). Never throws. */
export function sendGmeetChatMessage(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return false;
  try {
    ensureGmeetChatOpen();
    const input = firstMatch(document, gmeetChatInputSelectors) as HTMLElement | null;
    if (!input) return false;
    input.focus();
    rememberSent(body);   // before the keystrokes: the reader may observe it the same tick
    if (input.getAttribute('contenteditable') === 'true') {
      input.textContent = body;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      setReactValue(input, body);
    }
    // Prefer the explicit send button; fall back to Enter (Meet submits on Enter without Shift).
    const button = firstMatch(document, gmeetChatSendSelectors) as HTMLButtonElement | null;
    if (button && !button.disabled) {
      button.click();
      return true;
    }
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    return true;
  } catch {
    return false;
  }
}

/** Does this element look like a message row rather than a group header? */
function isMessageRow(el: Element): boolean {
  return gmeetChatMessageSelectors.some((sel) => {
    try { return el.matches(sel); } catch { return false; }
  });
}

/** Is this short leaf text plausibly a person's display name (a chat group header)? */
function looksLikeName(t: string): boolean {
  const v = t.trim();
  if (!v || v.length > 40) return false;
  if (CHROME_WORDS.has(v.toLowerCase())) return false;
  if (/^\d{1,2}:\d{2}/.test(v)) return false;          // a timestamp
  if (!/[A-Za-z]/.test(v)) return false;                // punctuation / emoji only
  return true;
}

/** The sender of a grouped message: the nearest name-like text BEFORE the row.
 *
 *  Walks the row's preceding siblings, then repeats one level up, because Meet nests the header and
 *  the message rows as siblings inside a group wrapper. Returns "" when nothing plausible is found —
 *  the caller then reports "Unknown" honestly rather than inventing an author. */
function senderFromHeader(row: Element): string {
  let node: Element | null = row;
  for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
    let sib: Element | null = node.previousElementSibling;
    for (let n = 0; n < 6 && sib; n++, sib = sib.previousElementSibling) {
      // A preceding MESSAGE ROW is not a header. Without this the second message of a run takes the
      // first message's text as its author whenever that text is short enough to look like a name.
      if (isMessageRow(sib)) continue;
      // Prefer an explicit sender element in the header, else its own short text.
      const explicit = textOfIn(sib, gmeetChatSenderSelectors);
      if (explicit && looksLikeName(explicit)) return explicit;
      const own = (sib.textContent || '').trim();
      if (looksLikeName(own)) return own;
    }
  }
  return '';
}

/** `textOf` for a node OUTSIDE a chat instance (the module-level header scan). */
function textOfIn(root: Element, selectors: string[]): string {
  for (const sel of selectors) {
    const t = root.querySelector(sel)?.textContent?.trim();
    if (t) return t;
  }
  return '';
}

export function createGmeetChat(opts: GmeetChatOptions): GmeetChat {
  const log = opts.log || (() => {});
  const autoOpen = opts.autoOpen !== false;
  const self = (opts.selfName || '').trim().toLowerCase();
  const seenNodes = new WeakSet<Element>();
  const seenHashes = new Set<string>();
  const recent: GmeetChatMessage[] = [];
  let matchedContainer: string | null = null;
  let container: Element | null = null;
  let dumped = false;

  const textOf = (root: Element, selectors: string[]): string => {
    for (const sel of selectors) {
      const t = root.querySelector(sel)?.textContent?.trim();
      if (t) return t;
    }
    return '';
  };

  /** The bot's OWN messages must never be emitted. Without this the host publishes the bot's reply
   *  as an incoming chat line, and anything that auto-answers chat proceeds to answer itself. */
  const isSelf = (sender: string): boolean => {
    const s = sender.trim().toLowerCase();
    return !!self && (s === self || s === 'you');
  };

  const extract = (node: Element): GmeetChatMessage | null => {
    let sender = node.getAttribute('data-sender-name') || textOf(node, gmeetChatSenderSelectors);
    let text = node.getAttribute('data-message-text') || textOf(node, gmeetChatTextSelectors);

    // Grouped runs: Meet renders ONE header for a run of messages from the same person, and that
    // header is OUTSIDE the message row. Live evidence — the whole row was:
    //   ["div.jO4O1","div.ptNLrf","div[jsname=dTKtvb]","div >marcin said sooo"]
    // no author anywhere in it. So searching the row, or querying ancestors for a sender selector,
    // can never find it; the name has to be looked for BEFORE the row in document order.
    if (!sender) {
      let cur: Element | null = node.parentElement;
      for (let i = 0; i < 5 && cur && !sender; i++, cur = cur.parentElement) {
        sender = cur.getAttribute?.('data-sender-name') || textOf(cur, gmeetChatSenderSelectors);
      }
    }
    if (!sender) sender = senderFromHeader(node);
    // Leaf-text fallbacks. These run INDEPENDENTLY: the sender fallback used to be nested inside
    // `if (!text)`, so a row whose BODY matched a selector never got its sender recovered — every
    // message came back "Unknown". (Found live; the unit fixtures all had data-sender-name.)
    const frags = (!text || !sender)
      ? Array.from(node.querySelectorAll('*'))
          .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
          .filter((t) => t.length > 0)
      : [];
    if (!text) {
      if (!frags.length) return null;
      text = frags.reduce((a, b) => (b.length > a.length ? b : a), '');
    }
    if (!sender) {
      const body = text;
      sender = frags.find((f) =>
        f !== body && f.length <= 40 && !CHROME_WORDS.has(f.trim().toLowerCase())
        && !/^\d{1,2}:\d{2}/.test(f) && /[A-Za-z]/.test(f)) || '';
    }
    // Meet appends a timestamp to the sender row ("Ada 10:42").
    sender = (sender || '').replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, '').trim() || 'Unknown';
    text = (text || '').trim();
    if (!text) return null;
    return { sender, text };
  };

  const dumpNode = (node: Element): string[] =>
    Array.from(node.querySelectorAll('*')).slice(0, 25).map((e) => {
      const cls = (e.getAttribute('class') || '').slice(0, 40);
      const js = e.getAttribute('jsname');
      const aria = e.getAttribute('aria-label');
      const t = e.childElementCount === 0 ? (e.textContent || '').trim().slice(0, 30) : '';
      return `${e.tagName.toLowerCase()}${js ? '[jsname=' + js + ']' : ''}${cls ? '.' + cls : ''}${aria ? '[al=' + aria.slice(0, 30) + ']' : ''}${t ? ' >' + t : ''}`;
    });

  const emit = (node: Element) => {
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    const msg = extract(node);
    if (!msg) return;
    const hash = `${msg.sender} ${msg.text}`;
    if (seenHashes.has(hash)) return;   // Meet re-renders rows on scroll / panel re-open
    seenHashes.add(hash);
    recent.push(msg);
    if (recent.length > 30) recent.shift();
    // The first row we ever extract gets its structure logged: when a selector stops matching, the
    // log says what the DOM actually looks like instead of costing a rebuild to find out.
    if (!dumped) {
      dumped = true;
      log(`first message row structure: ${JSON.stringify(dumpNode(node)).slice(0, 700)}`);
      // The author is NOT in the row (proved live), so dump the GROUP around it as well — that is
      // where the header lives and where a selector fix has to aim.
      if (node.parentElement) {
        log(`its parent group: ${JSON.stringify(dumpNode(node.parentElement)).slice(0, 900)}`);
      }
      log(`extracted sender=${JSON.stringify(msg.sender)} from the row above`);
    }
    // Echo control, two independent guards. The text guard is the load-bearing one — Meet gave the
    // bot's own reply no resolvable author, so the name guard alone let it read itself back.
    if (wasSentByUs(msg.text)) { log(`chat (our own send, not emitted) ${msg.text.slice(0, 60)}`); return; }
    if (isSelf(msg.sender)) { log(`chat (self, not emitted) ${msg.text.slice(0, 60)}`); return; }
    log(`chat ${msg.sender}: ${msg.text.slice(0, 60)}`);
    try { opts.onMessage(msg); } catch { /* never break capture */ }
  };

  const scanMessages = (root: ParentNode) => {
    for (const sel of gmeetChatMessageSelectors) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) { nodes.forEach((n) => emit(n)); return; }
    }
  };

  const findContainer = (): Element | null => {
    for (const sel of gmeetChatContainerSelectors) {
      const el = document.querySelector(sel);
      if (el) { matchedContainer = sel; return el; }
    }
    return null;
  };

  const observer = new MutationObserver(() => { if (container) scanMessages(container); });
  const attach = () => {
    // Re-open first: a collapsed panel unmounts the list, so without this the observer has nothing
    // to attach to and the reader goes quiet for the rest of the meeting.
    if (autoOpen && ensureGmeetChatOpen()) log('chat panel was closed - reopened');
    const found = findContainer();
    if (found && found !== container) {
      container = found;
      observer.disconnect();
      observer.observe(container, { childList: true, subtree: true });
      scanMessages(container);
      log(`chat container matched: ${matchedContainer}`);
    } else if (found) {
      scanMessages(found);
    }
  };
  attach();
  const poll = setInterval(attach, opts.pollMs ?? 2000);

  return {
    destroy() { clearInterval(poll); observer.disconnect(); },
    getState() {
      let sample: { sel: string; structure: string[] } | null = null;
      if (container) {
        for (const sel of gmeetChatMessageSelectors) {
          const n = container.querySelector(sel);
          if (n) { sample = { sel, structure: dumpNode(n) }; break; }
        }
      }
      return {
        matchedContainer,
        panelOpen: isGmeetChatOpen(),
        seen: seenHashes.size,
        recent: recent.slice(-10),
        candidates: gmeetChatContainerSelectors.map((sel) => ({ sel, count: document.querySelectorAll(sel).length })),
        sample,
      };
    },
  };
}
