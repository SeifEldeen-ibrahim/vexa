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

export function createGmeetChat(opts: GmeetChatOptions): GmeetChat {
  const log = opts.log || (() => {});
  const autoOpen = opts.autoOpen !== false;
  const self = (opts.selfName || '').trim().toLowerCase();
  const seenNodes = new WeakSet<Element>();
  const seenHashes = new Set<string>();
  const recent: GmeetChatMessage[] = [];
  let matchedContainer: string | null = null;
  let container: Element | null = null;

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

    // Grouped runs: Meet renders one header for consecutive messages from the same person, so the
    // sender lives on an ancestor rather than the row.
    if (!sender) {
      let cur: Element | null = node.parentElement;
      for (let i = 0; i < 4 && cur && !sender; i++, cur = cur.parentElement) {
        sender = cur.getAttribute?.('data-sender-name') || textOf(cur, gmeetChatSenderSelectors);
      }
    }
    // Body fallback: the largest leaf text in the row.
    if (!text) {
      const frags = Array.from(node.querySelectorAll('*'))
        .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
        .filter((t) => t.length > 0);
      if (!frags.length) return null;
      text = frags.reduce((a, b) => (b.length > a.length ? b : a), '');
      if (!sender) {
        const short = frags.find((f) => f !== text && f.length <= 40 && !/^\d{1,2}:\d{2}/.test(f));
        if (short) sender = short;
      }
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
