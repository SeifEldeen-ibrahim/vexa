"""Checking a Partic pipeline document before it is committed.

Partic's import gate "never repairs your document — it only rejects", with a coded reason, and it
does so OUT OF BAND after our push where nobody in the meeting will see it. So the rules the
contract states literally are checked here, while the turn can still say what is wrong.

The anchor for all of it is `fixtures/partic_accepted_pipeline.json` — a real document that Partic
really accepted, taken from the repo's own history (`pipelines/klaviyo_csv_union.json@12d85366`).
Every rejection test is a MUTATION of that document, so a rule can only fire for the reason it
claims. A validator that rejects what Partic accepts is worse than no validator: it would block a
working pipeline in front of a room.
"""
from __future__ import annotations

import copy
import json
import pathlib

import pytest

from control_plane.partic_document import load_connectors, validate

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "partic_accepted_pipeline.json"


def accepted() -> dict:
    return json.loads(FIXTURE.read_text())


# ── the control: it must not reject what Partic accepted ──────────────────────────────────

def test_a_REAL_accepted_document_passes_clean():
    assert validate(accepted()) == []


def test_it_stays_clean_with_the_projects_real_connectors_in_hand(tmp_path):
    """The connector cross-check must not turn the anchor red either."""
    d = tmp_path / "connectors"
    d.mkdir()
    (d / "a.json").write_text(json.dumps({"id": "u1", "name": "klavyio", "connector_type_id": "klaviyo"}))
    (d / "b.json").write_text(json.dumps({"id": "u2", "name": "dest", "connector_type_id": "csv"}))
    assert validate(accepted(), load_connectors(tmp_path)) == []


# ── the envelope ──────────────────────────────────────────────────────────────────────────

def test_an_extra_top_level_key_is_rejected():
    doc = accepted(); doc["pipelines"] = []
    assert any("unknown top-level" in e for e in validate(doc))


def test_a_missing_top_level_key_is_rejected():
    doc = accepted(); del doc["metadata"]
    assert any("missing top-level" in e for e in validate(doc))


def test_the_format_string_must_be_exact():
    doc = accepted(); doc["format"] = "partic.pipeline/v2"
    assert any("format must be exactly" in e for e in validate(doc))


def test_something_that_is_not_an_object_is_rejected():
    assert validate([]) and validate("nope") and validate(None)


# ── rule 1: a ref is invented, never a UUID ───────────────────────────────────────────────

def test_a_UUID_in_a_binding_ref_is_rejected():
    """The contract's first rule, and its first error code — a UUID there stops the import before
    the document is read any further."""
    doc = accepted()
    doc["connector_bindings"][0]["ref"] = "cfe26b7a-c7d4-45f9-ae86-bbb2332aca43"
    assert any("invalid_ref" in e for e in validate(doc))


def test_a_ref_that_is_not_snake_lowercase_is_rejected():
    doc = accepted(); doc["connector_bindings"][0]["ref"] = "Widgets-API"
    assert any("must match" in e for e in validate(doc))


def test_a_source_naming_an_UNDECLARED_ref_is_rejected():
    doc = accepted(); doc["definition"]["sources"][0]["connector_id"] = "never_declared"
    assert any("not in connector_bindings" in e for e in validate(doc))


# ── run_config ────────────────────────────────────────────────────────────────────────────

def test_run_config_rejects_an_unknown_key():
    doc = accepted(); doc["definition"]["run_config"]["retries"] = 3
    assert any("run_config_unknown_key" in e for e in validate(doc))


def test_on_node_failure_is_fixed_at_halt():
    doc = accepted(); doc["definition"]["run_config"]["on_node_failure"] = "continue"
    assert any("invalid_on_node_failure" in e for e in validate(doc))


def test_the_legacy_camelCase_runConfig_is_rejected():
    doc = accepted(); doc["definition"]["runConfig"] = {}
    assert any("run_config" in e for e in validate(doc))


# ── ids ───────────────────────────────────────────────────────────────────────────────────

def test_a_missing_id_is_rejected():
    doc = accepted(); doc["definition"]["sources"][0].pop("id")
    assert any("missing_id" in e for e in validate(doc))


def test_a_duplicate_id_is_rejected():
    doc = accepted()
    doc["definition"]["sources"].append(copy.deepcopy(doc["definition"]["sources"][0]))
    assert any("duplicate_id" in e for e in validate(doc))


# ── operations ────────────────────────────────────────────────────────────────────────────

def test_an_unknown_operation_type_is_rejected():
    doc = accepted(); doc["definition"]["mappings"][0]["operations"][0]["type"] = "transmogrify"
    assert any("unknown operation type" in e for e in validate(doc))


def test_the_legacy_unnest_type_is_rejected_BY_NAME():
    doc = accepted(); doc["definition"]["mappings"][0]["operations"][0]["type"] = "unnest"
    assert any("rejected by name" in e for e in validate(doc))


def test_an_operation_using_kind_instead_of_type_is_rejected():
    doc = accepted()
    op = doc["definition"]["mappings"][0]["operations"][0]
    op["kind"] = op.pop("type")
    assert any("legacy_operation_kind" in e for e in validate(doc))


def test_a_passthrough_operation_carrying_extra_keys_is_rejected():
    doc = accepted()
    ops = doc["definition"]["mappings"][0]["operations"]
    ops.append({"id": "op_pt", "type": "field_map", "input_schema_id": "x", "fields": []})
    assert any("accepts only" in e for e in validate(doc))


# ── recomputed fields ─────────────────────────────────────────────────────────────────────

def test_supplying_source_fields_anywhere_is_rejected():
    """Always recomputed by Partic, at any depth, so supplying it is a rejection."""
    for key in ("source_fields", "sourceFields"):
        doc = accepted()
        doc["definition"]["mappings"][0]["output_schemas"][0]["fields"][0][key] = ["x"]
        assert any("source_fields_supplied" in e for e in validate(doc)), key


# ── the connector cross-check ─────────────────────────────────────────────────────────────

def test_a_connector_type_this_project_does_not_have_is_flagged(tmp_path):
    """The likeliest model error is inventing a connector. The repo carries the real list, so this
    is checkable rather than guessable."""
    d = tmp_path / "connectors"
    d.mkdir()
    (d / "a.json").write_text(json.dumps({"id": "u1", "name": "dest", "connector_type_id": "csv"}))
    doc = accepted()
    doc["connector_bindings"][0]["connector_type_id"] = "salesforce"
    assert any("not a connector type in this project" in e for e in validate(doc, load_connectors(tmp_path)))


def test_with_NO_connectors_readable_the_cross_check_is_skipped(tmp_path):
    """A missing connectors/ directory must not reject a document Partic would accept."""
    assert load_connectors(tmp_path) == []
    assert validate(accepted(), load_connectors(tmp_path)) == []


def test_an_unreadable_connector_file_is_skipped_not_fatal(tmp_path):
    d = tmp_path / "connectors"
    d.mkdir()
    (d / "broken.json").write_text("{not json")
    (d / "ok.json").write_text(json.dumps({"id": "u", "name": "n", "connector_type_id": "csv"}))
    assert [c["connector_type_id"] for c in load_connectors(tmp_path)] == ["csv"]


# ── what it deliberately does NOT claim ───────────────────────────────────────────────────

def test_it_does_not_invent_canonicalisation_rules():
    """Partic canonicalises aliases and field names itself, and at least one real rejection rule (a
    union target must exist in the first input schema) is nowhere in the contract. Approximating
    those would reject documents Partic accepts — worse than the round trip. A clean result here
    means "worth pushing", never "will import", and the caller must say so."""
    doc = accepted()
    doc["definition"]["mappings"][0]["output_schemas"][0]["alias"] = "NotCanonicalAtAll"
    assert validate(doc) == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


# ── a failed commit must leave nothing behind ─────────────────────────────────────────────

def test_a_failed_commit_removes_the_file_and_unstages_it(tmp_path):
    """Caught end-to-end against a real repo. A commit refused for a missing committer identity left
    the file written AND staged, so the next attempt saw the name taken, wrote a discriminated one,
    and swept the orphan into its own commit — two files in the user's repo from one request, one of
    them never asked for."""
    import subprocess

    from control_plane import skill_actions

    repo = tmp_path / "r"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base", "--allow-empty",
                    "--author", "T <t@t>"], check=True,
                   env={"PATH": "/usr/bin:/bin", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@t"})

    # An unwritable target makes the git step fail after the file exists.
    with pytest.raises(Exception):
        skill_actions.write_document(repo, "p/x.json", "{}", message="")   # empty message → refused

    assert not (repo / "p" / "x.json").exists(), "the file survived a failed commit"
    staged = subprocess.run(["git", "-C", str(repo), "diff", "--cached", "--name-only"],
                            capture_output=True, text=True).stdout.strip()
    assert staged == "", f"a failed commit left {staged!r} staged"
