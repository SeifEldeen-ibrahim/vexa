"""The skill surfaces: which products a meeting is about, and which repo backs each one.

Driven through the SHIPPED app, because the questions worth asking here are boundary questions —
whether an unknown id is refused, whether a fault reads as open or closed, and whether the read path
tells the truth after a reload.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from shared.config import load_settings
from tests.test_api import _FakeIdentity, _FakeRuntime


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    # An isolated store per test: pins and tokens live under it, and a test must never read or
    # write the deployment's real one.
    settings = load_settings(workspaces_dir=str(tmp_path / "ws"))
    return TestClient(create_app(Dispatcher(settings, _FakeRuntime(), _FakeIdentity())))


# ── the registry, as the UI sees it ───────────────────────────────────────────────────────

def test_the_meeting_surface_offers_every_skill_and_enables_none(client):
    """Nothing is on until someone turns it on — the state of every new meeting."""
    r = client.get("/api/meeting/skills", params={"native_id": "abc-defg-hij"},
                   headers={"X-User-Id": "6"})
    assert r.status_code == 200
    body = r.json()
    assert [s["id"] for s in body["available"]] == ["partic", "biami", "matrix", "contentmorph", "tenx"]
    assert body["enabled"] == []


def test_the_surface_says_which_skills_NEED_a_repo(client):
    """The UI has to distinguish "enabled" from "usable" at the toggle, not in the meeting."""
    body = client.get("/api/meeting/skills", params={"native_id": "abc-defg-hij"},
                      headers={"X-User-Id": "6"}).json()
    backed = {s["id"]: s["repo_backed"] for s in body["available"]}
    assert backed == {"partic": True, "biami": True, "matrix": False,
                      "contentmorph": False, "tenx": False}


def test_an_unknown_skill_is_REFUSED(client):
    """Ids reach a path lookup in the copilot. An unknown one must never be stored."""
    r = client.post("/api/meeting/skills", headers={"X-User-Id": "6"},
                    json={"native_id": "abc-defg-hij", "skill": "../../etc/passwd", "on": True})
    assert r.status_code == 400


def test_the_body_refuses_unknown_FIELDS(client):
    """`extra: forbid`, like every other per-meeting body — so a client cannot smuggle a grant."""
    r = client.post("/api/meeting/skills", headers={"X-User-Id": "6"},
                    json={"native_id": "abc", "skill": "partic", "on": True, "workspace": True})
    assert r.status_code == 422


# ── the grants read path (a reloaded tab must not show the opposite of the truth) ──────────

def test_chat_access_can_be_READ_not_only_written(client):
    """Without this the UI hydrates both toggles from `useState(false)` while the server may hold
    "anyone" and "workspace" — the control then sends the opposite of what the user believes."""
    r = client.get("/api/meeting/chat-access", params={"native_id": "abc-defg-hij"},
                   headers={"X-User-Id": "6"})
    assert r.status_code == 200
    assert r.json()["scope"] == "transcript" and r.json()["anyone"] is False


def test_an_unreadable_grant_store_reads_as_CLOSED(client, monkeypatch):
    """A read fault must never render as "anyone can ask"."""
    import redis as _redis

    def boom(*a, **kw):
        raise RuntimeError("redis down")

    monkeypatch.setattr(_redis, "from_url", boom)
    body = client.get("/api/meeting/chat-access", params={"native_id": "abc"},
                      headers={"X-User-Id": "6"}).json()
    assert body["scope"] == "transcript" and body["anyone"] is False


def test_an_unreadable_skill_store_reads_as_NOTHING_enabled(client, monkeypatch):
    """Fails quiet, never loud: a redis blip cannot make the copilot start talking about products."""
    import redis as _redis

    monkeypatch.setattr(_redis, "from_url", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("x")))
    body = client.get("/api/meeting/skills", params={"native_id": "abc"},
                      headers={"X-User-Id": "6"}).json()
    assert body["enabled"] == []


# ── pinning ───────────────────────────────────────────────────────────────────────────────

def test_the_pin_surface_lists_only_repo_backed_skills(client):
    body = client.get("/api/skills/repos", headers={"X-User-Id": "6"}).json()
    assert [s["id"] for s in body["skills"]] == ["partic", "biami"]
    assert all(s["pinned"] is None for s in body["skills"])


def test_with_no_token_the_repo_list_is_EMPTY_with_a_reason(client):
    """"You have not linked GitHub" is a state the UI renders, not a failure it reports."""
    body = client.get("/api/skills/repos", headers={"X-User-Id": "6"}).json()
    assert body["repos"] == [] and body["token_set"] is False
    assert "token" in body["note"].lower()


def test_a_skill_that_needs_no_repo_cannot_be_pinned(client):
    r = client.post("/api/skills/repos", headers={"X-User-Id": "6"},
                    json={"skill": "matrix", "repo": "https://github.com/x/y"})
    assert r.status_code == 400


def test_an_unknown_skill_cannot_be_pinned(client):
    r = client.post("/api/skills/repos", headers={"X-User-Id": "6"},
                    json={"skill": "nope", "repo": "https://github.com/x/y"})
    assert r.status_code == 400


def test_unpinning_needs_no_repo_and_no_network(client):
    r = client.post("/api/skills/repos", headers={"X-User-Id": "6"},
                    json={"skill": "partic", "repo": ""})
    assert r.status_code == 200 and r.json()["skills"] == {}


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
