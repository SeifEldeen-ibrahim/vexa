# Coverage evaluation

The checklist's correctness is a judgement, so no unit test can assert it — but it can be
measured against a meeting a human has already read, and from now on it has to be. This directory
holds that measurement.

```sh
cd core/meetings/services/live
set -a; . ../../../../deploy/compose/.env; set +a
NEXUS_LIVE_LLM_URL=$TRANSCRIPTION_SERVICE_URL NEXUS_LIVE_LLM_TOKEN=$TRANSCRIPTION_SERVICE_TOKEN \
  npx tsx eval/coverage-replay.ts
```

It calls the real model and costs tokens. Flags: `--model=`, `--no-final` (skip the end-of-call
review), `--runs=N`, `--fixture=`, `--window-chars=` (shrink the live window to simulate a meeting longer than it), `--gap-ms=` (the floor between calls — the replay fires a
meeting's worth of passes in seconds and would otherwise measure the endpoint's per-minute rate
limit rather than the prompt).

## What it replays

The live cadence, exactly: confirmed segments in order, a virtual clock set to each segment's own
timestamp, and `tick()` deciding for itself when a pass is due. A change that only looks good at
infinite cadence cannot win here. Then `flush()`, then the whole-meeting `review()`.

## Fixtures

`fixtures/sales-1to1.json` — a real BIAMI sales weekly 1:1 captured by the extension
(meeting 75, 258s, 68 confirmed segments, an 11-point agenda). `expected` is a hand label read
off the transcript, and the distinction it draws is the one the product promises:

* `covered` — the point was addressed. Somebody reported on it, answered it, or worked through it.
* `touched` — it was raised and left: asked and deflected, or mentioned in passing.

A new fixture is worth adding whenever a real meeting is judged wrongly; that is the only kind of
evidence this directory accepts.

## The measurement that produced the current settings

All rows are the real model (`openai/gpt-oss-120b`) replayed over `sales-1to1`, whose hand label
is 8 covered / 3 touched.

| variant | covered | started | not yet | exact |
|---|---|---|---|---|
| as shipped (1024-token cap) | 0 | 3 | 8 | 1/11 |
| prompt reframed, same cap | 2 | 1 | 8 | 1/11 |
| **room for the answer + low reasoning effort** | **11** | 0 | 0 | **8/11** |
| the same, live passes only (`--no-final`) | 11 | 0 | 0 | 8/11 |
| the same, 1200-char window | 11 | 0 | 0 | 8/11 |
| the same, half the live passes dropped | 11 | 0 | 0 | 8/11 |

The first two rows are the same failure, and it was NOT the prompt: `openai/gpt-oss-120b` bills
its reasoning against `max_tokens`, so at 1024 it spent 1022 tokens thinking, returned
`finish_reason: "length"` with EMPTY content, and the caller could only read that as "the model
saw nothing move". `failures` stayed at 0 for the whole meeting while the judge never once spoke.
The fixes are in `llm.ts`: ask for low reasoning effort, leave room for the answer, and report an
empty reply as a failure rather than as silence.

One narrow precision rule DID earn its place, and the live smoke test is what caught the need
for it: the looser frame marked "Agree the timeline" as started on the sentence "the timeline we
did not get to yet". Saying a thing was not discussed is not discussing it, so an explicitly
skipped line now stays out of the answer — at no cost to the table above.

The three remaining disagreements (a3, a9, a10) are all in the generous direction, on lines that
ask for two things where the meeting gave one — "key wins AND missed opportunities", "top
prospects AND follow-ups". A prompt rule for exactly that case was written, measured, and
**removed**: it changed none of the three. The harness is here so the next idea gets the same
treatment.

### What is NOT proven

The end-of-call `review()` pass changed nothing in any of the three conditions above, and it is
kept anyway. Its purpose is a point raised at minute two and settled at minute forty, which no
live window ever holds whole — and this fixture, where each topic is discussed contiguously
inside a single window, cannot contain that case. So it is motivated but untested, it costs one
model call per meeting, and `mergeMarks` means it can only ever raise a mark. A fixture from a
long meeting that wanders would settle it.
