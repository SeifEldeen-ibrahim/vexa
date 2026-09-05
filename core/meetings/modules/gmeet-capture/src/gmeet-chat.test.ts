/**
 * gmeet-capture L2 (chat) — the reader's extraction/dedup/echo rules and the sender's
 * React-controlled-input handling, against a REAL DOM (jsdom, like join-cta.test.ts).
 *
 * jsdom rather than a hand shim on purpose: this module's entire job is DOM manipulation, so a shim
 * written to match my own selectors would mostly test itself. jsdom brings the real CSS engine
 * (attribute + case-insensitive matchers), real property descriptors (which is what `setReactValue`
 * depends on) and real event dispatch.
 *
 * What this does NOT prove: that these selectors match TODAY's Google Meet. Meet's DOM is obfuscated
 * and unstable — only a live meeting proves that, which is what `getState()` telemetry exists for.
 * What it does prove is that when a selector matches, the surrounding logic is right.
 *
 * Run: npx tsx src/gmeet-chat.test.ts   (the package's `npm test` chains it)
 */
import { JSDOM } from 'jsdom';
import {
  createGmeetChat,
  sendGmeetChatMessage,
  ensureGmeetChatOpen,
  isGmeetChatOpen,
  wasSentByUs,
  scrapeGmeetParticipantEmails,
  type GmeetChatMessage,
} from './gmeet-chat.js';

let failed = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };

/** Install a document as the global — the module reads `document` directly so it survives
 *  serialization into page.evaluate. */
function mount(html: string): { window: any; document: Document } {
  const dom = new JSDOM(`<body>${html}</body>`);
  (globalThis as any).document = dom.window.document;
  (globalThis as any).MutationObserver = dom.window.MutationObserver;
  (globalThis as any).Event = dom.window.Event;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  (globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
  return { window: dom.window, document: dom.window.document };
}

const msgRow = (id: string, sender: string, text: string) =>
  `<div data-message-id="${id}" data-sender-name="${sender}" data-message-text="${text}"></div>`;

const panel = (rows: string) => `<div role="log" aria-live="polite">${rows}</div>`;

// ── reading ─────────────────────────────────────────────────────────────────
console.log('gmeet-chat: reading');
{
  mount(panel(msgRow('1', 'Ada', 'hello there') + msgRow('2', 'Grace', 'hi Ada')));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('emits every message already in the panel', seen.length === 2);
  check('carries sender and text', seen[0].sender === 'Ada' && seen[0].text === 'hello there');
  check('getState reports the matched container', chat.getState().matchedContainer !== null);
  check('getState counts what it has seen', chat.getState().seen === 2);
  chat.destroy();
}

{
  // Meet re-renders the SAME message as a new node on scroll / panel reopen, and the WeakSet only
  // catches node identity — the (sender, text) hash is what stops a duplicate emit.
  mount(panel(msgRow('1', 'Ada', 'hello') + msgRow('2', 'Ada', 'hello')));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('dedups a re-rendered (sender, text) pair across distinct nodes', seen.length === 1);
  chat.destroy();
}

{
  // ECHO CONTROL: the bot must never emit its own messages, or anything auto-replying to chat
  // proceeds to answer itself in a loop.
  mount(panel(msgRow('1', 'Vexa', 'my own reply') + msgRow('2', 'Ada', 'a real question')));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), selfName: 'Vexa', autoOpen: false });
  check('suppresses the bot\'s own message by name', !seen.some((m) => m.text === 'my own reply'));
  check('still emits a real participant\'s message', seen.some((m) => m.text === 'a real question'));
  chat.destroy();
}

{
  // Meet labels the local participant "You" in some builds.
  mount(panel(msgRow('1', 'You', 'mine') + msgRow('2', 'Ada', 'theirs')));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), selfName: 'Vexa', autoOpen: false });
  check('suppresses a message attributed to "You"', !seen.some((m) => m.text === 'mine'));
  check('emits the other participant', seen.some((m) => m.text === 'theirs'));
  chat.destroy();
}

{
  // Fallback path: no data-* attributes, only nested text (a Meet build whose attributes moved).
  mount(panel(
    '<div data-message-id="1"><div data-sender-name="Ada"></div><span>Ada</span><span>a much longer message body</span></div>',
  ));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('falls back to the largest leaf text as the body', seen[0]?.text === 'a much longer message body');
  chat.destroy();
}

{
  // A timestamp trailing the sender must not become part of the name.
  mount(panel('<div data-message-id="1" data-sender-name="Ada 10:42" data-message-text="hi"></div>'));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('strips a trailing timestamp from the sender', seen[0]?.sender === 'Ada');
  chat.destroy();
}

{
  // An empty body is not a message.
  mount(panel('<div data-message-id="1" data-sender-name="Ada" data-message-text="   "></div>'));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('drops a whitespace-only message', seen.length === 0);
  chat.destroy();
}

{
  // A throwing consumer must never break capture.
  mount(panel(msgRow('1', 'Ada', 'hi')));
  let reached = false;
  const chat = createGmeetChat({
    onMessage: () => { reached = true; throw new Error('consumer blew up'); },
    autoOpen: false,
  });
  check('survives a throwing onMessage', reached);
  chat.destroy();
}

// ── the two defects the live meeting found ──────────────────────────────────
console.log('gmeet-chat: live-found defects');
{
  // The sender fallback used to be nested inside `if (!text)`, so a row whose BODY matched a
  // selector never had its sender recovered — live, EVERY message came back "Unknown".
  mount(panel('<div data-message-id="1" data-message-text="the body text"><span>Ada Lovelace</span></div>'));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('recovers the sender even when the body matched a selector', seen[0]?.sender === 'Ada Lovelace');
  check('still carries the right body', seen[0]?.text === 'the body text');
  chat.destroy();
}

{
  // Live, a message's author came out as "keep" — the Google Keep action label inside the row.
  mount(panel('<div data-message-id="1" data-message-text="hello"><span>keep</span><span>Ada</span></div>'));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('skips UI chrome when guessing the sender', seen[0]?.sender === 'Ada');
  chat.destroy();
}

{
  // ECHO: Meet gave the bot's own reply no resolvable author, so the NAME guard let it read itself
  // back. The text guard is the one that has to hold.
  const { document } = mount(
    '<div role="log" aria-live="polite"></div>' +
    '<textarea aria-label="Send a message to everyone"></textarea>',
  );
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), selfName: 'Vexa', autoOpen: false });
  sendGmeetChatMessage('Doing well, thanks for asking!');
  check('remembers what it sent', wasSentByUs('Doing well, thanks for asking!'));
  // Meet echoes it back into the panel with NO resolvable sender (exactly what happened live).
  document.querySelector('[role="log"]')!.innerHTML =
    '<div data-message-id="9" data-message-text="Doing well, thanks for asking!"></div>';
  const chat2 = createGmeetChat({ onMessage: (m) => seen.push(m), selfName: 'Vexa', autoOpen: false });
  check('does NOT read its own message back, despite an unresolved sender',
    !seen.some((m) => m.text === 'Doing well, thanks for asking!'));
  chat.destroy(); chat2.destroy();
}

{
  mount('<textarea aria-label="Send a message to everyone"></textarea>');
  sendGmeetChatMessage('exact text');
  check('matches an echo whose whitespace Meet collapsed', wasSentByUs('exact   text'));
  check('does not claim an unrelated message as its own', !wasSentByUs('something else entirely'));
}

{
  // THE REAL SHAPE, from a live meeting's log. The row carries NO author at all:
  //   ["div.jO4O1","div.ptNLrf","div[jsname=dTKtvb]","div >marcin said sooo"]
  // Meet renders one header per RUN of messages, as a SIBLING above the rows — so the author can
  // only be found by looking before the row in document order, never inside it.
  mount(panel(
    '<div class="group">' +
      '<div class="hdr"><span>Marcin Kowalski</span></div>' +
      '<div data-message-id="1"><div class="jO4O1"></div><div jsname="dTKtvb">marcin said sooo</div></div>' +
      '<div data-message-id="2"><div jsname="dTKtvb">and then this</div></div>' +
    '</div>',
  ));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('finds the sender in the group header above the row', seen[0]?.sender === 'Marcin Kowalski');
  check('attributes the SECOND message of a run to the same header', seen[1]?.sender === 'Marcin Kowalski');
  check('still carries each body', seen.map((m) => m.text).join('|') === 'marcin said sooo|and then this');
  chat.destroy();
}

{
  // No header anywhere: report Unknown honestly rather than inventing an author.
  mount(panel('<div data-message-id="1"><div jsname="dTKtvb">orphan message</div></div>'));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('says Unknown when there is genuinely no author to find', seen[0]?.sender === 'Unknown');
  chat.destroy();
}

{
  // A timestamp sibling must not be mistaken for a name.
  mount(panel(
    '<div class="group"><div>10:42</div><div><span>Ada</span></div>' +
    '<div data-message-id="1"><div jsname="dTKtvb">hello</div></div></div>',
  ));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('skips a timestamp when scanning back for the header', seen[0]?.sender === 'Ada');
  chat.destroy();
}

// ── identity: the email, where Meet exposes one ─────────────────────────────
// Meet's CHAT carries a display name and no address. An email — the only tight identity available —
// has to come from the people panel, and Meet shows one for some participants and not others. These
// pin the extraction; whether a given meeting HAS emails is reported by getState().emails, not
// assumed.
console.log('gmeet-chat: identity');
{
  mount(
    '<div aria-label="Participants">' +
      '<div role="listitem"><span>Seif Ibrahim</span><span>seif@biami.io</span></div>' +
      '<div role="listitem"><span>Marcin Kowalski</span><span>marcin@other.test</span></div>' +
    '</div>',
  );
  const got = scrapeGmeetParticipantEmails();
  check('reads name -> email out of the people panel',
    got['seif ibrahim'] === 'seif@biami.io' && got['marcin kowalski'] === 'marcin@other.test');
}

{
  // The common case: Meet shows names only. An empty map is a real answer, not a failure.
  mount('<div aria-label="Participants"><div role="listitem"><span>Seif Ibrahim</span></div></div>');
  check('returns nothing when Meet exposes no address', Object.keys(scrapeGmeetParticipantEmails()).length === 0);
}

{
  mount('<div></div>');
  check('survives having no people panel at all', Object.keys(scrapeGmeetParticipantEmails()).length === 0);
}

{
  // A chat message carries the sender's email when the panel gave one.
  mount(
    '<div aria-label="Participants"><div role="listitem"><span>Ada Lovelace</span>' +
      '<span>ada@example.test</span></div></div>' +
    panel('<div data-message-id="1" data-sender-name="Ada Lovelace" data-message-text="hello"></div>'),
  );
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('attaches the sender email to the message', seen[0]?.senderEmail === 'ada@example.test');
  check('getState reports which identities were resolvable',
    chat.getState().emails['ada lovelace'] === 'ada@example.test');
  chat.destroy();
}

{
  mount(panel('<div data-message-id="1" data-sender-name="Ada" data-message-text="hi"></div>'));
  const seen: GmeetChatMessage[] = [];
  const chat = createGmeetChat({ onMessage: (m) => seen.push(m), autoOpen: false });
  check('omits the email rather than inventing one', seen[0]?.senderEmail === undefined);
  chat.destroy();
}

// ── panel state ─────────────────────────────────────────────────────────────
console.log('gmeet-chat: panel');
{
  mount('<button aria-label="Chat with everyone"></button>');
  check('reports the panel closed when only the toggle exists', isGmeetChatOpen() === false);
  const clicked = ensureGmeetChatOpen();
  check('clicks the toggle when the panel is closed', clicked === true);
}
{
  mount(panel(''));
  check('reports the panel open when the message list is mounted', isGmeetChatOpen() === true);
  check('does not re-click an already-open panel', ensureGmeetChatOpen() === false);
}
{
  mount('<div></div>');
  check('reports no click when there is no toggle at all', ensureGmeetChatOpen() === false);
}

// ── sending ─────────────────────────────────────────────────────────────────
console.log('gmeet-chat: sending');
{
  const { document } = mount(
    '<textarea aria-label="Send a message to everyone"></textarea>' +
    '<button aria-label="Send a message"></button>',
  );
  const input = document.querySelector('textarea')! as HTMLTextAreaElement;
  const button = document.querySelector('button')!;
  let inputEvents = 0;
  let clicks = 0;
  input.addEventListener('input', () => { inputEvents++; });
  button.addEventListener('click', () => { clicks++; });

  const ok = sendGmeetChatMessage('hello meeting');
  check('reports success', ok === true);
  check('writes the text into the composer', input.value === 'hello meeting');
  // React listens for `input`; a bare `.value =` assignment fires nothing and Meet submits empty.
  check('dispatches a bubbling input event so React sees the change', inputEvents === 1);
  check('clicks the send button', clicks === 1);
}

{
  // No send button: fall back to Enter.
  const { document } = mount('<textarea aria-label="Send a message to everyone"></textarea>');
  const input = document.querySelector('textarea')! as HTMLTextAreaElement;
  const keys: string[] = [];
  for (const t of ['keydown', 'keypress', 'keyup']) input.addEventListener(t, (e: any) => keys.push(`${t}:${e.key}`));
  const ok = sendGmeetChatMessage('via enter');
  check('reports success without a send button', ok === true);
  check('presses Enter as the fallback', keys.includes('keydown:Enter') && keys.includes('keyup:Enter'));
}

{
  // A disabled send button means Meet has not accepted the text — fall through to Enter.
  const { document } = mount(
    '<textarea aria-label="Send a message to everyone"></textarea>' +
    '<button aria-label="Send a message" disabled></button>',
  );
  const input = document.querySelector('textarea')! as HTMLTextAreaElement;
  let keydowns = 0;
  input.addEventListener('keydown', () => { keydowns++; });
  sendGmeetChatMessage('x');
  check('does not rely on a disabled send button', keydowns === 1);
}

{
  mount('<div></div>');
  check('returns false when the composer is unreachable', sendGmeetChatMessage('nowhere') === false);
}
{
  mount('<textarea aria-label="Send a message to everyone"></textarea>');
  check('refuses an empty message', sendGmeetChatMessage('   ') === false);
}
{
  // contenteditable composer variant.
  const { document } = mount('<div contenteditable="true" aria-label="Send a message to everyone"></div>');
  const ok = sendGmeetChatMessage('editable path');
  check('handles a contenteditable composer', ok === true &&
    document.querySelector('[contenteditable]')!.textContent === 'editable path');
}

console.log(failed === 0 ? '\ngmeet-chat: all checks passed' : `\ngmeet-chat: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
