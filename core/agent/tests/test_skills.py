"""The meeting SKILL registry — what a meeting is allowed to be about.

The property everything else rests on: **nothing is on by default**. A meeting with no skills
enabled must produce a copilot that has never heard of these products, so it cannot propose one —
not because it was told to stay quiet, but because the vocabulary is absent from its prompt.

These also pin the registry against the knowledge files actually shipped in the seed, so a skill
whose file is missing is a red here rather than a copilot that silently proposes nothing.
"""
from __future__ import annotations

import pathlib

import pytest

from shared import skills

SEED = pathlib.Path(__file__).resolve().parents[1] / "workspace-seeds" / "default"


# ── the default is nothing ────────────────────────────────────────────────────────────────

def test_no_skills_means_NO_product_knowledge():
    assert skills.steering_includes([]) == ()
    assert skills.steering_includes(None) == ()
    assert skills.tools_for([]) == []


def test_no_skills_means_the_assistant_cannot_ACT_on_a_product_either():
    """Knowledge and tools move together. A meeting that cannot recognise a product must not be
    able to call its tool by other means."""
    assert skills.tools_for([]) == []
    assert skills.tools_for(["nope"]) == []


# ── enabling one enables exactly one ──────────────────────────────────────────────────────

def test_one_skill_brings_its_own_knowledge_and_nobody_elses():
    inc = skills.steering_includes(["partic"])
    assert "agents/skills/partic.md" in inc
    assert not any("biami" in p or "matrix" in p for p in inc)


def test_the_shared_proposal_rules_are_merged_ONCE_however_many_skills():
    """Five enabled skills must not repeat the same rules five times in one prompt."""
    for enabled in (["partic"], ["partic", "biami"], skills.all_ids()):
        inc = skills.steering_includes(enabled)
        assert inc.count(skills.SHARED_PROPOSAL_RULES) == 1


def test_the_shared_rules_come_FIRST():
    """They frame every proposal that follows; a model reads the frame before the content."""
    inc = skills.steering_includes(["biami", "partic"])
    assert inc[0] == skills.SHARED_PROPOSAL_RULES


def test_the_order_is_the_registrys_not_the_callers():
    """The enabled set arrives from a redis SET, which has no order. A prompt that reshuffles
    between beats is a prompt that cannot be reasoned about."""
    a = skills.steering_includes(["partic", "biami"])
    b = skills.steering_includes(["biami", "partic"])
    assert a == b


# ── fail closed ───────────────────────────────────────────────────────────────────────────

def test_an_unknown_skill_is_DROPPED_not_passed_through():
    """The enabled set is stored per meeting and read back later. A skill removed from a build must
    not resurrect itself as a name nothing can resolve."""
    assert skills.known(["partic", "deploy_to_prod", ""]) == ["partic"]
    assert "deploy_to_prod" not in str(skills.steering_includes(["deploy_to_prod"]))


def test_ids_are_normalised_and_de_duplicated():
    assert skills.known(["PARTIC", " partic ", "partic"]) == ["partic"]


def test_get_answers_none_for_an_unknown_id():
    assert skills.get("nope") is None
    assert skills.get("") is None
    assert skills.get("partic").tool == "partic_create_pipeline"


# ── the registry matches what ships ───────────────────────────────────────────────────────

def test_every_skill_ships_a_knowledge_file():
    """A registered skill whose file is missing enables silently and teaches the copilot nothing."""
    for sid in skills.all_ids():
        path = SEED / skills.get(sid).knowledge_path
        assert path.is_file(), f"{sid}: {path} missing"
        assert path.read_text().strip(), f"{sid}: knowledge file is empty"


def test_the_shared_rules_file_ships_too():
    assert (SEED / skills.SHARED_PROPOSAL_RULES).is_file()


def test_each_knowledge_file_names_its_own_tool():
    """The file tells the copilot which tool follows agreement; a mismatch there sends the assistant
    after a tool that does not exist."""
    for sid in skills.all_ids():
        text = (SEED / skills.get(sid).knowledge_path).read_text()
        assert skills.get(sid).tool in text, f"{sid} knowledge does not name {skills.get(sid).tool}"


def test_only_partic_and_biami_are_repo_backed():
    """The other three have no repo contract yet and keep reporting what they would have done."""
    assert skills.repo_backed_ids() == ["partic", "biami"]


def test_a_repo_backed_skill_says_what_to_pin():
    for sid in skills.repo_backed_ids():
        assert skills.get(sid).pin_hint, f"{sid} has no pin hint for the Settings UI"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
