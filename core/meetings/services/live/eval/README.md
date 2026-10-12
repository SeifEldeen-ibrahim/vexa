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
review), `--runs=N`, `--fixture=`, `--window-chars=` (shrink the live window to simulate a meeting longer than it), `--interval-ms=` (the pass cadence — the lever on token spend), `--drop-rate=` (lose that share of live passes, to test what the review recovers), `--gap-ms=` (the floor between calls — the replay fires a
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

`fixtures/sales-1to1-short.json` — the SAME agenda against a call that had barely started: a
dozen sentences, ~90 seconds (meeting 90, 2026-10-12). It exists because the two ways this
feature lies are opposites, and a single fixture can only catch one of them. sales-1to1 catches a
judge that marks NOTHING; this one catches a judge that marks EVERYTHING. Keep both green or the
fix for one failure silently buys the other — which is exactly what happened between
2026-10-09 and 2026-10-12.

A thin call is not an edge case, either: every meeting is thin for its first two minutes, so a
judge that cannot be honest here is wrong for most of the time the live panel is on screen.

`fixtures/sales-1to1-scripted.json` — the same agenda again, against a 1:1 that was WRITTEN to a
designed outcome (40 segments, 238s, manager and rep, short sentences, no speaker labels) rather
than captured. Both other fixtures are labelled by reading somebody's real meeting, so every
disagreement can be argued about; here the ground truth is known by construction and the traps are
deliberate:

| line | trap | aimed at |
|---|---|---|
| a2 / a3 | two points covered by adjacent but separate remarks | the one-remark cap over-firing |
| a6 | explicitly parked, never returned to | `SCALE` (promised for later) vs `HONESTY` (deferred stays out) |
| a7 | asked twice, deflected both times | reading a deflection as an answer |
| a8 | never mentioned in any form | marking from the agenda's own wording |
| a10 | mentioned in passing, then announced for Thursday | "being introduced is not being discussed" |

Designed outcome: 7 covered, 3 started, 1 not yet.

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

## The over-marking it then bought (2026-10-12)

Fixing 0-of-11 moved the judge straight past the answer: the same agenda against a call a minute
and a half old came back **9 of 11 covered**, reported from the field as "he had said nothing and
8 were marked yes". The cause is visible in the evidence column — ONE sentence, "two big deals
slipped, one pushed to next month", was the quote for FOUR separate lines (last week's misses,
progress on deals, deals closing this week, blockers), and a pipeline figure for three more.
Nothing was fabricated; every quote was real speech, spent over and over.

Three changes, each measured on both fixtures:

1. **The one-remark cap** (`mergeMarks`, code). A `covered` whose quote is the same piece of
   speech that already earned another line is capped at `touched` — the topic did come up, but a
   remark only counts once. Cross-pass, so only the merge can see it; trigram containment ≥ 0.6
   recognises the same sentence re-clipped by a later pass.
2. **`SEPARATION`** (prompt). The within-pass half of the same rule, which the merge cannot do
   alone because each pass is judged in isolation and neither answer is wrong by itself.
3. **Substance in the quote** (prompt). The quote must itself carry what the line asked for — the
   figures, the facts, the decision — or the line is `touched`. It makes the evidence the test the
   decision has to survive rather than a citation attached afterwards.

| variant | thin call (label 3 covered) | full meeting (label 8 covered) |
|---|---|---|
| after the 0-of-11 fix | 9 covered · 0 started → 5/11 | 11 covered · 0 started → 8/11 |
| \+ `SEPARATION` | 7 covered · 2 started → 6/11 | — |
| \+ the one-remark cap | 5 covered · 3 started → 7/11 | 10 covered · 1 started → **9/11** |
| \+ substance in the quote | **4–5 covered · 2–3 started → 6–7/11** | 10 covered · 1 started → **9/11** |

The full meeting got BETTER on the way (8/11 → 9/11): a3's quote there was the same remark as
a2's, so the cap put it back to `touched`, which is what the hand label says.

### The contradiction the scripted fixture found (2026-10-12)

On its first run the scripted meeting scored 8/11 and 9/11, with 9 covered against a designed 7.
Three traps passed outright — a3 was NOT over-capped, a6 came back `touched`, a10 `touched` — but
**a8, which nobody mentions anywhere in the transcript, was marked in both runs**: `touched` on a
remark about customers, then `covered` on "I will chase the pricing note with marketing", said
while agreeing next steps. The manager was genuinely offering support; nobody had raised the
agenda line.

The cause was in the prompt, and it was a contradiction rather than an omission. `SCALE` listed
"merely implied by a remark that was really about something else" as a reason to mark a line
`touched`, two lines above `HONESTY`'s "never mark a line because its wording resembles the
topic". The first licensed exactly what the second forbade. The clause now sits on the DON'T
side — a line only implied by a remark made for another purpose stays out of the answer, because
somebody has to have put the subject on the table — and that single move took the scripted meeting
to **10/11 with 8 covered**, a8 correctly `not yet`, at no cost to the other two fixtures.

Worth keeping in mind when reading a judge's output: a mark can be wrong because the prompt is
missing a rule, or wrong because the prompt holds two rules that disagree. The second kind only
shows up as an inconsistent result, which is why it needs a fixture whose answer is known in
advance.

The one remaining disagreement there is a7: "any blockers? nothing major" is read as covered where
the label says started. That one is genuinely arguable — "nothing major" IS an answer — and it is
left alone rather than tuned away.

What the measurement table is really saying is that the bias is gone rather than that the score
jumped.
At 9 covered every single error was generous; now they fall on both sides of the label — a9 and
a10 land `touched` or `open` on one run and `covered` on another. Two consecutive runs of the thin
call disagree on three lines, so **±1 covered is model noise, not a regression**. Judge a future
change by the direction of its errors and by both fixtures, never by one run of one of them.

### What is NOT proven

The end-of-call `review()` pass changed nothing in any of the three conditions above, and it is
kept anyway. Its purpose is a point raised at minute two and settled at minute forty, which no
live window ever holds whole — and this fixture, where each topic is discussed contiguously
inside a single window, cannot contain that case. So it is motivated but untested, it costs one
model call per meeting, and `mergeMarks` means it can only ever raise a mark. A fixture from a
long meeting that wanders would settle it.

## What a meeting costs, and what the endpoint allows

Measured on the fixture (`--interval-ms` is the lever; quality was identical at every cadence):

| cadence | passes | prompt tokens | exact |
|---|---|---|---|
| 20s (default) | 10 | 8 929 (≈ 890/pass) | 8/11 |
| 40s | 6 | 5 904 | 8/11 |
| 60s | 5 | 5 495 | 8/11 |

So a 4-minute meeting with an 11-point agenda spends ≈ 9k prompt + ≈ 5k completion tokens on
coverage. The default stays at 20s because the live panel ticking promptly IS the product; 40s is
the dial to turn (`NEXUS_LIVE_COVERAGE_INTERVAL_MS`) when the budget matters more than latency,
and it costs nothing measurable here.

This deployment's Groq account is on the FREE tier, which the response headers state outright:
8 000 tokens/minute, 1 000 requests/day, 200 000 tokens/day for `openai/gpt-oss-120b`. The
per-minute cap is not the binding one — 10 passes over 4 minutes is ≈ 2 200 TPM. **200 000
tokens/day is**, at roughly 14k tokens a meeting: about a dozen meetings a day on the whole
organisation, since Groq's limits are per-org and extra keys do not add capacity.

`max_tokens` is NOT reserved against that budget — a 4 096-cap call and a 5-cap call move
`x-ratelimit-remaining-tokens` by the same amount, so the cap is headroom and costs nothing until
used. The durable fix for the daily ceiling is the Developer plan (usage-based, no subscription
fee), not a smaller prompt: at $0.15/M in and $0.60/M out, the numbers above are well under a
cent of judging per meeting.

## Moving the judge off Groq (2026-10-12)

Groq's free tier caps `openai/gpt-oss-120b` at **200 000 tokens/day**, about 125 passes, about one
and a half long meetings. That ceiling is not a budget problem, it is a CORRECTNESS problem: a
judge out of quota reports every point as not covered, which looks exactly like a meeting that
covered nothing. On 2026-10-12 a colleague ran six test calls and four of them scored 0 of 11 with
every single pass refused (`passes: 10, changes: 0, failures: 10` in meeting 97's stored stats).
Groq's paid Developer tier was closed to new signups at the time, so the judge moved to OpenAI's
`gpt-6-luna`. Whisper stayed on Groq — separate model, separate meter, never the thing running out.

Measured on all three fixtures, one run each:

| fixture (hand label) | gpt-oss-120b | gpt-6-luna |
|---|---|---|
| sales-1to1-short (3 covered) | 5 covered · 6/11 | **2 covered · 7/11** |
| sales-1to1-scripted (7 covered) | 8 covered · 10/11 | 8 covered · 9/11 |
| sales-1to1 (8 covered) | 10 covered · 9/11 | 11 covered · 8/11 |

Exact match is a wash (25/33 against 24/33). The useful difference is in the DIRECTION of the
errors: luna is far more honest on a thin call (2 covered where Groq says 5) and more generous on a
long one. Since the thin call is the failure that actually reached a customer-facing demo, and
every meeting is thin for its first minutes, that is the better trade — but it is a trade, and the
long-meeting generosity is the thing to watch.

The decisive evidence was not a fixture. Replayed over meeting 97 — a real 3-minute sales 1:1 that
the quota-starved judge had scored 0 of 11 — luna returned **4 covered · 1 started · 6 not yet**,
agreeing line for line with an independent read by ChatGPT on 9 of the 11 points, and correctly
leaving blockers, manager support, top prospects and next steps open.

Cost: ~1 100 prompt + ~900 completion tokens per pass (of which ~700 reasoning), so ~2 000 tokens
a pass against Groq's ~1 600. There is no daily cap.

### Dialects

"OpenAI-compatible" is a family, not a contract, and the differences are not discoverable in
advance:

| | Groq gpt-oss-120b | OpenAI gpt-6-luna |
|---|---|---|
| token limit parameter | `max_tokens` | `max_completion_tokens` (400s on the other) |
| `temperature: 0` | fine | rejected — only the default is allowed |
| `reasoning_effort: low` | fine | fine |

Each endpoint names what it wants in its 400, so `llm.ts` reads that and corrects itself once per
process. `NEXUS_LIVE_LLM_MAX_TOKENS_PARAM` sets the opening guess; a wrong guess costs one request,
not every checklist in the deployment.
