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

export interface GmeetChatMessage {
  sender: string;
  text: string;
  /** The sender's email, when Meet exposes one. Absent on most calls — see `senderEmail`. */
  senderEmail?: string;
  /** True when the roster confirms exactly ONE person in the room uses this display name. Absent
   *  when there is no roster at all — which is "unknown", not "unique". */
  senderNameUnique?: boolean;
  /** True when TWO OR MORE people in the room are using this display name. A chat message carries
   *  only a name, so in that case there is no way to tell which of them sent it — and the honest
   *  answer is to say so rather than to guess. */
  senderAmbiguous?: boolean;
}

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
    /** display name (lower-cased) -> email, for participants Meet exposed one for. Empty means this
     *  meeting gives the bot no email identity at all. */
    emails: Record<string, string>;
    /** display name (lower-cased) -> how many people in the room use it. >1 means a chat message
     *  from that name cannot be attributed to a person. */
    nameCounts: Record<string, number>;
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
// The people/participants panel, and anything in it that carries an email. Meet shows an address
// for some accounts (commonly same-org) and nothing for others, so this is BEST EFFORT by
// construction — `getState().emails` reports what was actually found so a deployment can see whether
// identity is available to it at all rather than taking anyone's word for it.
export const gmeetPeoplePanelSelectors: string[] = [
  '[aria-label*="Participants" i]',
  '[aria-label*="People" i]',
  'div[jsname="jrQDbd"]',
  '[role="list"][aria-label*="articipant" i]',
];
export const gmeetPeopleToggleSelectors: string[] = [
  'button[aria-label*="Show everyone" i]',
  'button[aria-label*="People" i]',
  'button[aria-label*="Participants" i]',
];

/** Any email-looking string inside an element's text or its attributes. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

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

/** Every participant row the people panel shows, as `{ name, email? }` — duplicates INCLUDED.
 *
 *  Kept separate from the name→email map because that map collapses duplicates by construction, and
 *  duplicates are exactly what has to be detected: two people using one display name is the case a
 *  chat message cannot disambiguate. */
export function scrapeGmeetParticipantRows(): Array<{ name: string; email?: string }> {
  const rows: Array<{ name: string; email?: string }> = [];
  try {
    const panel = firstMatch(document, gmeetPeoplePanelSelectors);
    const root: ParentNode = panel || document.body;
    for (const row of Array.from(root.querySelectorAll('[role="listitem"], li, div[data-participant-id]'))) {
      const frags = Array.from(row.querySelectorAll('*'))
        .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
        .filter((t) => t.length > 0);
      const name = frags.find((f) => !EMAIL_RE.test(f) && looksLikeName(f));
      if (!name) continue;
      let email: string | undefined;
      for (const c of [...frags, row.getAttribute('aria-label') || '', row.getAttribute('title') || '']) {
        const m = c.match(EMAIL_RE);
        if (m) { email = m[0].toLowerCase(); break; }
      }
      rows.push(email ? { name: name.trim(), email } : { name: name.trim() });
    }
  } catch {
    /* identity is best effort; never disturb capture */
  }
  return rows;
}

/** How many people in the room are using each display name (lower-cased). */
export function participantNameCounts(rows: Array<{ name: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r.name.trim().toLowerCase();
    if (k) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** Scrape the people panel for `display name -> email`, where Meet exposes one.
 *
 *  Meet's CHAT carries a display name and nothing else, so an email — the only identity worth
 *  gating on — has to come from somewhere else if it is available at all. The people panel is that
 *  somewhere: for some accounts (typically inside the same Workspace org) a row carries an address
 *  in its text or an aria-label; for others it carries only a name.
 *
 *  Returns whatever it found. An empty map is a real answer — it means this deployment cannot do
 *  email matching for this meeting, and the caller must say so rather than silently fall back to
 *  something looser without telling anyone. */
export function scrapeGmeetParticipantEmails(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const panel = firstMatch(document, gmeetPeoplePanelSelectors);
    const roots: Element[] = panel ? [panel] : [document.body];
    for (const root of roots) {
      for (const row of Array.from(root.querySelectorAll('[role="listitem"], li, div[data-participant-id]'))) {
        // Each candidate string is examined SEPARATELY. Concatenating them (row.textContent) glues
        // the name onto the address — "Seif Ibrahim" + "seif@biami.io" reads as
        // "Ibrahimseif@biami.io", which is a perfectly valid-looking and completely wrong email.
        const frags = Array.from(row.querySelectorAll('*'))
          .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
          .filter((t) => t.length > 0);
        const candidates = [
          ...frags,
          row.getAttribute('aria-label') || '',
          row.getAttribute('data-tooltip') || '',
          row.getAttribute('title') || '',
        ];
        let email = '';
        for (const c of candidates) {
          const m = c.match(EMAIL_RE);
          if (m) { email = m[0]; break; }
        }
        if (!email) continue;
        // The name is the first name-like leaf that is not the address itself.
        const name = frags.find((f) => !EMAIL_RE.test(f) && looksLikeName(f));
        if (name) out[name.trim().toLowerCase()] = email.toLowerCase();
      }
    }
  } catch {
    /* identity is best effort; never disturb capture */
  }
  return out;
}

/** Open the people panel if it is closed, so `scrapeGmeetParticipantEmails` has something to read. */
export function ensureGmeetPeopleOpen(): boolean {
  if (firstMatch(document, gmeetPeoplePanelSelectors)) return false;
  const toggle = firstMatch(document, gmeetPeopleToggleSelectors) as HTMLElement | null;
  if (!toggle) return false;
  toggle.click();
  return true;
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
  let emails: Record<string, string> = {};
  let nameCounts: Record<string, number> = {};
  let rosterReported = false;

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
    // Attach the sender's email when this meeting exposes one. Absent is normal and is reported
    // through getState().emails rather than guessed at.
    const key = sender.trim().toLowerCase();
    const senderEmail = emails[key];
    const msg: GmeetChatMessage = { sender, text };
    if (senderEmail) msg.senderEmail = senderEmail;
    // Two people on one display name: a chat line cannot say which of them wrote it. Exactly one:
    // within this room, the name does identify them. Zero (no roster): neither — say nothing.
    const count = nameCounts[key] || 0;
    if (count > 1) msg.senderAmbiguous = true;
    else if (count === 1) msg.senderNameUnique = true;
    return msg;
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
    // Refresh the identity map each poll: people join mid-call, and the people panel may only be
    // opened after the first messages have already arrived.
    //
    // The panel has to be OPENED first. Without this the scraper had nothing to read on every real
    // meeting — an email was never once resolved, and the whole email path was dead code that
    // silently degraded to name matching.
    if (autoOpen) ensureGmeetPeopleOpen();
    const rows = scrapeGmeetParticipantRows();
    // Report the roster ONCE, whatever it contains. Logging only on success cannot tell an open
    // panel that carries no emails apart from a panel that never opened — which is exactly the
    // question that decides whether DOM scraping can carry identity at all, and it cost a live
    // meeting to notice.
    if (!rosterReported) {
      rosterReported = true;
      const panel = firstMatch(document, gmeetPeoplePanelSelectors);
      log(`people panel: ${panel ? 'OPEN (' + rows.length + ' row(s))' : 'NOT FOUND'}; ` +
          `with an email: ${rows.filter((r) => r.email).length}; ` +
          `sample: ${JSON.stringify(rows.slice(0, 4))}`);
    }
    if (rows.length) {
      const counts = participantNameCounts(rows);
      const dupes = Object.entries(counts).filter(([, n]) => n > 1).map(([n]) => n);
      if (dupes.length && JSON.stringify(counts) !== JSON.stringify(nameCounts)) {
        log(`DUPLICATE display names in the room: ${JSON.stringify(dupes)} - messages from them cannot be attributed`);
      }
      nameCounts = counts;
    }
    const foundEmails = scrapeGmeetParticipantEmails();
    if (Object.keys(foundEmails).length) {
      const before = Object.keys(emails).length;
      emails = { ...emails, ...foundEmails };
      if (Object.keys(emails).length !== before) {
        log(`participant emails resolved: ${JSON.stringify(emails)}`);
      }
    }
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
        emails,
        nameCounts,
        panelOpen: isGmeetChatOpen(),
        seen: seenHashes.size,
        recent: recent.slice(-10),
        candidates: gmeetChatContainerSelectors.map((sel) => ({ sel, count: document.querySelectorAll(sel).length })),
        sample,
      };
    },
  };
}
