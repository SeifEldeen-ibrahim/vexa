# Meeting skills — per-meeting product capabilities, backed by the user's own repos

**Status:** plan, for review
**Date:** 2026-09-07

## What this changes, in one paragraph

Today the copilot knows about all five products, always, from one `agents/products.md` merged into
every meeting prompt — and the tools it can call POST to a deployment-wide endpoint that does not
exist. After this change, a **skill** is a per-meeting toggle. Nothing is on by default: a meeting
with no skills enabled has a copilot that has never heard of Partic. Turning one on gives the
copilot that product's knowledge (so it can recognise the need and propose), and gives the
assistant read access to **that user's own pinned repo** for the product, plus a narrow tool that
writes a document into it and pushes. The user links GitHub once in Settings and pins one repo per
skill.

## Why a repo and not an API

Read from the real repos (`SeifEldeen-ibrahim/vibe-pipe`, `SeifEldeen-ibrahim/biamiDev`):

* **Partic**: a pipeline is a JSON document in a git repo. Partic syncs `connectors/*.json` and
  rewrites `AUTHORING_CONTRACT.md` INTO the repo; you push a pipeline document back and Partic
  imports it, rejecting anything non-canonical. The repo carries **no credentials**. There is no
  API call to make — the commit is the delivery.
* **BIAMI**: a process is a TSV (`Stage | Business Task | Technical Task | Script | Parameter 1`).
  Authoring is text. Running needs the client's own Java runtime and a signed-in browser — which is
  why we do not run anything: **we author and push, their cluster picks it up.**

So the same mechanism serves both: mount the user's repo, read its contract, write a document,
commit, push. Nothing is executed by us, ever.

## The five decisions

### D1 — A skill is data, not code

```
core/agent/workspace-seeds/default/agents/skills/<skill>.md
```

One file per skill, carrying what the copilot needs to recognise and phrase a proposal (what today's
`products.md` holds, split five ways). Adding a sixth product is a file plus a registry row, never a
code change. Deleting a file turns that skill off everywhere.

A small registry (`core/agent/shared/skills.py`) names them and says which are repo-backed:

| skill | knowledge | repo-backed | tool |
| --- | --- | --- | --- |
| `partic` | `skills/partic.md` | yes | `partic_create_pipeline` |
| `biami` | `skills/biami.md` | yes | `biami_create_process` |
| `matrix` | `skills/matrix.md` | no (handoff) | `matrix_agent_prompt` |
| `contentmorph` | `skills/contentmorph.md` | no (stub) | `contentmorph_transform` |
| `tenx` | `skills/tenx.md` | no (stub) | `tenx_request` |

`contentmorph` and `tenx` keep today's stub behaviour verbatim — knowledge + a tool that reports
what it would have done. Only `partic` and `biami` get repos.

`matrix` is the third shape: its own chat agent is already in the meeting's Google Chat space,
signed in as the person who paired it, so nothing here acts. `matrix_agent_prompt` renders the line
somebody sends to that agent, bounded by what the agent actually accepts — no endpoint, no
credential, no write reach.

### D2 — Enablement is per meeting, and off by default

Same shape as the existing `anyone` / `workspace` grants:

```
meetskills:meeting:{row_id}   → a redis SET of enabled skill ids, 12h TTL
POST /api/meeting/skills      { meeting_id, native_id, skill, on }
```

Nothing enabled ⇒ the copilot's prompt contains no product knowledge at all ⇒ it cannot suggest,
because it does not know the vocabulary. That is the honest way to implement "by default processing
knows nothing": not a rule telling the model to stay quiet, but nothing to be quiet about.

**This is independent of the two existing toggles and must not touch them.** `anyone` decides *who
may ask*; `workspace` decides *how much history is in reach*. Skills decide *what the meeting is
about*. All three compose: a transcript-only meeting with `partic` on can still suggest and still
create — the workspace toggle governs past meeting notes, not products.

### D3 — The skills must travel on the dispatch

The copilot is a sandboxed container with no redis and no network. It cannot read the toggle. So
the arm path reads the enabled set and puts it on the invocation; dispatch stamps
`VEXA_MEETING_SKILLS=partic,biami`; the worker merges only those knowledge files.

`shared/agent_config.py` currently has `MEETING_STEERING_INCLUDES = ("agents/products.md",)`, a
constant. It becomes a function of the enabled set, defaulting to **nothing**.

### D4 — Per-user repos, pinned per skill

The GitHub module already exists and is nearly all of this:

* `POST /api/workspace/git-token` — a reusable PAT, stored server-side per subject, never returned
* `POST /api/workspace/activate` — clone a repo into the subject's active set, token-authenticated
* `POST /api/workspace/push` / `pull` — fast-forward only, token redacted on error

What is missing is small:

1. **A repo picker.** `GET /api/workspace/git-repos` → the caller's repos from
   `GET https://api.github.com/user/repos` using their stored token. Names and URLs only.
2. **A pin store.** `control_plane/skill_repos.py`, one JSON per subject:
   `{"partic": {"slug": "...", "repo": "...", "ref": "main"}, "biami": {...}}`, with
   `GET/POST /api/skills/repos`. Pinning clones via the existing `activate_workspace`.
3. **Settings UI** — link GitHub, then a repo dropdown per repo-backed skill.

### D5 — Writing is a tool, not a write grant

This is the security crux, and the place to be most careful.

The meeting-chat turn reads **untrusted input**: anyone in the room can address it. That is why it
has no `Write`/`Edit`/`Bash` today, and that must not change — a general write grant on that turn
means anyone in a meeting can write anything into the owner's Partic repo.

So:

* The pinned repo is mounted **read-only** on the chat turn. The assistant can read
  `AUTHORING_CONTRACT.md` and `connectors/*.json` — which is exactly what it needs to author
  correctly, and the reason the contract lives in the repo at all.
* Writing happens through the **tool**, which is narrow and audited: it takes a document, writes it
  at a path the tool chooses inside the pinned repo, commits with the owner as author, and pushes.
  It cannot write anywhere else, cannot run anything, and cannot be talked into a different path.

`product-actions/server.py` changes from "POST to an endpoint" to "commit into the pinned repo" for
`partic` and `biami`. The other three keep their stub POST.

### Cross-user isolation

Stated explicitly because the user named it as a hard requirement:

* A pinned repo is cloned into **that subject's own workspace store** (`<root>/<subject>/…`), which
  is how every workspace already works — `build_mount_set` derives mounts per subject and the
  runtime binds only that subject's subpaths.
* The GitHub token is per subject in `git_credentials`, read only inside that subject's request.
* The tool is handed **one repo path** by the dispatch, not a search path.
* Two users pinning the *same* repo URL get two independent clones under their own roots.

The one new hazard is the mount **allowlist**: today `build_mount_set` mounts a subject's whole
active set. A user with Partic and BIAMI pinned and only Partic enabled for this meeting must get
only the Partic repo. So dispatch gains an optional `mount_allowlist` on the invocation, and the
meet-chat dispatch passes it. It can only ever **narrow** — same rule as `_apply_granted_modes`.

## Work packages

| # | package | files |
| --- | --- | --- |
| W1 | skill registry + split knowledge files | `shared/skills.py`, `workspace-seeds/default/agents/skills/*.md` |
| W2 | per-meeting enablement + API | `control_plane/api.py`, redis key, `MeetingSkills` body |
| W3 | skills on the dispatch → copilot prompt | `transcription_watcher.py`, `dispatch.py`, `shared/agent_config.py`, `worker/engine.py` |
| W4 | repo picker + pin store + Settings UI | `control_plane/skill_repos.py`, `api.py`, terminal Settings |
| W5 | mount allowlist (narrow-only) | `control_plane/dispatch.py` |
| W6 | repo-backed tools (write + commit + push) | `tools-seed/product-actions/server.py` |
| W7 | meeting UI toggles | `clients/terminal/src/canvas/MeetingCanvasView.tsx` |

## Acceptance

| # | observation | control |
| --- | --- | --- |
| A1 | no skills enabled ⇒ the copilot prompt contains no product vocabulary | with `partic` on, it does |
| A2 | `partic` on ⇒ only `skills/partic.md` merges, not biami's | both on ⇒ both |
| A3 | a skill toggle does not alter `anyone` or `workspace` | and vice versa |
| A4 | transcript-only + `partic` on ⇒ still suggests, still creates | the fork the user called out explicitly |
| A5 | the chat turn has no `Write`/`Edit`/`Bash` with a repo mounted | the mount is `write: false` |
| A6 | the tool writes only inside the pinned repo | a traversal path is refused |
| A7 | subject A's dispatch never mounts subject B's repo | two subjects, same repo URL, two clones |
| A8 | a skill enabled with no repo pinned answers "not linked", not "failed" | distinct message |
| A9 | the mount allowlist can only narrow | an allowlist naming an unmounted repo adds nothing |
| A10 | existing meet-chat behaviour unchanged with all skills off | the full existing suite green |

## Open questions for review

1. **Does the copilot need the repo too?** It proposes but does not act; it has no tools by design.
   Current answer: no — knowledge is enough to recognise a need. But the *proposal quality* might be
   better if it knew the real connector names. Deferred: knowledge first, repo later if the
   proposals are too generic.
2. **Push conflicts.** Two meetings authoring into one repo, or a stale clone. `push_origin` is
   fast-forward only and fails loud — the tool should pull first and report a divergence rather than
   retry.
3. **What the tool writes for BIAMI.** Partic's path is clear (`pipelines/<name>.json`). For BIAMI
   the repo holds `temp/import.tsv` plus named fixtures — is a new process a new named TSV, or does
   it replace `import.tsv`? Needs the user's answer; the safe default is a **new named file**, never
   overwriting an existing one.

---

# Revision after review (5 reviewers)

Three of the plan's load-bearing claims were wrong. Corrected here; the sections above are left as
written so the change is legible.

## R1 — BIAMI's premise is false: a TSV creates nothing

`biamiDev/README.txt` is decisive: import is `./core_run.sh --context_param cmd=import`, reading a
**hardcoded** `../temp/import.tsv`, run by a human with Java 8 — and it mutates `db/pro_cess.db`,
the SQLite file that IS the process store. Every process-adding commit in that repo changes the db
alongside the TSV. And `README.md` says Matrix syncs `db/pro_cess.db`, `plugins/**`, `temp/env/**` —
**`temp/*.tsv` is not a synced surface**. A pushed TSV reaches the cluster and does nothing.

So "we author and push, their cluster picks it up" is true for Partic and false for BIAMI.
Reimplementing BIAMI's importer against its SQLite schema would mean shipping a second, unowned
copy of a vendor's import semantics — the opposite of "we never execute".

**BIAMI is authoring-only.** The tool writes `temp/<process_name>.tsv`, commits, pushes, and says
plainly that the process does not exist until someone runs the import. `skills/biami.md`'s proposal
wording changes to match — it must not promise creation. Never writes `temp/import.tsv`: that is a
staging slot whose content records what is in the committed db.

## R2 — The git work moves to the control plane

Two reviewers reached this independently, from different directions:

* **The token has no safe route into the worker.** `harness_subprocess_env` is a two-entry denylist,
  so anything stamped into the worker env is inherited by the harness AND the MCP server it spawns —
  and an ordinary chat turn has `Bash`. Stamping a GitHub PAT there leaks it by default.
* **A writable mount cannot be the security boundary.** `write: false` becomes a kernel `:ro` bind,
  so the tool could not write either; and mounting it writable means `run_harness_turn` auto-commits
  that repo after **every** turn, putting unrelated Vexa commits into the user's Partic repo forever.

So: **the pinned repo is not mounted into the chat turn at all.** The MCP tool becomes a thin client
that calls agent-api, which holds the token, owns the clone, and does pull → validate → write →
commit → push under the existing `workspace_write_lock`. This also resolves the plan's A25 problem —
"transcript only" stays literally true, because no repo is in the container.

Authentication for that callback: dispatch mints a per-unit secret into
`unitauth:<unit_id>` (subject + enabled skills, TTL = the turn's life) and stamps it in the worker
env. agent-api resolves the secret to the subject — never trusting a subject in the request body.

**The model still needs the contract.** It cannot read a repo it does not mount, and transcript scope
has no file tools anyway. So the same server exposes a read call that returns the authoring contract
plus a connector digest. This is strictly better than a mount: it works in both scopes and grants
nothing.

## R3 — Push order, and the deadlock the plan would have caused

`pull_origin` refuses when the local clone is ahead. So "commit → push fails → pull" **wedges the
clone permanently**. Correct order is **pull → validate → write → commit → push**, and on a rejected
push: roll the commit back, re-pull, re-apply, retry once, then report. Never force.

## R4 — The non-owner gate is now load-bearing

`anyone` was scoped as "who may ask", and the only thing stopping a guest's "@vexa yes" from firing
a tool is a sentence in the tool's description. That cost a stub POST; it now costs a commit to the
owner's repo. **Repo-backed tools require `asker_is_owner`** — a check in the responder, not a line
in a prompt. So skills and `anyone` are NOT independent, and the plan was wrong to say so.

## R5 — Corrections to smaller claims

* **A5/A6 were at the wrong altitude.** A5 asserted a property that did not hold (fixed separately in
  `484ab90b`); A6 tested a path argument the tool does not take. The attacker-controlled input is
  `description`, which becomes filename, content and commit message.
* **The stub tools lie today.** `status: accepted` + "is being executed" for a product with no
  endpoint means the assistant tells a room something was created. Becomes `unavailable`.
* **The toggles had no read path.** No `GET /api/meeting/chat-access` existed and the UI hydrated
  from `useState(false)`, so a reloaded tab showed the opposite of the truth. Added.
* **Partic's contract is incomplete** — `expression_type`/`api_variable` appear in an accepted
  document and nowhere in the spec — and at least one rejection rule (a union target must exist in
  the first input schema) is not derivable from the document. Local validation catches the coded
  rejections; the rest needs a round trip we cannot see. Say "written, it will appear once it
  imports", never "created".
* **No webhook exists on `vibe-pipe`.** That Partic ingests a pushed document is the user's claim
  about their own product, not something this repo can witness.

## Revised scope

| phase | content | status |
| --- | --- | --- |
| A | skills registry, split knowledge, per-meeting toggles, dispatch, copilot prompt, UI | the headline ask |
| B | GitHub repo pinning + Settings | needed for C |
| C | Partic write path, control-plane side, validated | the payoff |
| D | BIAMI authoring-only + stub honesty + owner gate on repo tools | correctness |

Deferred, named: BIAMI import runner; sticky per-user skill defaults; pin-time repo/permission
preflight; propose-in-panel-only.
