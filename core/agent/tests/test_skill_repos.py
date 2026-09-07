"""Which of the user's OWN repos backs each repo-backed skill.

The user's hard requirement for this whole feature: "no cross user leakage git, or partic, or biami,
or any thing". A pin is per subject, resolves to a slug inside that subject's own workspace store,
and is read on the dispatch path — so the rules that matter here are the ones about NOT resolving:
another subject's pins, a slug that escapes its store, a skill this build does not ship.
"""
from __future__ import annotations

import json

import pytest

from control_plane import skill_repos as sr


def test_nothing_is_pinned_until_someone_pins_it(tmp_path):
    assert sr.read_pins(tmp_path, "6") == {}
    assert sr.slugs_for(tmp_path, "6", ["partic", "biami"]) == []


def test_a_pin_round_trips(tmp_path):
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe", repo="https://github.com/x/vibe-pipe")
    got = sr.read_pins(tmp_path, "6")["partic"]
    assert got == {"slug": "vibe-pipe", "repo": "https://github.com/x/vibe-pipe", "ref": "main"}


def test_pinning_again_replaces_rather_than_duplicates(tmp_path):
    sr.pin(tmp_path, "6", "partic", slug="one")
    sr.pin(tmp_path, "6", "partic", slug="two")
    assert sr.read_pins(tmp_path, "6")["partic"]["slug"] == "two"


def test_unpinning_twice_is_not_an_error(tmp_path):
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe")
    sr.unpin(tmp_path, "6", "partic")
    sr.unpin(tmp_path, "6", "partic")
    assert sr.read_pins(tmp_path, "6") == {}


# ── the mount allowlist ───────────────────────────────────────────────────────────────────

def test_only_the_ENABLED_skills_repos_are_returned(tmp_path):
    """A user with both pinned who enabled only Partic for this meeting gets the Partic repo and
    nothing else. This list IS the mount allowlist."""
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe")
    sr.pin(tmp_path, "6", "biami", slug="biamidev")
    assert sr.slugs_for(tmp_path, "6", ["partic"]) == ["vibe-pipe"]
    assert sr.slugs_for(tmp_path, "6", ["biami"]) == ["biamidev"]
    assert sr.slugs_for(tmp_path, "6", ["partic", "biami"]) == ["vibe-pipe", "biamidev"]


def test_no_skills_enabled_means_NO_repos(tmp_path):
    """The default state of every meeting: the assistant gets no product repo at all."""
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe")
    assert sr.slugs_for(tmp_path, "6", []) == []


def test_an_enabled_skill_with_no_pin_contributes_NOTHING(tmp_path):
    """It must not fall back to another skill's repo — acting on the wrong repo is unrecoverable,
    where "not linked" is a fixable answer."""
    sr.pin(tmp_path, "6", "biami", slug="biamidev")
    assert sr.slugs_for(tmp_path, "6", ["partic"]) == []
    assert sr.missing_pins(tmp_path, "6", ["partic"]) == ["partic"]


def test_a_skill_that_needs_no_repo_is_never_reported_missing(tmp_path):
    """Matrix/ContentMorph/10x have no repo contract yet; enabling one is complete on its own."""
    assert sr.missing_pins(tmp_path, "6", ["matrix", "contentmorph", "tenx"]) == []


def test_the_slug_order_is_the_registrys(tmp_path):
    """The enabled set comes from a redis SET, which has no order. Mounts that reshuffle between
    turns are mounts that cannot be reasoned about."""
    sr.pin(tmp_path, "6", "partic", slug="p")
    sr.pin(tmp_path, "6", "biami", slug="b")
    assert sr.slugs_for(tmp_path, "6", ["biami", "partic"]) == sr.slugs_for(tmp_path, "6", ["partic", "biami"])


# ── isolation and refusal ─────────────────────────────────────────────────────────────────

def test_one_subjects_pins_are_invisible_to_another(tmp_path):
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe")
    assert sr.read_pins(tmp_path, "7") == {}
    assert sr.slugs_for(tmp_path, "7", ["partic"]) == []


def test_two_subjects_may_pin_the_SAME_repo_url_independently(tmp_path):
    """Each clone lands under its own subject's store, so this is two workspaces, not one shared."""
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe-6", repo="https://github.com/x/vibe-pipe")
    sr.pin(tmp_path, "7", "partic", slug="vibe-pipe-7", repo="https://github.com/x/vibe-pipe")
    assert sr.slugs_for(tmp_path, "6", ["partic"]) == ["vibe-pipe-6"]
    assert sr.slugs_for(tmp_path, "7", ["partic"]) == ["vibe-pipe-7"]


def test_a_traversing_slug_is_REFUSED(tmp_path):
    """The slug becomes a path segment inside the workspace store."""
    for bad in ("../etc", "a/b", "", "..", "x" * 200):
        with pytest.raises(ValueError):
            sr.pin(tmp_path, "6", "partic", slug=bad)


def test_a_traversing_SUBJECT_is_refused(tmp_path):
    for bad in ("../other", "a/b", ""):
        with pytest.raises(ValueError):
            sr.pin(tmp_path, bad, "partic", slug="s")
        assert sr.read_pins(tmp_path, bad) == {}


def test_a_skill_that_is_not_repo_backed_cannot_be_pinned(tmp_path):
    with pytest.raises(ValueError):
        sr.pin(tmp_path, "6", "matrix", slug="s")


def test_an_unknown_skill_cannot_be_pinned(tmp_path):
    with pytest.raises(ValueError):
        sr.pin(tmp_path, "6", "deploy_to_prod", slug="s")


def test_a_pin_for_a_skill_this_BUILD_no_longer_ships_is_dropped_on_read(tmp_path):
    """Written by an older build. It must not resurrect as a name nothing can resolve."""
    p = tmp_path / ".secrets" / "6.skillrepos.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"partic": {"slug": "ok"}, "retired": {"slug": "ghost"}}))
    assert list(sr.read_pins(tmp_path, "6")) == ["partic"]
    assert sr.slugs_for(tmp_path, "6", ["retired"]) == []


def test_a_corrupt_pin_file_reads_as_NOTHING_pinned(tmp_path):
    """On the dispatch path. Unparseable must degrade to "not linked", never raise into a turn."""
    p = tmp_path / ".secrets" / "6.skillrepos.json"
    p.parent.mkdir(parents=True)
    for junk in ("{not json", "[]", "null", '{"partic": "a string"}', '{"partic": {}}'):
        p.write_text(junk)
        assert sr.read_pins(tmp_path, "6") == {}, junk


def test_the_pin_store_holds_NO_credential(tmp_path):
    """The token lives in git_credentials, alone. A pin can be shown in the UI; a token cannot."""
    sr.pin(tmp_path, "6", "partic", slug="vibe-pipe", repo="https://github.com/x/vibe-pipe")
    raw = (tmp_path / ".secrets" / "6.skillrepos.json").read_text().lower()
    assert "token" not in raw and "@" not in raw


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
