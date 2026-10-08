# nexus-extension — Nexus live meetings (Chrome, MV3)

The extension for a meeting that happens **in a room**. Sign in with Google, write down what the
meeting has to cover, press Start, and watch each line get ticked off as the room covers it.

It is a small extension on purpose: it captures the microphone and renders a checklist. All the
work — transcription, judging what was covered, the meeting record — happens in the
[`live` service](../../core/meetings/services/live/), so nothing sensitive and nothing clever
lives in the browser.

```
  side panel  ─ New call │ History ─────────────────────────────┐
      │ Start (title + checklist)                              │
      ▼                                                        │ poll ~4s
  service worker ──► POST https://nexus.biami.io/live/sessions ─┘
      │  (owns the credential, the socket and the call state)
      ├──► offscreen document ─► getUserMedia ─► AudioWorklet ─► 16 kHz PCM
      └──► wss://nexus.biami.io/live/ingest   (capture.v1 frames)
```

## Install it

```bash
npm install
npm run package          # → dist/ and nexus-extension-<version>.zip
```

Then either:

* **Load unpacked** (what you want while testing): `chrome://extensions` → turn on **Developer
  mode** → **Load unpacked** → pick the `dist/` folder.
* **Hand someone the zip**: they unzip it and load that folder the same way.
* **Publish**: upload the same zip to the Chrome Web Store (a developer account and a review
  round), or host it for force-install via enterprise policy. Nothing in the code changes between
  these — only how it is delivered.

`npm run dev` rebuilds on change; press the reload button on the extension card afterwards.

## First run

1. Open the side panel (click the toolbar icon).
2. **Sign in with Google** — this opens `nexus.biami.io/extension/connect` inside Chrome's auth
   flow. The terminal is the OAuth broker; this extension never talks to Google, and after one
   explicit **Connect** click it receives a Nexus API token (scopes `bot,tx`, named
   `nexus-extension`, revocable from API tokens in Nexus).
3. Chrome asks for the **microphone** once, on the extension's own permission page. Nothing is
   captured until you press Start on a call.

## Using it

**New call** — type what the meeting is, then either pick a checklist you have used before (the
lists come from your own past calls, so a list becomes reusable by being used) or type a fresh
one, one item per line. Press Start.

**During the call** — each item shows as *not yet*, *started* or *covered*, with the quote from
the room that earned the tick and the time it happened. Items you have not dealt with stay at the
top. A dot shows whether Nexus is actually hearing anything — if the microphone dies, it says so
rather than looking fine.

**History** — your past in-person calls and how much of each checklist was covered. The full
transcript lives in Nexus itself.

## Design notes worth knowing

* **The side panel, not a popup.** A popup closes the moment you click anything else, and this is
  a surface you glance at while talking to people.
* **The service worker owns the call**, not the panel. Closing the panel cannot stop a recording.
* **The microphone lives in an offscreen document**, because an MV3 service worker has no DOM and
  is killed when idle — capture there would stop mid-meeting.
* **A dropped socket is not the end of a call.** An alarm wakes the worker every ~20 s and
  re-opens it; the service keeps the meeting alive for its idle window. A wifi blip costs seconds
  of audio, not the meeting.
* **The token rides a WebSocket subprotocol** (`nexus-token.<key>`), because a browser cannot set
  headers on `new WebSocket()`. The server selects `capture.v1` and never echoes the token back,
  so it stays out of URLs and access logs.
* **No speaker names.** One microphone in a room cannot tell who is talking (see the service's
  README); the transcript is turns, not people.

## Tests

`npm test` — `api.test.ts` (the client and its error wording) and `agenda-view.test.ts` (how the
checklist reads and sorts). Both run in node, no browser.
