"""The dispatch's tool list, as the WORKER actually resolves it.

A tool that is granted in `unit.v1` and never attached in the container is the worst kind of bug:
every layer reports success and the assistant simply cannot do the thing. This drives the shipped
container entrypoint (`worker.engine.main`) with the exact env agent-api stamps, and asserts on what
reaches the turn.
"""
from __future__ import annotations

import json
import pathlib
import sys
import types

import pytest

import worker.engine as engine

_SEED = str(pathlib.Path(__file__).resolve().parents[1] / "tools-seed")


class _FakeRedis:
    def __init__(self, *a, **kw):
        pass

    @staticmethod
    def from_url(*a, **kw):
        return _FakeRedis()


def _run_chat_worker(monkeypatch, tmp_path, tools: str) -> dict:
    """Boot the worker's chat branch and capture the turn it would run."""
    monkeypatch.setitem(sys.modules, "redis", types.SimpleNamespace(from_url=_FakeRedis.from_url))
    for k, v in {
        "REDIS_URL": "redis://x", "VEXA_UNIT_OUT_TOPIC": "unit:1:out", "VEXA_UNIT_IN_TOPIC": "unit:1:in",
        "VEXA_WORKSPACE_PATH": str(tmp_path / "ws"), "VEXA_CHAT_TOOLS": tools,
        "VEXA_TOOLS_SEED_DIR": _SEED, "VEXA_TOOLBELT_DIR": str(tmp_path / "belt"),
        "VEXA_START": "{}",
    }.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("VEXA_TRANSCRIPT_STREAM", raising=False)

    captured: dict = {}

    def fake_turn(work, prompt, **kw):
        captured.update(kw)
        return iter(())

    def fake_serve(client, *, out_topic, in_topic, turn, start, idle_ms):
        turn("anything")          # drive ONE turn, exactly as a chat message would

    monkeypatch.setattr(engine, "run_turn_over_workspace", fake_turn)
    monkeypatch.setattr(engine, "serve", fake_serve)
    monkeypatch.setattr(engine, "preflight_provider_guard", lambda: None)
    engine.main()
    return captured


def test_a_granted_toolbelt_name_reaches_the_turn_as_an_mcp_attachment(monkeypatch, tmp_path):
    """The whole point: agent-api grants `product-actions` in `unit.v1.tools`, dispatch stamps it
    into VEXA_CHAT_TOOLS, and the turn comes out holding an MCP server it can actually call."""
    got = _run_chat_worker(monkeypatch, tmp_path, "Read,Glob,Grep,WebSearch,WebFetch,product-actions")
    assert "mcp__product-actions" in got["allowed_tools"]
    assert got["mcp_config"], "the turn was granted a tool with no server attached"
    servers = json.loads(pathlib.Path(got["mcp_config"]).read_text())["mcpServers"]
    assert "product-actions" in servers


def test_the_builtin_grant_survives_alongside_it(monkeypatch, tmp_path):
    got = _run_chat_worker(monkeypatch, tmp_path, "Read,Glob,Grep,WebSearch,WebFetch,product-actions")
    assert [t for t in got["allowed_tools"] if not t.startswith("mcp__")] == \
        ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
    assert "Write" not in got["allowed_tools"] and "Bash" not in got["allowed_tools"]


def test_a_turn_that_was_granted_no_toolbelt_attaches_no_server(monkeypatch, tmp_path):
    got = _run_chat_worker(monkeypatch, tmp_path, "WebSearch,WebFetch")
    assert got["allowed_tools"] == ["WebSearch", "WebFetch"] and got["mcp_config"] is None


def test_a_tool_less_turn_stays_tool_less(monkeypatch, tmp_path):
    got = _run_chat_worker(monkeypatch, tmp_path, "none")
    assert got["allowed_tools"] == [] and got["mcp_config"] is None


def test_the_config_is_not_written_into_the_workspace(monkeypatch, tmp_path):
    """The meet-chat turn mounts its workspaces `:ro`. A config written there fails the turn."""
    got = _run_chat_worker(monkeypatch, tmp_path, "Read,product-actions")
    assert pathlib.Path(got["mcp_config"]).is_relative_to(tmp_path / "belt")
    assert not (tmp_path / "ws" / ".claude").exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


# ── the copilot's suggestion sink, as the container entrypoint builds it ───────────────────

def _run_meeting_worker(monkeypatch, tmp_path) -> dict:
    """Boot the worker's MEETING branch and capture the callbacks it hands `serve_meeting`."""
    import worker.meeting as meeting

    added: list = []

    class _Redis:
        def xadd(self, stream, fields):
            added.append((stream, fields))

        def __getattr__(self, _name):        # every other redis call is a no-op here
            return lambda *a, **kw: None

    monkeypatch.setitem(sys.modules, "redis", types.SimpleNamespace(from_url=lambda *a, **kw: _Redis()))
    for k, v in {
        "REDIS_URL": "redis://x", "VEXA_UNIT_OUT_TOPIC": "unit:1:out", "VEXA_UNIT_IN_TOPIC": "unit:1:in",
        "VEXA_WORKSPACE_PATH": str(tmp_path / "ws"), "VEXA_TRANSCRIPT_STREAM": "tc:meeting:36",
        "VEXA_MEETING_NUMERIC_ID": "36", "VEXA_MEETING_ID": "svf-ddio-udq",
        "VEXA_MEETING_SESSION_UID": "36", "VEXA_MEETING_PLATFORM": "google_meet",
        "VEXA_START": "{}",
    }.items():
        monkeypatch.setenv(k, v)

    captured: dict = {}
    monkeypatch.setattr(meeting, "serve_meeting", lambda *a, **kw: captured.update(kw))
    monkeypatch.setattr(engine, "preflight_provider_guard", lambda: None)
    engine.main()
    return {"kwargs": captured, "added": added}


def test_a_suggestion_card_REACHES_the_stream():
    """The sink is a lambda built in the container entrypoint, and a name that does not exist in
    that scope raises only when a real meeting produces a real suggestion — where it is swallowed as
    "suggestion sink rejected a card" and the proposal is silently lost. Call it here instead."""
    import pytest as _pytest

    mp = _pytest.MonkeyPatch()
    try:
        import tempfile

        got = _run_meeting_worker(mp, pathlib.Path(tempfile.mkdtemp()))
        got["kwargs"]["on_suggestion"]({"kind": "suggestion", "title": "Partic pipeline",
                                        "body": "Shall I create a Partic pipeline?"})
    finally:
        mp.undo()

    assert len(got["added"]) == 1
    stream, fields = got["added"][0]
    assert stream == "meet_suggestions"
    payload = json.loads(fields["payload"])
    assert payload["native_id"] == "svf-ddio-udq" and payload["platform"] == "google_meet"
    assert payload["title"] == "Partic pipeline" and payload["body"] == "Shall I create a Partic pipeline?"
