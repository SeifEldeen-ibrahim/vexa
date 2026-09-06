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
