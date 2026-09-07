"""agent_config.py — the GOVERNED, workspace-driven config for per-agent behavior.

The user/agent steers the real-time meeting copilot through a VISIBLE, git-governed file in their
workspace: ``agents/meeting.md`` (a per-agent config home — NOT a dotfile, so it shows in the Files
tree and the user can read+edit it; seeded from the workspace template). It is YAML frontmatter (the
knobs) + a natural-language body (steering merged into the copilot prompt).

This module is deliberately small, isolated, and unit-testable: it has no redis/docker/claude
dependency. Parsing is TOLERANT — a missing file, missing/partial frontmatter, or malformed YAML each
fall back PER-KEY to the current code defaults, and the body (if any) is always taken as steering.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from shared import skills

log = logging.getLogger(__name__)

# PROVIDER-AGNOSTIC model governance: a model is a FREE STRING the llm module's provider adapter
# interprets — NO vendor names or committed model list live in code. Resolution (call-time, so a
# respawned worker sees current env): VEXA_MEETING_MODEL (meeting-specific) → VEXA_LLM_MODEL (the
# deployment default) → "" (the adapter's own default, or fail-loud where a model is required).
def default_meeting_model() -> str:
    return os.environ.get("VEXA_MEETING_MODEL") or os.environ.get("VEXA_LLM_MODEL") or ""


def model_allowlist() -> frozenset[str]:
    """The OPTIONAL operator gate on workspace-pinned models: ``VEXA_MODEL_ALLOWLIST`` (comma-
    separated). Empty/unset ⇒ allow any route — the config file is governed but user-editable, so
    operators who need to bound spend or routes set the env; nobody else pays a code-change."""
    raw = os.environ.get("VEXA_MODEL_ALLOWLIST", "")
    return frozenset(m.strip() for m in raw.split(",") if m.strip())

DEFAULT_CARD_KINDS: tuple[str, ...] = ("person", "company", "product")
DEFAULT_CADENCE_SEGMENTS = 4

# v2 DEFAULTS — the polish + tagging POLICY. These live as code fallbacks but the user GOVERNS them by
# editing ``agents/meeting.md`` (the seed carries the same text); changing the file changes the prompt,
# no redeploy. The mechanism is in code (``build_card_prompt`` composes around the transcript window);
# the policy is this prose.
DEFAULT_POLISH_RULES = (
    "ALWAYS write each line in the FIRST PERSON, attributed to the speaker's meaning (\"I...\"); for "
    "plain facts, state the fact directly (\"Anthropic released...\"). Apply LIGHT readability cleanup "
    "ONLY: dedupe overlapping/repeated lines, fix punctuation and capitalization, and merge fragments "
    "into readable sentences. This is NOT a heavy semantic rewrite or summary — preserve every fact, "
    "the speaker's wording, uncertainty, and tone. Remove filler, false starts, and obvious "
    "transcript/model artifacts. Do NOT invent missing content. Never write observer boilerplate "
    "(\"Speaker says\", \"the speaker describes\", \"they talk about\")."
)
DEFAULT_TAG_RULES = (
    "Highlight ENTITY KEYWORDS worth researching: people, companies, and products/technologies "
    "mentioned by name. Surface only concrete named entities present in the lines — do not invent. "
    "Do NOT tag signals (decisions, action items, questions, claims) or plain numbers; entities only."
)


@dataclass(frozen=True)
class MeetingConfig:
    """The resolved meeting-copilot knobs (every field has a code default; see ``load_meeting_config``)."""

    enabled: bool = True
    model: str = field(default_factory=default_meeting_model)
    cadence_segments: int = DEFAULT_CADENCE_SEGMENTS
    card_kinds: list[str] = field(default_factory=lambda: list(DEFAULT_CARD_KINDS))
    write_meeting_doc: bool = True
    steering: str = ""
    # Workspace-governed POLICY (prompt-only governance): edit agents/meeting.md to change behavior.
    polish_rules: str = DEFAULT_POLISH_RULES
    tag_rules: str = DEFAULT_TAG_RULES


_FRONTMATTER = re.compile(r"^\s*---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)

# Where the per-agent config lives in the workspace (visible, git-governed).
MEETING_CONFIG_PATH = "agents/meeting.md"

#: Companion steering files appended to ``agents/meeting.md``'s body. They exist so a long,
#: slow-changing knowledge base (what a product IS, what phrases signal it) can be edited on its own
#: without touching the copilot's polish/tag rules.
#:
#: WHICH ones are merged is a per-MEETING decision now, not a constant: the owner enables skills for
#: a meeting and only those products' files are read. With none enabled the copilot has never heard
#: of any of them and cannot propose one — a stronger guarantee than instructing a model to stay
#: quiet, and the reason the default is nothing rather than everything.
#:
#: The paths come from ``shared.skills``, which resolves them from a REGISTRY. A skill id never
#: becomes part of a path directly: an id arrives from an API and travels through an env var, and
#: interpolating one into ``Path(work) / rel`` would read arbitrary files into the copilot's prompt
#: and from there into cards the whole room sees.
MEETING_STEERING_INCLUDES: tuple = ()


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Return (frontmatter-dict, body). Tolerant: no fence ⇒ ({}, whole-text-as-body); bad yaml ⇒
    ({}, body)."""
    m = _FRONTMATTER.match(text)
    if not m:
        return {}, text.strip()
    raw_fm, body = m.group(1), m.group(2)
    try:
        data = yaml.safe_load(raw_fm)
    except yaml.YAMLError:
        log.warning("agents/meeting.md: malformed YAML frontmatter — using defaults")
        return {}, body.strip()
    if not isinstance(data, dict):
        return {}, body.strip()
    return data, body.strip()


def _as_bool(val: object, default: bool) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in {"true", "yes", "1", "on"}
    return default


def _as_model(val: object) -> str:
    """A workspace-pinned model is a free string passed through to the provider adapter. When the
    operator set ``VEXA_MODEL_ALLOWLIST``, an off-list route falls back to the deployment default
    with a log line (a typo cannot silently pin an unexpected route); with no allowlist, any
    non-blank route passes."""
    if isinstance(val, str) and val.strip():
        candidate = val.strip()
        allow = model_allowlist()
        if not allow or candidate in allow:
            return candidate
        log.warning(
            "agents/meeting.md: model %r not in VEXA_MODEL_ALLOWLIST — falling back to default %r",
            candidate, default_meeting_model(),
        )
    return default_meeting_model()


def _as_cadence(val: object) -> int:
    try:
        n = int(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_CADENCE_SEGMENTS
    return n if n >= 1 else DEFAULT_CADENCE_SEGMENTS


def _as_rules(val: object, default: str) -> str:
    """A governed POLICY string (polish_rules / tag_rules). A non-empty string (frontmatter scalar)
    overrides the code default; anything else (absent, blank, non-string) falls back to the default so a
    partial config never blanks out the policy."""
    if isinstance(val, str) and val.strip():
        return val.strip()
    return default


def _as_card_kinds(val: object) -> list[str]:
    if isinstance(val, (list, tuple)):
        kinds = [str(k).strip().lower() for k in val if str(k).strip()]
        if kinds:
            return kinds
    return list(DEFAULT_CARD_KINDS)


#: The card kind that is a PROPOSAL rather than a tag. It exists only to ask for one of the enabled
#: products, so with none enabled it is not a kind this meeting can emit.
SUGGESTION_CARD_KIND = "suggestion"


def _narrow_card_kinds(kinds: list, skill_ids) -> list:
    """Drop ``suggestion`` when no skill is enabled.

    Belt-and-braces, deliberately: with no skill enabled the copilot has no product knowledge, so it
    has nothing to propose and should not emit one anyway. Removing the kind means a model that
    invents a proposal from thin air still cannot deliver it — the parser only accepts declared
    kinds. The workspace keeps `suggestion` in its frontmatter either way, so turning a skill on
    needs no config edit."""
    if skills.known(skill_ids):
        return kinds
    return [k for k in kinds if k != SUGGESTION_CARD_KIND]


def load_meeting_config(work: Path, skill_ids=None) -> MeetingConfig:
    """Read ``<work>/agents/meeting.md`` and return the resolved ``MeetingConfig`` with PER-KEY
    fallback to the code defaults. Absent file ⇒ all defaults. Tolerant of bad YAML / no frontmatter
    (body, if any, is still used as steering).

    ``skill_ids`` names the products enabled for THIS meeting; their knowledge files are merged into
    the steering. Omitted or empty ⇒ no product knowledge at all, which is every meeting's default
    and does not affect the copilot's ordinary work — cleaning the transcript, tagging entities and
    writing the meeting doc are governed by the frontmatter and happen regardless."""
    path = Path(work) / MEETING_CONFIG_PATH
    if not path.exists():
        return MeetingConfig()
    try:
        text = path.read_text()
    except OSError:
        return MeetingConfig()

    fm, body = _split_frontmatter(text)
    # Companion steering: appended AFTER the body, so the meeting-specific steering a user wrote is
    # read first and an include cannot quietly override it. A missing or unreadable include is simply
    # skipped — steering is prose, and half of it is better than failing a meeting.
    for rel in (*MEETING_STEERING_INCLUDES, *skills.steering_includes(skill_ids)):
        inc = Path(work) / rel
        try:
            if inc.is_file():
                extra = inc.read_text().strip()
                if extra:
                    body = f"{body.rstrip()}\n\n{extra}" if body.strip() else extra
        except OSError:
            log.warning("%s: unreadable steering include — continuing without it", rel)

    return MeetingConfig(
        enabled=_as_bool(fm.get("enabled"), True),
        model=_as_model(fm.get("model")),
        cadence_segments=_as_cadence(fm.get("cadence_segments")),
        card_kinds=_narrow_card_kinds(_as_card_kinds(fm.get("card_kinds")), skill_ids),
        write_meeting_doc=_as_bool(fm.get("write_meeting_doc"), True),
        steering=body,
        polish_rules=_as_rules(fm.get("polish_rules"), DEFAULT_POLISH_RULES),
        tag_rules=_as_rules(fm.get("tag_rules"), DEFAULT_TAG_RULES),
    )
