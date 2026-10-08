# live — the Nexus in-person capture host (Node/TS)

`@vexa/live` is the lane for a meeting that happens **in a room**. Somebody opens the Nexus
Chrome extension, writes down what the meeting is for, presses Start, and streams their
microphone here. This service transcribes the room and **marks the checklist off as it is
covered**, so the person in the meeting can see what has and has not been dealt with yet.

No bot joins anything. There is no meeting URL, no admission, no runtime workload — which is
exactly why this is a service of its own rather than another branch in `bot_spawn`.

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| consumes | Nexus Chrome extension | `WS /live/ingest` (`capture.v1` frames) | 16 kHz microphone PCM |
| consumes | Nexus Chrome extension | `GET/POST /live/*` with `X-API-Key` | start · stop · poll · history · checklists |
| calls | admin-api | `POST /internal/validate` (`X-Internal-Secret`) | API token → the owning user (the gateway's own oracle) |
| calls | meeting-api | `/internal/live/sessions*` (`Authorization: Bearer $INTERNAL_API_SECRET`) | claim / end the `in_person` meeting row; persist the agenda onto it |
| calls | hosted Whisper | `TRANSCRIPTION_SERVICE_URL` | PCM turn → `stt.v1` segments |
| calls | an OpenAI-compatible chat model | `NEXUS_LIVE_LLM_URL` (defaults to the STT base) | recent transcript + open checklist → what moved |
| produces | meeting-api collector | `XADD transcription_segments` | `transcription` envelopes + the `session_end` marker |
| produces | the Nexus terminal | `PUBLISH tc:meeting:{id}:mutable` | the same segments, live |

Feeding the existing spine is the whole trick: history, the live terminal view, the copilot and
the post-meeting notes all work for an in-person call **because nothing else had to change**.

## What it does NOT do

**It does not name speakers, and that is a decision, not a gap.** One microphone in a room gives
the segmenter speaker-*change* boundaries and nothing more — it does no clustering, no embeddings,
no voiceprints. So every turn publishes an EMPTY speaker rather than `Speaker 3`, which would
invent a third person. Agenda coverage does not need names; attribution would need a second
microphone per person, or voice enrolment, and is its own piece of work.

## The checklist rules

In `src/agenda.ts`, and they are what make the ticks trustworthy:

* **Monotonic.** An item only moves `open → touched → covered`. The evaluator sees a sliding
  window of recent speech, so an item settled ten minutes ago is absent from the window — a model
  free to answer "open" for it would un-tick a box the user already saw ticked, and un-ticking is
  the one failure that makes the whole surface untrustworthy.
* **Evidence or it didn't happen.** Every tick carries the quote that earned it. A tick with no
  evidence is refused: the agenda text is not evidence, because being on the list is not the same
  as having been talked about.
* **The model may not invent items.** An unknown id is dropped.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `NEXUS_LIVE_PORT` | `8120` | HTTP + WS port |
| `NEXUS_LIVE_PUBLIC_INGEST_URL` | `wss://nexus.biami.io/live/ingest` | what the extension is told to connect to |
| `ADMIN_API_URL` + `INTERNAL_API_SECRET` | — | identity; **unset ⇒ every request refused** |
| `MEETING_API_URL` + `INTERNAL_API_SECRET` | — | the meeting rows |
| `TRANSCRIPTION_SERVICE_URL` / `_TOKEN` / `TRANSCRIPTION_MODEL` | — | STT; **unset ⇒ no call can start** |
| `NEXUS_LIVE_LLM_URL` / `_TOKEN` / `_MODEL` | the STT base/token, `openai/gpt-oss-120b` | the coverage evaluator |
| `NEXUS_LIVE_COVERAGE_INTERVAL_MS` | `20000` | at most one coverage pass this often |
| `NEXUS_LIVE_COVERAGE_WINDOW_CHARS` | `6000` | transcript carried into each pass |
| `NEXUS_LIVE_COVERAGE_MIN_NEW_CHARS` | `80` | new speech needed before a pass is worth a call |
| `NEXUS_LIVE_IDLE_TIMEOUT_MS` | `600000` | audio silence after which the janitor finalizes a call |
| `NEXUS_LIVE_AUTH_CACHE_MS` | `60000` | how long a validated token is trusted |

The coverage evaluator defaults to the **same** OpenAI-compatible base and token that already
serve this deployment's Whisper, so a deployment that can transcribe can also mark off an agenda
with nothing new to configure.

## Failure behaviour

* no STT configured → `POST /sessions` refuses (503). Recording silence while the user believes
  they are being captured is worse than a clear failure.
* no model configured, or a model error → the transcript is unaffected; the checklist simply does
  not advance, and `coverage.failures` says so in the snapshot and on `/health`.
* redis blinks → the segment is lost and logged; the call keeps running.
* the socket drops → **not** the end of the call. A reconnect resumes it; the janitor finalizes a
  session whose audio really stopped (`NEXUS_LIVE_IDLE_TIMEOUT_MS`), which is also what closes a
  call whose browser was simply shut.
* SIGTERM → every live session is finalized before exit, so a deploy never leaves a meeting
  `active` forever. (The in-person lane is deliberately exempt from the bot reconcile sweep —
  `bot_spawn.ports.LIVE_PLATFORM` — so nothing else would close it.)

## Tests

`pnpm test` — all offline, no services:

* `agenda.test.ts` — the checklist rules (monotonicity, evidence, parsing)
* `coverage.test.ts` — the evaluator's cadence, rate limiting and failure behaviour
* `auth.test.ts` — identity, incl. fail-closed and never caching an outage
* `segments.test.ts` — the wire format the collector requires
* `checklists.test.ts` — "reuse a list I've used before", derived from past calls
* `http.test.ts` — the API and its tenancy boundary, plus the janitor
* `session.test.ts` — L3: audio → segment → tick → the meeting row closed

The image build runs this suite, so a broken lane fails at build time.
