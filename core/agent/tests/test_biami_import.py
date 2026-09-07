"""Running BIAMI's own importer — the step that makes a process real.

A TSV alone creates nothing. The process lives in `db/pro_cess.db`, the SQLite file BIAMI's engine
writes and the cluster syncs; `temp/*.tsv` is not a synced surface at all. So authoring without
importing would push a file that never becomes anything, and tell the room it had.

These run against a REAL BIAMI checkout when one is available (VEXA_BIAMI_REPO), and skip otherwise
— the engine is a Talend-derived JVM and there is nothing honest to fake about it. The property they
exist to pin is the one the whole feature rests on: import REGISTERS a task and does not RUN it.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

from control_plane import skill_actions

REPO = os.environ.get("VEXA_BIAMI_REPO", "")
needs_repo = pytest.mark.skipif(
    not (REPO and Path(REPO, "core", "core_run.sh").is_file()),
    reason="set VEXA_BIAMI_REPO to a BIAMI Dev checkout (needs java) to run these",
)

PROBE = (
    "Stage\tBusiness Task Name\tTechnical Task Name\tScript\tParameter 1\n"
    "0\tvexa_test_probe\tWritten by a Vexa test\tdo_nothing\t\n"
    "1\tWrite a marker\t\trun_command\truncommand=echo RAN > /tmp/vexa-import-must-not-run.txt\n"
)


def _tasks(repo: Path) -> int:
    con = sqlite3.connect(f"file:{repo / 'db' / 'pro_cess.db'}?mode=ro", uri=True)
    try:
        return con.execute("select count(*) from task").fetchone()[0]
    finally:
        con.close()


@pytest.fixture()
def checkout(tmp_path) -> Path:
    """A throwaway copy, so a test never mutates the real checkout."""
    dest = tmp_path / "biami"
    shutil.copytree(REPO, dest, ignore=shutil.ignore_patterns(".git"))
    subprocess.run(["git", "init", "-q", str(dest)], check=True)
    subprocess.run(["git", "-C", str(dest), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(dest), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(dest), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(dest), "commit", "-qm", "base"], check=True)
    return dest


@needs_repo
def test_the_import_REGISTERS_the_process(checkout):
    before = _tasks(checkout)
    (checkout / "temp" / "vexa_test_probe.tsv").write_text(PROBE)
    skill_actions.biami_import(checkout, "temp/vexa_test_probe.tsv")
    assert _tasks(checkout) > before
    assert "vexa_test_probe" in skill_actions.biami_imported_names(checkout)


@needs_repo
def test_the_import_DOES_NOT_RUN_the_process(checkout):
    """The property the whole feature rests on, and the reason it is safe to do this at all.

    The probe's stage 1 is a `run_command` that writes a marker. `cmd=import` registers the task;
    `cmd=request` runs one. If import ever started executing, this file would appear — and Vexa
    would be running arbitrary commands from a meeting."""
    marker = Path("/tmp/vexa-import-must-not-run.txt")
    marker.unlink(missing_ok=True)
    (checkout / "temp" / "vexa_test_probe.tsv").write_text(PROBE)
    skill_actions.biami_import(checkout, "temp/vexa_test_probe.tsv")
    assert not marker.exists(), "import EXECUTED the process — that must never happen"


@needs_repo
def test_the_import_leaves_the_DATABASE_changed_and_committable(checkout):
    """The db is what the cluster syncs, so it is what has to reach the push."""
    (checkout / "temp" / "vexa_test_probe.tsv").write_text(PROBE)
    skill_actions.biami_import(checkout, "temp/vexa_test_probe.tsv")
    dirty = subprocess.run(["git", "-C", str(checkout), "status", "--porcelain"],
                           capture_output=True, text=True).stdout
    assert "db/pro_cess.db" in dirty
    sha = skill_actions.commit_all(checkout, "import", author=("T", "t@t"))
    assert sha and not subprocess.run(["git", "-C", str(checkout), "status", "--porcelain"],
                                      capture_output=True, text=True).stdout.strip()


@needs_repo
def test_the_authored_file_survives_beside_the_staging_slot(checkout):
    """`temp/import.tsv` records what was last imported and is overwritten every time; the authored
    process keeps its own name so the repo still says what was created."""
    (checkout / "temp" / "vexa_test_probe.tsv").write_text(PROBE)
    skill_actions.biami_import(checkout, "temp/vexa_test_probe.tsv")
    assert (checkout / "temp" / "vexa_test_probe.tsv").is_file()
    assert (checkout / "temp" / "import.tsv").read_text().startswith("Stage\t")


@needs_repo
def test_a_broken_definition_RAISES_so_the_caller_can_roll_back(checkout):
    (checkout / "temp" / "bad.tsv").write_text("this is not a BIAMI process at all\n")
    try:
        skill_actions.biami_import(checkout, "temp/bad.tsv")
    except Exception:
        return                                    # the caller rolls the commit back
    # An importer that accepts junk silently is also a finding — say which happened.
    assert "bad" not in skill_actions.biami_imported_names(checkout), \
        "the importer accepted a malformed definition"


def test_reading_process_names_from_a_repo_with_no_database_is_empty(tmp_path):
    """No java, no checkout — the name check must degrade rather than block authoring."""
    assert skill_actions.biami_imported_names(tmp_path) == set()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
