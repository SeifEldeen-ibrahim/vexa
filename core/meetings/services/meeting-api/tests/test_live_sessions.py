"""The IN-PERSON lane — the meetings row a Nexus extension call runs on.

Asserts the three things that would otherwise fail silently and expensively:
  * the internal tier is CLOSED (no secret configured → nothing works; wrong secret → 401);
  * the lane is owner-scoped end to end (another user's session is simply absent);
  * a reconnect mid-call reuses the SAME row rather than forking the meeting in two.

OFFLINE — the shipped router over the in-memory store (no DB, no redis).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.live_sessions import (
    InMemoryLiveSessionStore,
    PLATFORM,
    build_router,
)

SECRET = "internal-secret-for-tests"
USER = 7
OTHER = 8


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    app = FastAPI()
    app.include_router(build_router(InMemoryLiveSessionStore()))
    return TestClient(app)


AUTH = {"Authorization": f"Bearer {SECRET}"}


def _start(client, *, uid="nx-1", user=USER, title="Standup", agenda=None):
    body = {"user_id": user, "session_uid": uid, "data": {"title": title}}
    if agenda is not None:
        body["data"]["agenda"] = agenda
    return client.post("/internal/live/sessions", json=body, headers=AUTH)


# ── the internal tier is closed ────────────────────────────────────────────────────────────────

def test_no_secret_configured_refuses_every_call(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    app = FastAPI()
    app.include_router(build_router(InMemoryLiveSessionStore()))
    c = TestClient(app)
    r = c.post("/internal/live/sessions", json={"user_id": USER, "session_uid": "x"}, headers=AUTH)
    assert r.status_code == 503, "an unset secret must refuse, never default to open"


def test_a_wrong_or_missing_secret_is_refused(client):
    for headers in ({}, {"Authorization": "Bearer nope"}, {"Authorization": "Bearer "}, {"Authorization": "nope"}):
        r = client.post(
            "/internal/live/sessions",
            json={"user_id": USER, "session_uid": "x"},
            headers=headers,
        )
        assert r.status_code == 401, headers


def test_the_bearer_prefix_is_optional_like_the_sibling_internal_route(client):
    """Possession of the secret IS the authorization — one header form works across the whole
    internal tier (mirrors POST /internal/bots/{platform}/{native}/chat)."""
    r = client.post(
        "/internal/live/sessions",
        json={"user_id": USER, "session_uid": "bare"},
        headers={"Authorization": SECRET},
    )
    assert r.status_code == 201


def test_a_call_must_name_an_owner_and_a_session(client):
    assert client.post("/internal/live/sessions", json={"session_uid": "x"}, headers=AUTH).status_code == 422
    assert client.post("/internal/live/sessions", json={"user_id": 0, "session_uid": "x"}, headers=AUTH).status_code == 422
    assert client.post("/internal/live/sessions", json={"user_id": USER}, headers=AUTH).status_code == 422


# ── the row ────────────────────────────────────────────────────────────────────────────────────

def test_a_session_is_born_active_on_the_in_person_platform(client):
    r = _start(client)
    assert r.status_code == 201
    row = r.json()
    assert row["platform"] == PLATFORM
    assert row["status"] == "active", "a call in a room is live the moment audio flows"
    assert row["native_meeting_id"] == "nx-1"
    assert row["start_time"]
    assert row["data"]["title"] == "Standup"
    assert row["data"]["source"] == "nexus-extension"


def test_a_reconnect_returns_the_same_row_instead_of_forking_the_meeting(client):
    first = _start(client).json()
    second = _start(client).json()
    assert first["id"] == second["id"]


def test_a_new_uid_is_a_new_meeting(client):
    assert _start(client, uid="nx-1").json()["id"] != _start(client, uid="nx-2").json()["id"]


def test_ending_a_session_completes_it_and_is_idempotent(client):
    mid = _start(client).json()["id"]
    first = client.post(f"/internal/live/sessions/{mid}/end", json={"user_id": USER}, headers=AUTH)
    assert first.status_code == 200
    assert first.json()["status"] == "completed"
    assert first.json()["end_time"]
    again = client.post(f"/internal/live/sessions/{mid}/end", json={"user_id": USER}, headers=AUTH)
    assert again.status_code == 200
    assert again.json()["end_time"] == first.json()["end_time"], "end_time must not drift on a retry"


def test_the_agenda_and_its_coverage_merge_onto_the_row(client):
    mid = _start(client).json()["id"]
    agenda = {"items": [{"id": "a1", "text": "Budget", "status": "covered"}], "version": 3}
    r = client.patch(
        f"/internal/live/sessions/{mid}",
        json={"user_id": USER, "data": {"agenda": agenda}},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json()["data"]["agenda"] == agenda
    assert r.json()["data"]["title"] == "Standup", "a patch MERGES; it must not drop the title"


def test_an_oversized_or_malformed_agenda_is_refused(client):
    mid = _start(client).json()["id"]
    bad = {"user_id": USER, "data": {"agenda": {"items": "all of them"}}}
    assert client.patch(f"/internal/live/sessions/{mid}", json=bad, headers=AUTH).status_code == 422
    too_many = {"items": [{"id": f"a{i}", "text": "x"} for i in range(60)]}
    r = client.patch(
        f"/internal/live/sessions/{mid}", json={"user_id": USER, "data": {"agenda": too_many}}, headers=AUTH
    )
    assert r.status_code == 422
    huge = {"user_id": USER, "data": {"title": "x" * 200, "blob": "y" * 70000}}
    assert client.patch(f"/internal/live/sessions/{mid}", json=huge, headers=AUTH).status_code == 413


# ── owner scoping ──────────────────────────────────────────────────────────────────────────────

def test_another_users_session_is_indistinguishable_from_one_that_does_not_exist(client):
    mid = _start(client, user=USER).json()["id"]
    assert client.get(f"/internal/live/sessions/{mid}?user_id={OTHER}", headers=AUTH).status_code == 404
    assert client.post(f"/internal/live/sessions/{mid}/end", json={"user_id": OTHER}, headers=AUTH).status_code == 404
    assert client.patch(
        f"/internal/live/sessions/{mid}", json={"user_id": OTHER, "data": {"title": "mine now"}}, headers=AUTH
    ).status_code == 404


def test_history_lists_only_the_callers_own_calls_newest_first(client):
    _start(client, uid="nx-1", user=USER, title="One")
    _start(client, uid="nx-2", user=USER, title="Two")
    _start(client, uid="nx-3", user=OTHER, title="Theirs")
    r = client.get(f"/internal/live/sessions?user_id={USER}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["platform"] == PLATFORM
    assert [s["data"]["title"] for s in body["sessions"]] == ["Two", "One"]


def test_history_honours_a_limit(client):
    for i in range(5):
        _start(client, uid=f"nx-{i}")
    assert len(client.get(f"/internal/live/sessions?user_id={USER}&limit=2", headers=AUTH).json()["sessions"]) == 2


# ── the one thing the in-memory store cannot catch ─────────────────────────────────────────────

def test_the_sql_adapter_writes_naive_utc_for_the_meeting_timestamps():
    """``meetings.start_time`` / ``end_time`` are TIMESTAMP WITHOUT TIME ZONE while
    ``meeting_sessions.session_start_time`` is timezone-aware. asyncpg refuses an aware datetime
    for the naive column, so the two writes in one INSERT must use different clocks — and the
    in-memory store above, which stores ISO strings, cannot notice. This guards the clock the SQL
    adapter actually uses."""
    from meeting_api.live_sessions.adapters import _utc_naive

    now = _utc_naive()
    assert now.tzinfo is None, "an aware datetime here fails the INSERT (asyncpg DataError)"
