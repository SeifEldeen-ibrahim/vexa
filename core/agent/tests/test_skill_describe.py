"""What the assistant is allowed to LOOK at before it writes.

Reported from a live meeting: "I don't see a connectors folder… I can't browse your repo". True, and
my doing — moving the git work into the control plane (so the GitHub token never enters a sandbox
that reads untrusted meeting input) also stopped the repo being mounted, which left the assistant
able to write a document and unable to read what it must conform to.

That is not a small gap. A product's import gate rejects anything non-canonical, out of band, where
nobody in the meeting sees it — and the likeliest reason is an invented connector name. So the
contract and the real connector list are read through the same control-plane hop the write uses:
no mount, no token in the worker, and available in BOTH grounding scopes, because a product's own
documentation has nothing to do with how much MEETING history is in reach.
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from control_plane import skill_actions


def _partic_repo(tmp_path):
    (tmp_path / "AUTHORING_CONTRACT.md").write_text("# Pipeline authoring contract\nRule 1: refs.\n")
    d = tmp_path / "connectors"
    d.mkdir()
    (d / "a.json").write_text(json.dumps({
        "id": "uuid-1", "name": "klavyio", "connector_type_id": "klaviyo", "status": "connected",
        "config": {"schema": {"resources": [
            {"name": "profiles", "fields": [{"name": "email"}, {"name": "phone_number"}]}]}},
    }))
    (d / "b.json").write_text(json.dumps({
        "id": "uuid-2", "name": "dest", "connector_type_id": "csv", "status": "connected",
        "config": {"schema": {"resources": [{"name": "rows", "fields": []}]}},
    }))
    (tmp_path / "pipelines").mkdir()
    (tmp_path / "pipelines" / "existing.json").write_text("{}")
    return tmp_path


def test_the_contract_is_read_VERBATIM_not_summarised(tmp_path):
    """It is the only statement of what the import gate accepts. A summary would produce documents
    that look right and import as errors nobody in the meeting ever sees."""
    got = skill_actions.partic_describe(_partic_repo(tmp_path))
    assert got["authoring_contract"].startswith("# Pipeline authoring contract")
    assert "Rule 1: refs." in got["authoring_contract"]


def test_the_REAL_connectors_are_listed_with_their_types_and_fields(tmp_path):
    """The half a model cannot do from memory: a ref is an invented name bound to a connector that
    really exists in THIS project, so without the list it guesses, and a guess is a rejection."""
    got = skill_actions.partic_describe(_partic_repo(tmp_path))
    by_name = {c["name"]: c for c in got["connectors"]}
    assert set(by_name) == {"klavyio", "dest"}
    assert by_name["klavyio"]["connector_type_id"] == "klaviyo"
    assert by_name["klavyio"]["resources"][0]["fields"] == ["email", "phone_number"]


def test_it_says_what_already_EXISTS(tmp_path):
    """So the model does not propose a name that is taken, and can see the house style."""
    assert skill_actions.partic_describe(_partic_repo(tmp_path))["existing_pipelines"] == ["existing.json"]


def test_a_bare_repo_describes_as_EMPTY_rather_than_raising(tmp_path):
    """A wrong repo pinned must degrade to "I can see nothing here", never to a failed turn."""
    got = skill_actions.partic_describe(tmp_path)
    assert got == {"authoring_contract": "", "connectors": [], "existing_pipelines": []}


def test_an_unreadable_connector_file_is_skipped(tmp_path):
    repo = _partic_repo(tmp_path)
    (repo / "connectors" / "broken.json").write_text("{not json")
    assert len(skill_actions.partic_describe(repo)["connectors"]) == 2


def test_a_huge_contract_is_capped(tmp_path):
    repo = _partic_repo(tmp_path)
    (repo / "AUTHORING_CONTRACT.md").write_text("x" * 100_000)
    got = skill_actions.partic_describe(repo)
    assert len(got["authoring_contract"]) == skill_actions.DESCRIBE_CONTRACT_CHARS


# ── BIAMI: the verbs are a CLOSED vocabulary ──────────────────────────────────────────────

def _biami_repo(tmp_path):
    (tmp_path / "db").mkdir()
    con = sqlite3.connect(tmp_path / "db" / "pro_cess.db")
    con.execute("create table script (id integer, filename text)")
    con.executemany("insert into script values (?,?)",
                    [(1, "do_nothing"), (2, "run_command"), (3, "selenium_ide")])
    con.execute("create table context (idx integer, ref integer, key text, value text)")
    con.execute("insert into context values (14, 7, 'generic', 'existing_process')")
    con.commit()
    con.close()
    (tmp_path / "temp").mkdir()
    (tmp_path / "temp" / "import.tsv").write_text("Stage\tBusiness Task Name\n0\tsomething\n")
    return tmp_path


def test_the_script_vocabulary_comes_from_BIAMIS_OWN_table(tmp_path):
    """`script` is closed — the engine resolves each cell against that table — so an invented verb
    is not a slightly-wrong process, it is an import that registers nothing. Read from the table the
    importer will actually check against, not from a list kept here that could drift."""
    got = skill_actions.biami_describe(_biami_repo(tmp_path))
    assert got["scripts"] == ["do_nothing", "run_command", "selenium_ide"]


def test_it_names_the_processes_that_already_exist(tmp_path):
    got = skill_actions.biami_describe(_biami_repo(tmp_path))
    assert got["existing_processes"] == ["existing_process"]


def test_it_states_the_TSV_columns_and_shows_a_real_example(tmp_path):
    got = skill_actions.biami_describe(_biami_repo(tmp_path))
    assert got["columns"][0] == "Stage" and got["columns"][3] == "Script"
    assert got["example_tsv"].startswith("Stage\t")


def test_a_repo_with_no_database_describes_as_empty(tmp_path):
    got = skill_actions.biami_describe(tmp_path)
    assert got["scripts"] == [] and got["existing_processes"] == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
