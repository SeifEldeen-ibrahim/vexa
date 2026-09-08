# Plan — (A) bot name + language in the new Terminal join, (B) the agent reads and writes Google Meet chat

Fork context: `/home/biami/vexa`, local fork on `main`, deployed at https://nexus.biami.io.
Run with `make -C deploy/compose local`. Every claim below carries a `file:line` anchor read this
session; anything I did NOT verify is labelled **UNVERIFIED**.

---

## Part A — restore bot name + language to the join flow

### Where we are (honest)

The old UI is `clients/dashboard`, **deleted** in commit `deefda3b` ("chore: drop the stale vendored
dashboard client"). Its join form is still readable:

- `git show deefda3b^:clients/dashboard/src/components/join/join-form.tsx` — bot name (a text input,
  persisted to `localStorage["vexa-join-bot-name"]`, default `"Vexa"`), language (`"auto"` default),
  `transcribe_enabled`, `authenticated`, passcode. Sends `bot_name` always and `language` only when
  it is not `"auto"` (lines 97-117 of that file).
- `git show deefda3b^:clients/dashboard/src/components/language-picker.tsx` — a searchable combobox
  with a recents list, over `WHISPER_LANGUAGE_NAMES`.
- `git show deefda3b^:clients/dashboard/src/lib/languages.ts` — 100 Whisper codes + display names,
  plus `getRecentLanguageCodes` / `saveRecentLanguage` / `getLanguageDisplayName`.

The new Terminal hardcodes the name and never sends a language. Five call sites build a
`POST /api/bots` body, each independently:

| # | Site | What it sends today |
|---|---|---|
| 1 | `clients/terminal/src/surfaces/meeting.tsx:723` — sidebar "Add bot" | `bot_name: defaultBotName()`, no language |
| 2 | `clients/terminal/src/surfaces/meeting.tsx:345` — row `send` / `re-send` action | same |
| 3 | `clients/terminal/src/surfaces/meetingsOnboarding.tsx:168` — first-run "Drop a bot" | same |
| 4 | `clients/terminal/src/surfaces/meetingPrep.tsx:247` — prep page "Send bot" | same |
| 5 | `clients/terminal/src/surfaces/meetingCookbook.ts:47` | already takes an optional `bot_name` input |

`defaultBotName()` (`clients/terminal/src/surfaces/defaultBotName.ts:11`) reads
`NEXT_PUBLIC_DEFAULT_BOT_NAME`, which Next inlines **at build time** — so today renaming the bot
costs an image rebuild. That is the whole reason #1259 exists.

**The backend already accepts both — no server change is needed for Part A.** Verified end to end:

- `core/meetings/services/meeting-api/src/meeting_api/bot_spawn/router.py:447,451` —
  `bot_name=body.get("bot_name")`, `language=body.get("language")`
- → `bot_spawn/service.py:384,713` → `bot_spawn/invocation.py:139,176` → `"language"` on `invocation.v1`
- → `core/meetings/services/bot/src/config.ts:73` → `gmeet-pipeline/src/gmeet-pipeline.ts:68`
- → `core/meetings/modules/whisper/src/transcription-client.ts:209-213` — a `language` multipart field
  on the STT request.

There is **no server-side allow-list** for `language` (grep for `ACCEPTED_LANGUAGE_CODES` returns
nothing in this tree) — an unknown code is passed straight to the STT backend. So the picker's list
is the only validation, and it should stay a closed list.

Why this matters beyond parity: on this deployment auto-detect is measurably wrong on short windows
(it produced Spanish/German/Indonesian/Portuguese for English speech), and forcing `language` on the
spawn fixes it. The UI's inability to send it is the reason we can't apply the known fix.

### The change

**A1. One body builder, one prefs store — `clients/terminal/src/surfaces/joinPrefs.ts` (new).**
- Port `WHISPER_LANGUAGE_NAMES` (100 codes) + the recents helpers from the deleted `lib/languages.ts` (same
  repo, Apache-2.0, no new dependency — the FINOS licence gate is untouched).
- `readJoinPrefs()` / `writeJoinPrefs()` over `localStorage`: `vexa.join.botName` (falling back to
  `defaultBotName() ?? "Vexa"`), `vexa.join.language` (default `"auto"`), `vexa.join.recentLangs`.
- `joinBody({ platform, native_meeting_id, meeting_url? }, overrides?)` — **the single place** that
  shapes the `POST /api/bots` body:
  `{ platform, native_meeting_id, ...(meeting_url && {meeting_url}), bot_name, ...(language !== "auto" && {language}) }`.
  All five sites call it. This is the point-of-introduction fix: the drift that let one site diverge
  from another is structurally gone, and `language` can never again be silently dropped.

**A2. A language combobox — `clients/terminal/src/ui-kit/LanguageSelect.tsx` (new).**
The old picker used shadcn/radix `Popover` + `ScrollArea`, which this tree does not have. **Do not
add them** (new deps must be FINOS Category A and get an ADR-0004 review). Build it from the ui-kit
that exists: a trigger button + a filtered list positioned like
`clients/terminal/src/ui-kit/ContextMenu.tsx`, with a search input, "Auto-detect" pinned at the top,
and recents above the full list. Keyboard: type to filter, ↑/↓, Enter, Escape.

**A3. The sidebar composer grows an options row — `meeting.tsx` `MeetingsList` (~line 750-770).**
Under the link input, a small `▾ Options` disclosure revealing `[ Bot name ] [ Language ▾ ]`.
Collapsed by default so the quiet-at-rest look of the rail is preserved; the disclosure shows a
one-line summary when either value is non-default (e.g. `Nexus · English`). Values persist via A1.

**A4. The other four sites read the stored prefs, no UI of their own.**
`meetingsOnboarding.tsx` gets the same disclosure (it is the first-run surface where naming the bot
matters most); `meetingPrep.tsx` and the row `send`/`resend` action just call `joinBody()`.

**A5. `defaultBotName()` stays as the fallback**, so an operator's `NEXT_PUBLIC_DEFAULT_BOT_NAME`
still seeds the field on a fresh browser — but a user's typed name now wins without a rebuild.

**Deliberately NOT in scope (say so, don't silently drop):** a server-persisted per-user default
(would need an admin-api prefs key), `transcribe_enabled` / `authenticated` / passcode toggles from
the old form, and mid-meeting language change via the sealed `PUT /bots/{platform}/{native}/config`
(→ acts.v1 `reconfigure`, which the bot already honours). Each is a follow-up, not this change.

### Acceptance (Part A)

| # | Observation | Method |
|---|---|---|
| A-1 | Typing a bot name in the sidebar and sending shows that name as the participant in Google Meet | live meeting, Meet participant list |
| A-2 | The same name survives a reload (localStorage) and does not need a rebuild | browser, no redeploy |
| A-3 | Selecting `English` sends `"language":"en"` on `POST /bots` | `docker compose logs meeting-api` request body / DevTools network |
| A-4 | `Auto-detect` omits the key entirely (negative control) | same |
| A-5 | The forced language reaches the STT request | `docker compose logs` on the bot container — the multipart `language` field, `transcription-client.ts:209` |
| A-6 | With `language=en` forced, an English utterance is no longer transcribed as Spanish/Portuguese | live meeting, compare against a recorded auto-detect run |
| A-7 | All five call sites send the prefs | unit test over `joinBody` + a grep proving no remaining literal `bot_name:` outside `joinPrefs.ts` |

---

## Part B — the Google Meet chat as the Assistant tab

### Where we are (honest)

**The contract already exists.** `core/meetings/contracts/acts.v1/acts.schema.json` declares
`chat_send` and `chat_read` on the control-plane → bot redis bus
`bot_commands:meeting:{meeting_id}` (`core/meetings/services/bot/src/contracts.ts:107-108,124`).
`core/gateway/contracts/api.v1/api.schema.json` declares `POST` and `GET`
`/bots/{platform}/{native_meeting_id}/chat`.

**Four of the five hops are missing, and each is a distinct, verified gap:**

1. **No Google Meet chat module at all.** `core/meetings/modules/` has `teams-capture/src/teams-chat.ts`,
   `zoom-capture/src/zoom-chat.ts` and `jitsi-capture/src/jitsi-chat.ts`. There is no `gmeet-chat.ts`.
   The only Meet chat reference in the tree is a *join-admission indicator*
   (`core/meetings/modules/join/src/googlemeet/selectors.ts:134-135`), not a reader.
2. **The bot ignores `chat_send`/`chat_read`.** `core/meetings/services/bot/src/index.ts:119-124`
   (`voiceHandler`) routes only `speak` and `speak_stop` — its own comment says chat is "out of this
   increment's scope". Both chat actions parse fine and then fall on the floor.
3. **`POST /bots/{…}/chat` is unimplemented and formally waived.**
   `core/gateway/contracts/api.v1/KNOWN_GAPS.json` carries the row with the reason
   *"No bot-command (send-to-meeting) backend in the 0.12 core"*. The gateway forwards only the GET
   (`core/gateway/services/gateway/src/gateway/app.py:673-675`); the POST is not registered.
   meeting-api's GET returns a hardcoded `{"messages": []}`
   (`core/meetings/services/meeting-api/src/meeting_api/collector/app.py:646-659`) — honest, but empty.
4. **`voiceAgentEnabled` has no producer.** It is a sealed `invocation.v1` field
   (`core/meetings/contracts/invocation.v1/invocation.schema.json:48`) and the bot gates every
   voice/chat act on it (`capture-bridge.ts:1438,1465`), but `build_invocation`
   (`bot_spawn/invocation.py:129-200`) never sets it — grep for `voiceAgentEnabled` across
   `meeting-api/src` returns **nothing**. **This is the root cause of the "speak 404s / speak is
   proven but unreachable" story**: even a correctly-published act is dropped by the bot. Nothing in
   this family can work until a producer exists.

**One hop already works and we should reuse it.** The jitsi lane proves the read path end to end:
`capture-bridge.ts:1257-1262` instantiates `createJitsiChat` in the page → calls the exposed
`__vexaChatMessage` (`capture-bridge.ts:791-793`) → `index.ts:266-284` `publishChat` publishes a
`transcript.v1` segment with `source: 'chat'`, `speaker: <sender>`, `speaker_key: chat:<sender>`.
That segment rides `transcription_segments`, the same durable stream the agent's watcher already
consumes (`core/agent/control_plane/transcription_watcher.py:37` `SRC`). **So a Meet chat message can
reach the agent with zero new transport** — we only have to produce it.

**The assistant turn is already a reusable shape.** `POST /api/chat`
(`core/agent/control_plane/api.py:1181-1272`) grounds the prompt (`_context_grounding`), dispatches
`units.make_dispatch(subject=…, trigger="message", …)`, and streams the unit's output Stream back as
SSE. Meeting-phase steering already exists in `core/agent/control_plane/meeting_steering.py`
(prep / live / post preambles). A Meet-chat turn is the same turn with a different transport.

### The blocker, named up front

**The watcher does not know who owns the meeting.** `transcription_watcher.start(...)` takes
`subject: str = "u_live"` and its own docstring calls it a *"PRE-M2 placeholder"*
(`transcription_watcher.py:216-222`); `api.py:2358` calls it with no `subject` kwarg. Every copilot dispatch today
is attributed to that one fake subject, and its output lands in a workspace nobody reads. A chat
responder inheriting that would answer from the wrong workspace — worse than not answering.

`api.py:880-905` `_http_meeting_owner_lookup` is an *ownership check* (`is user U the owner of row
R?`), not a resolve (`who owns row R?`), so it does not solve this.

**Fix at the point of introduction.** The owner is known at *spawn* time — `mint_meeting_token`
(`bot_spawn/invocation.py:88-109`) is handed `user_id` and signs it into the meeting token. The
information has been there all along; it was just never surfaced where a consumer could read it, so
every downstream consumer invented a placeholder. Carry it forward on the invocation and on each
published segment (B4b) rather than resolving it after the fact from the point of observation.

### The change — five components

**B1. `core/meetings/modules/gmeet-capture/src/gmeet-chat.ts` (new).**
Mirror of `teams-chat.ts` in structure and defensiveness — candidate selector lists, an aria-label
fallback, a `getState()` that reports what matched plus a structural dump, so selectors are tunable
from live telemetry instead of a redeploy.
- `createGmeetChat({ onMessage, log })` — MutationObserver over Meet's chat panel. **Meet keeps the
  chat panel unmounted when closed**, so the bot must click `button[aria-label*="chat" i]`
  after admission and re-open it if Meet collapses it (a watchdog on a timer). This is
  participant-visible — the bot will show an open chat panel. Call it out in the PR; it is a
  behaviour change, not an implementation detail.
- `sendGmeetChatMessage(text): boolean` — focus the composer (`textarea[aria-label*="Send a message" i]`,
  with fallbacks), set the value **through the native `HTMLTextAreaElement.prototype.value` setter and
  dispatch a bubbling `input` event** (Meet's composer is React-controlled; a bare `.value =` is
  swallowed), then Enter or `button[aria-label*="Send" i]`.
- Export from `core/meetings/modules/gmeet-capture/src/index.ts` so it lands in the browser bundle as
  `VexaBrowserUtils.createGmeetChat` / `.sendGmeetChatMessage` — the same route `createJitsiChat` takes.
- Unit tests over a jsdom fixture of the panel, like `teams-speaker-indicators.test.ts`.

**B2. Bot — wire the read, implement the two acts.**
- *Read:* in the gmeet branch of `capture-bridge.ts` (~line 1266-1285, beside `createGmeetCapture`),
  instantiate `createGmeetChat` → `w.__vexaChatMessage(sender, text)`. The exposed function
  (`capture-bridge.ts:791`) and `publishChat` (`index.ts:266`) already exist; **nothing downstream
  changes.** Meet chat becomes `source:'chat'` transcript segments exactly as jitsi's does.
- *Write:* add `createChatController(page, inv)` beside `createSpeakController`
  (`capture-bridge.ts:1428+`), gated on `inv.voiceAgentEnabled` — the acts.v1 README already scopes
  `chat_send`/`chat_read` under that gate, so no contract change. Extend `voiceHandler`
  (`index.ts:119-126`) with `chat_send` → `page.evaluate(sendGmeetChatMessage)` and `chat_read` →
  return the reader's recent buffer.
- *Echo suppression (required).* The bot's own message re-enters its own observer, and the responder
  would answer itself in a loop. Two guards, both needed: drop `sender === inv.botName`, and keep a
  short-TTL set of hashes of just-sent text.

**B3. meeting-api — implement `POST /bots/{platform}/{native_meeting_id}/chat`.**
- In `collector/app.py`, beside the existing GET: resolve the owner with the same
  `_resolve_owned_native` (already used three times in that file — the tenant boundary is already
  right there; 404 on an unowned/unknown native), then `PUBLISH` `{"action":"chat_send","text":…}` to `bot_commands:meeting:{row_id}`. Return
  202. Text length-capped and validated against acts.v1.
- Register the forward in `gateway/app.py` beside line 673 and add `("POST", "/bots/{platform}/{native_meeting_id}/chat"): BOT`
  to the scope table (~line 106).
- **Delete the `POST /bots/{…}/chat` row from `KNOWN_GAPS.json`** — the reverse-conformance gate then
  proves the route is served instead of waived. That deletion is the machine-checkable statement that
  this capability is real.

**B4. meeting-api — the two missing invocation fields (without these, B2/B3/B6 are all inert).**

*B4a — `voiceAgentEnabled`.* Resolve it exactly like the sibling flags:
`resolve_spawn_flag("VOICE_AGENT_ENABLED", body.get("voice_agent_enabled"), default=False,
field="voice_agent_enabled")` in `bot_spawn/router.py` (the `_resolve_*_enabled` family, lines
86-105), threaded through `service.request_bot` into `build_invocation(voice_agent_enabled=…)` →
`"voiceAgentEnabled"`. Default **False** — opt-in per deployment (`VOICE_AGENT_ENABLED=true`) and
per request. `bot_spawn/env_flags.py` is shared precisely so the auto-join sweep resolves it
identically (cf. #1216); there is only ONE `build_invocation` call site (`service.py:704`), so both
spawn paths are covered by construction.

*B4b — `ownerUserId`: carry the owner on the wire instead of resolving it later.*
`mint_meeting_token` (`bot_spawn/invocation.py:88-109`) is already handed `user_id` and embeds it as
a signed claim — **the bot already holds the owner at spawn time**, just sealed inside an opaque JWT.
Surface it as a plain `invocation.v1` field, and have the bot stamp it onto each published segment
beside the `meeting_id` / `native_meeting_id` / `platform` it already stamps
(`adapters/transcript-redis.ts` `publish()`). The agent's watcher then reads the owner straight off
the wire it is already consuming — the same bot-stamped fields `_handle` already treats as
authoritative under the P0 fix.

This **replaces the internal owner-resolve RPC** an earlier draft proposed, and is strictly better:
no new HTTP hop, no per-message RPC on a hot path, no ad hoc secret-header contract, and no
fail-closed "resolve missed" state to design around at all.

*The honest cost:* `invocation.v1`'s `Invocation` is `additionalProperties: false` with 36
properties, so this **is a sealed-schema change** — it needs `pnpm seal:*` and a `lane:contract`
review, not a free additive field. That cost is one-time and diff-visible, which is what the
governance wants; an unmodeled side door would have been neither.

*Pre-existing finding, reported not fixed:* `_http_meeting_owner_lookup` (`api.py:880-905`) is
already a direct agent-api → meeting-api call, and there is **no such edge among the 62 `connects`
relationships in `architecture.calm.json`** — the chart does not model a hop that already exists.
B4b avoids adding a second one; closing the first is a separate issue.

**B6. agent-api — the responder: `core/agent/control_plane/meeting_chat_responder.py` (new).**
- *Trigger — detect only, NEVER block.* `_handle` in `transcription_watcher.py` already receives
  every raw segment, so the chat branch (`seg.get("source") == "chat"`) is free to add. **But
  `_run_arm` (`transcription_watcher.py:236-262`) is ONE daemon thread serving every live meeting on
  the deployment, and it is the sole arbiter that re-arms and reaps every copilot (`REARM_SEC=30`).**
  Running an LLM turn inside it would stall re-arm/reap for every other concurrent meeting for the
  duration of that turn. This is a **hard requirement, not an implementation detail**: the chat
  branch does nothing but match, and hand off to a bounded worker pool. The arm loop must never
  await a turn, an HTTP call, or a stream drain.
- *Address filter (required).* Answer only when addressed: text starting with the bot's name,
  `@<botname>`, or a configured prefix (`VEXA_MEET_CHAT_PREFIX`, default `@vexa`). Default off for
  everything else. `VEXA_MEET_CHAT_ALWAYS=true` exists as an escape hatch for a dedicated room.
  **This is a spam/capacity filter, not an authorization boundary** — see the security section.
- *Rate + resource limits (required, not polish).* Per-meeting concurrency of 1, plus a minimum
  interval between turns: a participant pasting `@vexa …` repeatedly is not an echo loop but is
  still a capacity attack on a 4-vCPU box. Dispatch the responder's unit with **explicit CPU/memory
  limits in its runtime.v1 profile** — an unbounded agent container competing with a capture
  pipeline that is already using 1.8-3.5 of 4 cores drops audio frames, which corrupts the very
  transcript the answer is grounded in.
- *Session identity — key on the ROW id, never the native code.* Use `session = f"meet:{platform}/{mid}"`
  where `mid` is the numeric meetings-domain row id. **Not the native code**: `transcription_watcher`'s
  own docstring (lines 8-11) records that the native id "collides across DIFFERENT users AND across
  ONE user's re-sends", and keying transcript data by it is exactly the P0 cross-tenant leak that was
  just fixed in this file. Keying a chat *session* by it would merge two owners' threads the same way.
- *The turn, identical to the Assistant tab.* Factor the body of `POST /api/chat` (`api.py:1181-1272`)
  into a `run_chat_turn(...)` used by **both** transports so they cannot drift. Be honest about the
  size: that handler is entangled with SSE-only mechanics — `Last-Event-ID` resume, the `turn_id`
  retry-from-cursor, `CONTEXT_SENTINEL` stripping keyed to `body.prompt`, and a
  **no-model-credentials branch that early-returns as an SSE `error` event**. The headless caller has
  no analogue for that last one, so name its degrade path now rather than discovering it mid-refactor:
  **on `NOT_CONFIGURED`, log and post one short plain-text line into the Meet chat** ("I can't answer
  — no model credentials configured"), because silence in a meeting reads as a broken bot.
- *Grounding.* Pass the same meeting focus the terminal sends
  (`context.focus = {kind:"meeting", native_id, platform}`) so `meeting_steering.phase_for` picks
  `live` and folds the live transcript.
- *Reply out.* `POST {GATEWAY}/bots/{platform}/{native}/chat`, the same hop `_record_meeting_doc`
  already makes (`transcription_watcher.py:190-200`). Strip markdown (Meet chat is plain text) and
  chunk to Meet's per-message limit.

### Data-flow diagram (the whole loop)

```
participant types "@vexa what did we decide?" in Meet chat
  → gmeet-chat.ts observer (page)                                    [B1]
  → __vexaChatMessage (capture-bridge.ts:791)                        [B2, exists]
  → publishChat → transcript.v1 {source:'chat'} (index.ts:266)       [exists]
  → redis stream `transcription_segments`                            [exists]
  → transcription_watcher._handle sees source=='chat' → ENQUEUE      [B6, never blocks tx-watch]
  → owner read straight off the segment (ownerUserId)                [B4b]
  → run_chat_turn(subject=owner, session="meet:google_meet/{row_id}")[B6, shared with /api/chat]
  → agent container turn (workspace + live transcript grounding)     [exists]
  → POST /bots/google_meet/abc-defg-hij/chat  (gateway → meeting-api)[B3]
  → PUBLISH acts.v1 chat_send → bot_commands:meeting:{row_id}        [B3]
  → bot acts subscriber → chat controller (gated voiceAgentEnabled)  [B2, B4a]
  → sendGmeetChatMessage → the reply appears in Meet chat            [B1]
```

### Findings surfaced by this reading (report them, don't silently fix)

1. **`voiceAgentEnabled` has no producer** (`bot_spawn/invocation.py`) — every acts.v1 voice/chat
   command is dead on arrival on every deployment. This is the real reason "speak is proven at the
   bot layer but unreachable", which `docs/docs/interactive-bots.mdx` attributes to the API layer
   alone. The doc's diagnosis is incomplete.
2. **`_to_native_wire` drops `source`** (`collector/ingest.py:121-136`). The `tc:meeting:{row_id}`
   carrier that the copilot and the Terminal SSE consume cannot tell a typed chat line from speech,
   so chat lines render as if someone said them. Not blocking (we branch on the raw feed upstream),
   but it is a real fidelity loss — recommend adding `source` in the same change and labelling chat
   lines in the transcript view.
3. **Meet's chat panel must be held open**, which is visible to every participant. Worth a deliberate
   decision, not a side effect.
4. **Prompt injection — and this is the plan's sharpest edge.** This is the FIRST agent-input
   surface reachable by someone who is not the account owner: any participant in the room, including
   an external guest, types text that becomes agent input. On this deployment propose-only is **not**
   enforced (the runtime keys off a `write` flag defaulting True —
   `core/agent/control_plane/workspace_attach.py:84`, `system_mounts.py:161`), so such a turn gets a
   **writable workspace** today.
   Two things follow, and neither is "document the residual risk":
   - Read-only / no-write mounts must be an **enforced property of the responder's dispatch**, and
     proved by a red→green negative control (acceptance B-11), not asserted in prose. D10 does not
     let us claim a control we have not demonstrated.
   - The **address prefix is not an authorization boundary.** It filters spam. Anyone in the room can
     type it. The real boundary question is that the reply-out path signs with the deployment-wide
     `VEXA_BOT_API_KEY` — so "who may make the bot speak in this meeting" is currently *possession of
     one shared host key*, not the meeting owner's identity. Combined with unenforced propose-only,
     that is a larger exposure than an injection footnote suggests. It needs a decision on the issue
     before B6 ships, not after.
5. **Capacity on this host.** A Meet bot is ~1.8–3.5 cores of a 4-vCPU box; an agent container
   dispatched *during* the call competes with it. The address-prefix filter and per-meeting
   concurrency of 1 are load-bearing, not polish.

### Acceptance (Part B)

| # | Observation | Method |
|---|---|---|
| B-1 | A message typed in Meet chat appears as a `source:'chat'` transcript segment | `XRANGE transcription_segments` on a live meeting |
| B-2 | Nothing typed in Meet chat is answered when it does not address the bot (negative control) | live meeting |
| B-3 | `@vexa <question>` in Meet chat produces a reply **in Meet chat** | live meeting, the human bar for this issue |
| B-4 | The same Q&A appears as thread `meet:google_meet/<code>` in the Terminal Assistant tab, and can be continued there | Terminal UI |
| B-5 | The reply is grounded in the live meeting (asks about something only said aloud) | live meeting |
| B-6 | The bot does not answer its own message (echo control) | live meeting, 60s idle after a reply |
| B-7 | `POST /bots/{platform}/{native}/chat` returns 404 for a meeting owned by another user | two-account curl |
| B-8 | With `VOICE_AGENT_ENABLED` unset, `chat_send` is ignored and the bot logs the refusal (negative control) | bot container logs |
| B-9 | `gate:contract-conformance` passes with the `POST /chat` row removed from `KNOWN_GAPS.json` | `node scripts/gates.mjs all` |
| B-10 | A meeting whose invocation carries no `ownerUserId` produces **no** turn (never a `u_live` fallback) | spawn an old-invocation bot; expect silence |
| B-11 | A chat-triggered turn **cannot write** to the workspace (the injection control) | prompt the agent via Meet chat to create a file; expect refusal + no commit |
| B-12 | Two owners (or one owner's re-send) of the same native meeting code get **distinct** chat sessions | two accounts, same Meet link, compare Terminal session ids |
| B-13 | A turn in flight for meeting A does not delay copilot re-arm/reap for meeting B | two concurrent meetings; watch `tx-watch` log cadence across a long turn |
| B-14 | With no model credentials configured, the responder posts one plain-text line into Meet chat rather than going silent | unset the credential, ask in Meet chat |

---

## Evidence status (P21 — what is tree-verified and what is not)

Every `file:line` anchor above was read this session and independently re-checked by a fact-check
pass; all were exact. Two claims are **operator field observations from this deployment, not tree
facts**, and are labelled as such rather than dressed up as verified:

- Auto-detect mislabelling English as Spanish/German/Indonesian/Portuguese on short windows
  (motivates A-6). Not reproducible from source; re-witness it as the red half of the A-6 pair.
- "One Meet bot is ~1.8-3.5 cores of a 4-vCPU box" (motivates the concurrency limits). Measure it
  again under `docker stats` before relying on the headroom number.

Not checked at all: whether Meet's current chat DOM matches any selector we write (B1 is unwritten,
and Meet's DOM is the least stable surface in this plan), and whether the Teams/Zoom lanes would
want the same responder — deliberately out of scope.

---

## Sequencing

Part A is independent and cheap — land it first and get the language fix into the running deployment.
Part B is B4 (both invocation fields — `voiceAgentEnabled` and `ownerUserId`, one sealed-schema
change) → B1/B2 (bot read+write, provable against a live Meet with no agent involved at all) → B3
(the REST send, provable with `curl`) → B6 (the responder). Folding the owner onto the invocation
removes the old B5 as a standalone step. Each remaining step is separately witnessable; do **not**
build the responder before a `curl` can put text into a Meet chat.

## Process obligations (AGENTS.md)

- Own worktree before the first edit: `git worktree add ../vexa-meet-chat -b <branch>`.
- Docs move with the change: `docs/docs/interactive-bots.mdx` (the status table is wrong the moment
  B3 lands), `docs/docs/how-to/send-a-bot.mdx` (bot name + language), a new how-to for the in-meeting
  assistant, and a fragment at `docs/changelog.d/<pr>-<slug>.md` — **never** edit `changelog.mdx`.
- B1's primitives land in the SHARED `gmeet-capture` brick, so they are bundled into the extension
  build too even though only the bot consumes them today. That is the correct home (per-runtime
  front doors, dispatch stays in bot-only `capture-bridge.ts`) — worth one line in the PR, not a
  redesign.
- CALM: B1 adds no module (it lives inside `gmeet-capture`, already node `gmeet-capture` in
  `architecture.calm.json:292`) and, with the owner carried on the invocation, Part B adds **no new
  service-to-service edge** — it rides carriers the chart already models. What it does change is the
  sealed `invocation.v1` schema (B4b), so `pnpm seal:*` runs in the same change and the contract goes
  through `lane:contract` review (P4/P23). Separately: the chart does not model the agent-api →
  meeting-api hop that `_http_meeting_owner_lookup` ALREADY makes — report it, don't fix it here.
- `node scripts/gates.mjs all` green before push — necessary, never sufficient. Both parts need a
  live Google Meet leg.
