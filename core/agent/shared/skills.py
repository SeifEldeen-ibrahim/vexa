"""skills.py — the meeting SKILL registry: what a meeting can be about.

A skill is one product capability the copilot may recognise and the assistant may act on. It is
OFF everywhere until a meeting's owner turns it on, and with none on the copilot has never heard of
any of these products — it cannot propose one because it does not know the vocabulary. That is a
stronger guarantee than instructing a model to stay quiet, and it is why the default is nothing
rather than everything.

Three parts, deliberately separable:

  KNOWLEDGE  ``agents/skills/<id>.md`` in the workspace — merged into the copilot's prompt when the
             skill is on. Prose, so tuning what a product sounds like is an edit, not a deploy.
  REPO       repo-backed skills act by writing a document into the OWNER'S OWN git repo, pinned once
             per user. Partic and BIAMI work this way: their product reads from a repo, so authoring
             is a commit and there is nothing for this deployment to execute.
  TOOL       the MCP tool the assistant calls once someone in the meeting agrees.

Adding a sixth product is a row here plus a knowledge file. Nothing else.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

#: Where a skill's knowledge lives, relative to the workspace root.
SKILLS_DIR = "agents/skills"

#: Merged once whenever ANY skill is on — the rules every proposal obeys. Kept out of the per-skill
#: files so five enabled skills do not repeat it five times in one prompt.
SHARED_PROPOSAL_RULES = f"{SKILLS_DIR}/_propose.md"


@dataclass(frozen=True)
class Skill:
    """One product capability. ``repo_backed`` decides whether enabling it needs a pinned repo."""

    id: str
    label: str
    #: The MCP tool the assistant calls after someone agrees.
    tool: str
    #: True ⇒ acting means committing a document into the owner's own repo, so the skill needs one
    #: pinned before it can do anything. False ⇒ the tool reports what it would have done (the three
    #: products with no repo contract yet).
    repo_backed: bool = False
    #: Shown when a repo-backed skill is enabled with nothing pinned.
    pin_hint: str = ""

    @property
    def knowledge_path(self) -> str:
        return f"{SKILLS_DIR}/{self.id}.md"


SKILLS: tuple = (
    Skill("partic", "Partic", "partic_create_pipeline", repo_backed=True,
          pin_hint="the repo Partic syncs pipelines from"),
    Skill("biami", "BIAMI", "biami_create_process", repo_backed=True,
          pin_hint="your BIAMI Dev checkout"),
    Skill("matrix", "Matrix", "matrix_create_task"),
    Skill("contentmorph", "ContentMorph", "contentmorph_transform"),
    Skill("tenx", "10x Factory", "tenx_request"),
)

_BY_ID = {s.id: s for s in SKILLS}


def all_ids() -> list:
    """Every known skill id, in display order."""
    return [s.id for s in SKILLS]


def get(skill_id: str) -> Optional[Skill]:
    return _BY_ID.get((skill_id or "").strip().lower())


def known(skill_ids) -> list:
    """The given ids narrowed to ones this build knows, de-duplicated, in registry order.

    FAIL-CLOSED on the way in: an unknown id is dropped rather than passed through. The enabled set
    is stored per meeting and read back later, so a skill removed from a build must not resurrect
    itself as a name nothing can resolve."""
    want = {(s or "").strip().lower() for s in (skill_ids or [])}
    return [s.id for s in SKILLS if s.id in want]


def repo_backed_ids() -> list:
    return [s.id for s in SKILLS if s.repo_backed]


def steering_includes(skill_ids) -> tuple:
    """Workspace-relative knowledge files to merge for this set of enabled skills.

    Empty in, empty out — and that is the whole default: no skills means no product knowledge in the
    prompt at all. The shared proposal rules lead, then each skill in registry order, so the prompt
    reads the same way whichever subset is on."""
    ids = known(skill_ids)
    if not ids:
        return ()
    return (SHARED_PROPOSAL_RULES, *[_BY_ID[i].knowledge_path for i in ids])


def tools_for(skill_ids) -> list:
    """The tool names the assistant may call for this set. Empty ⇒ the assistant cannot act on a
    product at all, which is the correct state for a meeting with no skills on."""
    return [_BY_ID[i].tool for i in known(skill_ids)]
