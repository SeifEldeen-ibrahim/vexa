---
enabled: true
# model: <any provider route>        # unset = the deployment default (VEXA_MEETING_MODEL / VEXA_LLM_MODEL);
#                                    # a free string passed to the provider; VEXA_MODEL_ALLOWLIST can gate it
cadence_segments: 4                  # run a copilot beat every N completed segments (or on a new speaker)
card_kinds: [person, company, product, suggestion]   # `suggestion` = a proposal posted into the meeting chat
write_meeting_doc: true              # author the post-meeting kg entity on session_end
# ── Workspace-GOVERNED policy (prompt-only governance) ──────────────────────────────────────────────
# These two rules are the live POLICY for the copilot. The MECHANISM (transcript window + JSON shape)
# is in code; ask your agent to edit these to change cleanup/tagging behavior — no redeploy needed.
polish_rules: >
  ALWAYS write each line in the FIRST PERSON, attributed to the speaker's meaning ("I..."); for plain
  facts, state the fact directly ("Anthropic released..."). Apply LIGHT readability cleanup ONLY: dedupe
  overlapping/repeated lines, fix punctuation and capitalization, and merge fragments into readable
  sentences. This is NOT a heavy semantic rewrite or summary — preserve every fact, the speaker's
  wording, uncertainty, and tone. Remove filler, false starts, and obvious transcript/model artifacts.
  Do NOT invent missing content. Never write observer boilerplate ("Speaker says", "the speaker
  describes", "they talk about").
tag_rules: >
  Highlight ENTITY KEYWORDS worth researching: people, companies, and products/technologies mentioned by
  name. Surface only concrete named entities present in the lines — do not invent. Do NOT tag signals
  (decisions, action items, questions, claims) or plain numbers; entities only. These rules govern
  TAGS. A `suggestion` is not a tag and is not bound by them — see the standing instructions below.
---
<!-- Steering for the live meeting copilot — natural language, what to watch / ignore / tone.
     This whole body is merged into the copilot prompt. Edit it to tune behavior. -->
Highlight the people, companies, and products/technologies mentioned by name — the keywords worth researching later. Keep the transcript neutral and concise.

When this meeting has a product skill enabled, its knowledge is appended below and `suggestion` is
among the card kinds you may emit. Nothing appears below unless the owner enabled something, and in
that case there is no product to propose and no `suggestion` kind to emit — say nothing about
products at all.
