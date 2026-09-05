# Observation bundle — bot name + language, and the assistant in the meeting chat

The acceptance table from [`meet-chat-assistant.md`](meet-chat-assistant.md), row by row, against
what was actually observed. Live rows were witnessed on a real Google Meet
(`sgm-bxhp-qzi`, meeting row 27) on the nexus.biami.io deployment, with the account owner in the
room. Rows that were NOT proved say so plainly.

Branch `feat/meet-chat-assistant`. Images: `vexaai/v012-{gateway,meeting-api,agent-api,terminal}:meetchat`,
`vexa/vexa-bot:meetchat`.

---

## Part A — bot name + language

| # | Observation | Verdict | Evidence |
|---|---|---|---|
| A-1 | A typed bot name shows as the participant name in Meet | **partial** | The bot joined as `Vexa`, which came from `DEFAULT_BOT_NAME` on the deployment, not from the picker. The UI path was not exercised in the browser — see *Not proved*. |
| A-2 | The name survives a reload and needs no rebuild | **not proved** | localStorage round-trip is covered by unit tests only. |
| A-3 | Selecting a language sends `"language":"en"` | **PASS** | The spawn carried `"language":"en"`; `POST /bots` → 201, row 27. |
| A-4 | Auto-detect omits the key entirely (negative control) | **PASS (unit)** | `joinPrefs.test.ts` — `'language' in body === false`, and the serialized body contains no `language`. |
| A-5 | The forced language reaches the STT request | **PASS** | Every transcript segment came back `"language": "English"` — the forced code, echoed by the backend, not a per-window detection. |
| A-6 | A forced language stops the mis-detection | **not proved** | Needs an A/B against a recorded auto-detect run. The mechanism (A-5) is proved; the *improvement* is not measured. |
| A-7 | All five call sites carry the prefs | **PASS (unit)** | `meetingActions.test.tsx` drives the real `actionsFor` Send/Re-send through `joinBody`; `grep` shows no literal `bot_name:` outside `joinPrefs.ts`. |
| — | `bot_name` is OMITTED when nothing chose one (#1259) | **PASS (unit)** | The pre-existing suite caught a regression where I always sent it; the precedence (user → `NEXT_PUBLIC_DEFAULT_BOT_NAME` → omit) is now pinned by its own tests. |

**Not proved for Part A:** nobody opened the Terminal and used the Options row, and nobody clicked
the `@vexa: transcript only` / `@vexa: workspace` toggle (its endpoint is verified through the
gateway, the button is not). The picker, its
persistence and the summary line are unit-tested and the bundle ships in the served chunk
(`Afrikaans` and `Auto-detect` are present in `/app/.next/static/chunks`), but no human drove it.
A-1/A-2/A-6 need one browser session to close.

---

## Part B — the assistant in the meeting chat

| # | Observation | Verdict | Evidence |
|---|---|---|---|
| B-1 | A typed message becomes a `source:'chat'` transcript segment | **PASS** | `transcription_segments` carried `"speaker":"…","text":"@vexa what have i been talking about ??","source":"chat"` with `"owner_user_id":6`. |
| B-2 | An unaddressed line is NOT answered (negative control) | **PASS** | `sounds good` and `you ate alooot` were read by the bot and produced no turn and no reply. |
| B-3 | `@vexa <question>` produces a reply in the meeting chat | **PASS** | `[bot] chat_send delivered: "Doing well, thanks for asking! Ready and listening in on the…"` — and the human in the room saw it. |
| B-4 | The same exchange is a thread in the Assistant tab | **PASS** | `agent:session:6:meet-google_meet-27` exists, owned by user 6; `unit:agent-6-chat-meet-google_meet-27:out` holds the reply text. |
| B-5 | The reply is grounded in the live meeting | **PASS** | Asked `@vexa which car is best?` after a spoken conversation about cars — reply: *"From the transcript, Seif mentioned he's weighing the Tranga…"*. Also asked what the meeting was for and it **refused to invent a purpose**, saying the transcript only held setup chatter. |
| B-6 | The bot does not answer its own message | **PASS** | Re-witnessed live: `chat (our own send, not emitted)` on every reply. Guarded by TEXT, because the sender guard could never fire — Meet renders the bot's own message with no resolvable author. |
| B-7 | `POST …/chat` 404s for another user's meeting | **PASS (offline)** | `test_native_id_api_v1.py` — unowned and other-user both 404 with nothing published to the bus. Not run with two real accounts. |
| B-8 | With `VOICE_AGENT_ENABLED` unset, `chat_send` is ignored | **PASS (unit)** | The controller refuses and logs; the live run had it *enabled*, and the invocation carried `"voiceAgentEnabled":true`. The negative half is not live-witnessed. |
| B-9 | The conformance gate passes with the `KNOWN_GAPS` row removed | **PASS, with a caveat** | 5/5 in the gateway conformance suite. **But the negative control showed the gate is satisfied by the gateway forward ALONE** — it stays green with meeting-api's handler removed, and only goes red when neither serves the route. Reported in the commit; the gate cannot tell a forwarded-and-404ing route from a served one. |
| B-10 | No owner ⇒ no turn, never a placeholder subject | **PASS (unit)** | Three empty-owner shapes all return `no-owner` and run nothing. Live, the owner was always present (`owner_user_id: 6`). |
| B-11 | A chat-triggered turn cannot write to the workspace | **PASS**, red→green live | Before: `"Done — I created test.md"` + the file existed + a git commit. After: `"I'm not going to create that file…"`, no file, no commit. The first fix ALSO did nothing (it matched on `slug`, and the real slug is the workspace name) — found by reading `VEXA_MOUNTS` off a live worker. |
| B-12 | Two owners of one native code get distinct threads | **PASS (unit)** | Distinct row ids → distinct sessions, and the native code appears in neither. Not run with two accounts. |
| B-13 | A turn for meeting A does not delay copilot re-arm for B | **PASS (unit)** | `offer` returns in <100 ms while the turn it accepted sleeps 750 ms. Not observed under two concurrent live meetings. |
| B-14 | With no model credentials, it says so rather than going silent | **not proved** | Implemented; never exercised. |

---

## Added after the first live run — scope, and who may ask

Two changes the run itself provoked, both closing exposures the original plan did not name.

| # | Observation | Verdict | Evidence |
|---|---|---|---|
| S-1 | The default turn cannot read the workspace at all | **PASS** | Live worker env: `VEXA_CHAT_TOOLS=none`. Asked to web-search, it correctly said it could not. |
| S-2 | A granted meeting gets the workspace AND the web, read-only | **PASS** | Live worker env: `VEXA_CHAT_TOOLS=Read,Glob,Grep,WebSearch,WebFetch`; mounts `seed write=False`, `_system write=False`. |
| S-3 | The grant is per meeting, expires, and is owner-checked | **PASS** | Through the gateway: grant → 202 + redis key (ttl 43200s); revoke → 202 + key gone; another user → 404. |
| S-4 | Only the meeting owner is answered | **PASS** | Injected a question from `Marcin Kowalski` → **no worker spawned**. Same question from `Seif Ibrahim` / `seif` → accepted. |
| S-5 | An unresolvable identity answers nobody | **PASS (unit)** | Fail-closed: a down identity service answers no one rather than everyone. |
| S-6 | Replies are delivered as the meeting's OWNER, not a shared key | **PASS (unit + live)** | Internal owner-named route; the previous shared-key path only ever worked for one user's meetings. |

**Why the default is transcript-only.** Read-only mounts stop a participant *changing* the
workspace. They do nothing about a guest asking the assistant to read private notes *aloud* into a
room the owner does not control — the turn runs as the owner, so whatever it can read, the room
hears. Exfiltration is not a write problem, and "read-only" is exactly the phrase that makes it
sound handled. Having nothing private in scope is the only reliable answer.

**A limit worth stating plainly.** Meet's in-call chat has **no direct messages** — every message
reaches the whole room and a bot cannot opt out. So "reply only to the asker" is not achievable;
what is achievable is answering only the owner (S-4) and addressing the reply by name. And the owner
check matches on DISPLAY NAME, because that is the entire identity Meet's chat exposes: no email, no
account id. A participant who renames themselves to the owner passes it. It bounds casual misuse,
not a determined impersonator.

## What the live run cost, and what it bought

Four defects reached a real meeting that the unit suite could not have caught, and one that it did.

1. **The session id killed every spawn.** `meet:{platform}/{row}` became a docker container name;
   `:` and `/` are illegal, so `docker create` returned 400 and the agent saw a bare `502`. Nothing
   offline models the container-name charset.
2. **Every sender was `Unknown`.** The leaf-text fallback that recovers an author sat inside
   `if (!text)`, so it only ran when the body was *not* found — which never happens in the real DOM.
   **Every fixture in the unit suite carried `data-sender-name`**, so they exercised the branch that
   does not run in production and never touched the one that does. That is a fixture-design failure,
   not bad luck.
3. **The bot read its own messages back.** Echo suppression keyed on the sender name; Meet renders
   the bot's own reply with no resolvable author, so the guard could never fire. Harmless at the
   default (a reply does not start with `@vexa`) — but with `VEXA_MEET_CHAT_ALWAYS=true` the bot
   would have talked to itself indefinitely.
4. **The thread title carried the responder's own instructions**
   (`"Someone asked in the meeting chat: how are you Answer them …"`).
5. **The gateway was not in the local overlay** and still ran published `:v012`, so the new route
   answered `405`. Caught by a smoke test against the deployment, not by any suite.

6. **The sender was never in the message row.** Meet renders one author header per RUN of messages,
   as a sibling ABOVE the rows — the row itself carried no author at all. Only the structural dump
   showed that; two rebuilds of guessing would not have.
7. **The read-only fix did nothing, and its test passed.** The grant is keyed on the SUBJECT and the
   mount's slug is the WORKSPACE's name, so `slug in ro` matched nothing. Found by reading
   `VEXA_MOUNTS` off a live worker container.

And one the *existing* suite caught before it shipped: my first `joinBody` always sent `bot_name`,
which would have silently re-broken #1259's `DEFAULT_BOT_NAME` knob.

### The pattern in those, which is the real lesson

Three of these were the same mistake: **a fixture written from what I assumed the shape was.** The
gmeet-chat fixtures all carried `data-sender-name`, so the tests exercised a branch that never runs
in the real DOM. The mount fixture used `slug: "6"`, so the security test passed against a shape that
does not exist. In both cases the test was green and the code was inert. Fixtures for a seam are
captured from a real dispatch or a real page, not imagined — the ones in this branch now say where
they came from.

## Findings reported, not fixed

- **`gate:contract-conformance`'s reverse half is weaker than it reads** — satisfied by the union of
  the gateway edge and meeting-api, so a forwarded-but-404ing route passes. Verified both ways.
- **The reply hop uses one deployment-wide key.** `POST /bots/{p}/{n}/chat` is owner-scoped, so the
  assistant can only answer in meetings owned by `VEXA_BOT_API_KEY`'s user. On a multi-user
  deployment everyone else gets a silent 404. This is a functional ceiling, not just a security
  smell, and it needs a per-user hop.
- **`invocation.v1` cannot take new fields casually.** `additionalProperties: false` plus a schema
  baked into each bot image means a new field makes every older bot refuse to start. Proved against
  the pre-change schema before backing the change out.
- **The fork's `config_preflight.py` fixes never reached the canonical copy** in
  `deploy/contracts/config.v1/preflight.py`, so any service that re-vendors gets both STT bugs back.
- **`_http_meeting_owner_lookup` is an unmodeled agent-api → meeting-api hop** — it exists in code
  and not in `architecture.calm.json`'s 62 relationships.

## Environment caveats

`core/meetings/services/bot`'s own test suite **cannot run in this environment at all** (no
per-service `node_modules`; identical failure on a pristine checkout), so the bot-side changes are
covered by the shared browser module's 35 jsdom checks and by the live run, not by that suite.
meeting-api: 1275 passed. agent-api: 539 passed against a 510 baseline, with the same 9 pre-existing
failures. Terminal: 475 passed.
