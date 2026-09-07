"""agent_config — the governed, workspace-driven meeting-copilot config (agents/meeting.md).

Proves the isolated parser: all defaults when absent, per-key fallback on partial frontmatter, body
becomes steering, tolerant of malformed YAML / no frontmatter — and the PROVIDER-AGNOSTIC model
governance: a model is a free string; VEXA_MEETING_MODEL → VEXA_LLM_MODEL resolve the deployment
default at call time; the OPTIONAL operator allowlist (VEXA_MODEL_ALLOWLIST) gates workspace pins.
"""
from __future__ import annotations

from pathlib import Path

from shared.agent_config import (
    DEFAULT_CADENCE_SEGMENTS,
    DEFAULT_CARD_KINDS,
    DEFAULT_POLISH_RULES,
    DEFAULT_TAG_RULES,
    default_meeting_model,
    load_meeting_config,
    model_allowlist,
)


def _write(work: Path, text: str) -> None:
    p = work / "agents" / "meeting.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def _clear_model_env(monkeypatch) -> None:
    for var in ("VEXA_MEETING_MODEL", "VEXA_LLM_MODEL", "VEXA_MODEL_ALLOWLIST"):
        monkeypatch.delenv(var, raising=False)


def test_absent_file_all_defaults(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    cfg = load_meeting_config(tmp_path)
    assert cfg.enabled is True
    assert cfg.model == ""  # no env, no pin → the provider adapter's own default
    assert cfg.cadence_segments == DEFAULT_CADENCE_SEGMENTS
    assert cfg.card_kinds == list(DEFAULT_CARD_KINDS)
    assert cfg.write_meeting_doc is True
    assert cfg.steering == ""


def test_full_config_parsed(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    _write(tmp_path, (
        "---\n"
        "enabled: false\n"
        "model: any-provider/route-v9\n"
        "cadence_segments: 7\n"
        "card_kinds: [person, action]\n"
        "write_meeting_doc: false\n"
        "---\n"
        "Watch only for budget commitments. Ignore small talk.\n"
    ))
    cfg = load_meeting_config(tmp_path)
    assert cfg.enabled is False
    assert cfg.model == "any-provider/route-v9"  # free string — no vendor allowlist in code
    assert cfg.cadence_segments == 7
    assert cfg.card_kinds == ["person", "action"]
    assert cfg.write_meeting_doc is False
    assert "budget commitments" in cfg.steering


def test_default_meeting_model_env_resolution(monkeypatch):
    _clear_model_env(monkeypatch)
    assert default_meeting_model() == ""
    monkeypatch.setenv("VEXA_LLM_MODEL", "deployment-default")
    assert default_meeting_model() == "deployment-default"
    monkeypatch.setenv("VEXA_MEETING_MODEL", "meeting-override")
    assert default_meeting_model() == "meeting-override"  # meeting-specific env wins


def test_partial_frontmatter_per_key_fallback(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("VEXA_LLM_MODEL", "deployment-default")
    _write(tmp_path, "---\ncadence_segments: 2\n---\njust steering text\n")
    cfg = load_meeting_config(tmp_path)
    assert cfg.cadence_segments == 2                 # set
    assert cfg.enabled is True                       # fell back
    assert cfg.model == "deployment-default"         # fell back to env default
    assert cfg.card_kinds == list(DEFAULT_CARD_KINDS)
    assert cfg.steering == "just steering text"


def test_model_allowlist_gates_workspace_pin(tmp_path, monkeypatch):
    """With VEXA_MODEL_ALLOWLIST set, an off-list workspace pin falls back to the deployment
    default (a typo cannot silently pin an unexpected route); an on-list pin passes."""
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("VEXA_LLM_MODEL", "deployment-default")
    monkeypatch.setenv("VEXA_MODEL_ALLOWLIST", "good-model, another-model")
    assert model_allowlist() == frozenset({"good-model", "another-model"})

    _write(tmp_path, "---\nmodel: gpt-4o-mega\n---\n")
    assert load_meeting_config(tmp_path).model == "deployment-default"  # gated out

    _write(tmp_path, "---\nmodel: good-model\n---\n")
    assert load_meeting_config(tmp_path).model == "good-model"          # allowed through


def test_no_allowlist_means_any_model_passes(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    _write(tmp_path, "---\nmodel: gpt-4o-mega\n---\n")
    assert load_meeting_config(tmp_path).model == "gpt-4o-mega"


def test_bad_cadence_falls_back(tmp_path):
    _write(tmp_path, "---\ncadence_segments: not-a-number\n---\n")
    assert load_meeting_config(tmp_path).cadence_segments == DEFAULT_CADENCE_SEGMENTS
    _write(tmp_path, "---\ncadence_segments: 0\n---\n")
    assert load_meeting_config(tmp_path).cadence_segments == DEFAULT_CADENCE_SEGMENTS


def test_no_frontmatter_whole_body_is_steering(tmp_path):
    _write(tmp_path, "Just steer me, no fence here.")
    cfg = load_meeting_config(tmp_path)
    assert cfg.steering == "Just steer me, no fence here."
    assert cfg.enabled is True  # defaults otherwise


def test_malformed_yaml_falls_back_to_defaults_plus_body(tmp_path):
    _write(tmp_path, "---\nenabled: [unterminated\n  : : :\n---\nstill steers\n")
    cfg = load_meeting_config(tmp_path)
    assert cfg.enabled is True
    assert cfg.card_kinds == list(DEFAULT_CARD_KINDS)
    assert cfg.steering == "still steers"


def test_empty_steering_body(tmp_path):
    _write(tmp_path, "---\nenabled: true\n---\n")
    assert load_meeting_config(tmp_path).steering == ""


def test_polish_and_tag_rules_default_when_absent(tmp_path):
    _write(tmp_path, "---\nenabled: true\n---\n")
    cfg = load_meeting_config(tmp_path)
    assert cfg.polish_rules == DEFAULT_POLISH_RULES
    assert cfg.tag_rules == DEFAULT_TAG_RULES


def test_polish_and_tag_rules_governed_by_workspace(tmp_path):
    """Editing the workspace file overrides the POLICY (prompt-only governance)."""
    _write(tmp_path, "---\npolish_rules: Keep it terse.\ntag_rules: Only tag people.\n---\n")
    cfg = load_meeting_config(tmp_path)
    assert cfg.polish_rules == "Keep it terse."
    assert cfg.tag_rules == "Only tag people."


def test_blank_rules_fall_back_to_defaults(tmp_path):
    _write(tmp_path, "---\npolish_rules: '   '\n---\n")
    assert load_meeting_config(tmp_path).polish_rules == DEFAULT_POLISH_RULES


# ── which product knowledge reaches the copilot's prompt ──────────────────────────────────
#
# The include loop had ZERO test coverage while it was a constant, which is exactly why turning it
# into a function of per-meeting state needed a guard on both sides first.

_SEED = Path(__file__).resolve().parents[1] / "workspace-seeds" / "default"


def test_no_skills_means_no_product_knowledge_in_the_prompt():
    """Every meeting's default. The copilot has never heard of these products, so it cannot propose
    one — an absence, not an instruction to stay quiet."""
    steering = load_meeting_config(_SEED).steering
    for product in ("Partic", "BIAMI", "Matrix", "ContentMorph", "10x Factory"):
        assert product not in steering, product


def test_an_enabled_skill_brings_its_knowledge_and_nobody_elses():
    steering = load_meeting_config(_SEED, ["partic"]).steering
    assert "Partic" in steering
    assert "ContentMorph" not in steering and "10x Factory" not in steering


def test_two_skills_bring_both():
    steering = load_meeting_config(_SEED, ["partic", "biami"]).steering
    assert "Partic" in steering and "BIAMI" in steering


def test_the_meetings_OWN_steering_is_read_first():
    """A skill file is appended AFTER the workspace's own steering, so an include can never quietly
    override what the user wrote for this meeting."""
    steering = load_meeting_config(_SEED, ["partic"]).steering
    assert steering.index("Highlight the people") < steering.index("Partic")


def test_the_copilots_ORIGINAL_job_is_untouched_by_having_no_skills():
    """Cleaning the transcript, tagging entities and writing the meeting doc are governed by the
    frontmatter and must happen whether or not any product is enabled."""
    cfg = load_meeting_config(_SEED)
    assert cfg.enabled is True
    assert cfg.write_meeting_doc is True
    assert cfg.polish_rules.strip() and cfg.tag_rules.strip()
    assert cfg.card_kinds[:3] == ["person", "company", "product"]
    assert cfg.cadence_segments > 0


def test_the_suggestion_KIND_is_unavailable_with_no_skill_enabled():
    """Belt-and-braces beneath the knowledge absence: the parser only accepts declared kinds, so a
    model that invents a proposal from nothing still cannot deliver one."""
    assert "suggestion" not in load_meeting_config(_SEED).card_kinds
    assert "suggestion" in load_meeting_config(_SEED, ["partic"]).card_kinds


def test_an_unknown_skill_id_reads_NOTHING(tmp_path):
    """Ids arrive from an API and are stored in redis. One must never become part of a path — an
    include is read into a prompt whose output the whole room sees."""
    base = load_meeting_config(_SEED).steering
    for hostile in (["../../../etc/passwd"], ["../agents/meeting"], ["nope"], [""]):
        assert load_meeting_config(_SEED, hostile).steering == base, hostile


def test_a_missing_knowledge_file_does_not_fail_the_meeting(tmp_path):
    """Steering is prose. Half of it is better than a meeting that stops processing."""
    ws = tmp_path / "ws"
    (ws / "agents").mkdir(parents=True)
    (ws / "agents" / "meeting.md").write_text("---\nenabled: true\n---\nwatch things")
    cfg = load_meeting_config(ws, ["partic"])       # no agents/skills/ at all
    assert cfg.enabled is True and "watch things" in cfg.steering


def test_the_skills_parameter_is_optional():
    """`/api/models` calls this with no meeting context at all."""
    assert load_meeting_config(_SEED).model == load_meeting_config(_SEED, None).model
