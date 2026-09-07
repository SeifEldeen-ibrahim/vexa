"""The chat assistant's ACTING toolbelt: a tool.v1 descriptor → an MCP attachment on the turn.

The loop is speak → the copilot proposes → someone agrees → the assistant acts. These cover the last
hop: how a name in `unit.v1.tools` becomes a tool the turn can actually call, and how the tool
behaves when the service behind it is missing or broken.

The registry mechanism already existed and was unwired — nothing in production resolved a tool name.
These drive the SHIPPED path (`attach_toolbelt`) over the REAL descriptor in `tools-seed/`, so a
descriptor that stops matching its server is a red here rather than a silent no-op in a meeting.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import contracts
import pytest

from shared.tools import ToolRegistry, attach_toolbelt

_AGENT = pathlib.Path(__file__).resolve().parents[1]
_SEED = _AGENT / "tools-seed"
_SERVER = _SEED / "product-actions" / "server.py"


def _registry() -> ToolRegistry:
    return ToolRegistry.from_dir(_SEED)


# ── the descriptor ────────────────────────────────────────────────────────────────────────

def test_the_shipped_descriptor_is_a_conformant_tool_v1():
    spec = json.loads((_SEED / "product-actions.json").read_text())
    contracts.validate_tool(spec["tool"])


def test_the_descriptor_launches_a_server_that_EXISTS_in_the_image():
    """The launch path is absolute (`/app/...`) because that is where the worker image puts it. If
    the Dockerfile stops copying tools-seed, or the file moves, the tool fails at call time inside a
    meeting — where nobody can see why. Pin the file's repo-relative location instead."""
    spec = json.loads((_SEED / "product-actions.json").read_text())
    launched = pathlib.Path(spec["mcp"]["args"][-1])
    assert launched.name == _SERVER.name
    assert launched.parent.name == "product-actions"
    assert _SERVER.exists(), "the descriptor names a server the repo does not carry"


# ── name → allow-set + .mcp.json ──────────────────────────────────────────────────────────

def test_a_toolbelt_name_becomes_an_mcp_attachment(tmp_path):
    allowed, mcp_config = attach_toolbelt(tmp_path / "belt", ["product-actions"], _registry())
    assert allowed == ["mcp__product-actions"]
    assert mcp_config and json.loads(pathlib.Path(mcp_config).read_text())["mcpServers"]["product-actions"]


def test_builtins_pass_through_and_NOTHING_is_added(tmp_path):
    """The dispatch's list is the whole tool set. A turn dispatched with three read tools must not
    come out of here holding Write — that list is the only thing standing between an untrusted
    question and the owner's workspace."""
    asked = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "product-actions"]
    allowed, _ = attach_toolbelt(tmp_path / "belt", asked, _registry())
    assert allowed == ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "mcp__product-actions"]
    assert "Write" not in allowed and "Edit" not in allowed and "Bash" not in allowed


def test_a_turn_with_no_toolbelt_names_attaches_no_server(tmp_path):
    allowed, mcp_config = attach_toolbelt(tmp_path / "belt", ["Read", "WebSearch"], _registry())
    assert allowed == ["Read", "WebSearch"] and mcp_config is None


def test_a_tool_less_turn_stays_tool_less(tmp_path):
    """`[]` is a caller saying 'no tools' — the meeting copilot's own state."""
    assert attach_toolbelt(tmp_path / "belt", [], _registry()) == ([], None)


def test_the_config_is_written_OUTSIDE_the_workspace(tmp_path):
    """The turn that needs tools is the one whose workspaces are mounted read-only. Writing the
    config into a `:ro` bind fails, and the failure would look like a broken assistant."""
    ws = tmp_path / "ws"
    ws.mkdir()
    belt = tmp_path / "belt"
    _, mcp_config = attach_toolbelt(belt, ["product-actions"], _registry())
    assert mcp_config and pathlib.Path(mcp_config).is_relative_to(belt)
    assert not (ws / ".claude").exists()


def test_an_unknown_name_is_not_silently_granted(tmp_path):
    """An unknown name is a builtin as far as this is concerned — it is passed to the harness, which
    is the component that decides whether it exists. What must NOT happen is it acquiring an MCP
    server it never named."""
    allowed, mcp_config = attach_toolbelt(tmp_path / "belt", ["NotATool"], _registry())
    assert allowed == ["NotATool"] and mcp_config is None


# ── the server itself, over real stdio ────────────────────────────────────────────────────

#: Tests below exercise what a tool DOES. The gating tests set their own env; everything else runs
#: with all products on, because a tool server with nothing enabled correctly offers nothing.
ALL_ON = {"VEXA_SKILL_TOOLS": "partic,biami,matrix,contentmorph,tenx"}


def _rpc(*messages, env=None) -> list:
    import os as _os
    proc = subprocess.run([sys.executable, str(_SERVER)],
                          input="".join(json.dumps(m) + "\n" for m in messages),
                          capture_output=True, text=True, timeout=30,
                          env=env if env is not None else {**_os.environ, **ALL_ON})
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


def _act(tool: str, document: str, env=None) -> dict:
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": tool, "arguments": {"document": document, "name": "t"}}}, env=env)
    return json.loads(out[0]["result"]["content"][0]["text"])


def _call(tool: str, description: str, env=None) -> dict:
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": tool, "arguments": {"description": description}}}, env=env)
    return json.loads(out[0]["result"]["content"][0]["text"])


def test_the_server_advertises_the_five_products():
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    names = {t["name"] for t in out[0]["result"]["tools"]}
    assert {"partic_create_pipeline", "biami_create_process", "matrix_create_task",
            "contentmorph_transform", "tenx_request"} <= names


def test_a_repo_backed_product_can_be_READ_as_well_as_written():
    """The assistant has to know what it is writing against. A product's import gate rejects
    anything non-canonical and its contract is the only statement of what canonical means — without
    a way to look, the model invents connector names and every document is silently refused."""
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    names = {t["name"] for t in out[0]["result"]["tools"]}
    assert {"partic_describe_repo", "biami_describe_repo"} <= names


def test_a_product_with_no_repo_has_nothing_to_describe():
    """Matrix/ContentMorph/10x have no repo contract yet, so there is nothing to read."""
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    names = {t["name"] for t in out[0]["result"]["tools"]}
    assert not {n for n in names if n.startswith(("matrix_desc", "contentmorph_desc", "tenx_desc"))}


def test_every_advertised_tool_takes_exactly_what_it_needs():
    """A repo-backed product is built from a COMPLETE document the model writes; the rest are
    described. The argument shape says which kind a tool is."""
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    for t in out[0]["result"]["tools"]:
        if t["name"].endswith("_describe_repo"):
            assert t["inputSchema"].get("properties") == {}, t["name"]   # reads, takes nothing
            continue
        want = ["document"] if t["name"] in ("partic_create_pipeline", "biami_create_process") \
            else ["description"]
        assert t["inputSchema"]["required"] == want, t["name"]


def test_a_repo_backed_tool_never_offers_a_free_text_shortcut():
    """It must not accept a `description` as an alternative to the document. A product's import gate
    rejects anything non-canonical, so half a document is a rejection nobody in the meeting sees."""
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    partic = next(t for t in out[0]["result"]["tools"] if t["name"] == "partic_create_pipeline")
    assert "description" not in partic["inputSchema"]["properties"]


def test_a_product_with_no_endpoint_says_UNAVAILABLE_never_accepted():
    """This used to answer `accepted` with "is being executed" — which the assistant turns into
    "it's happening" in front of a customer, for a thing that will never happen. A product this
    deployment cannot reach must not read as success."""
    got = _call("matrix_create_task", "pull the Q3 churn breakdown")
    assert got["status"] == "unavailable"
    assert "nothing was created" in got["message"].lower()
    assert "executed" not in got["message"].lower()


def test_a_repo_backed_tool_with_no_control_plane_reach_also_refuses_honestly():
    """Same rule on the other path: no grant, no write, and it says so."""
    got = _act("partic_create_pipeline", "{}")
    assert got["status"] == "unavailable" and "nothing was created" in got["message"].lower()


def test_an_unreachable_endpoint_REPORTS_failure_rather_than_raising(monkeypatch):
    """A tool that throws inside a turn reads to the model as a broken tool rather than a service
    that is down — and it will then tell the meeting something confident and wrong."""
    import os
    env = dict(os.environ, **ALL_ON, MATRIX_ENDPOINT="http://127.0.0.1:9/never")
    got = _call("matrix_create_task", "anything", env=env)
    assert got["status"] == "failed" and "could not reach" in got["message"]


def test_an_unreachable_CONTROL_PLANE_refuses_rather_than_guessing():
    """It cannot confirm what this meeting allows, so it does not act — and says so without
    raising. Refusing is the right answer here rather than attempting the write: a turn that cannot
    read its own permissions has no business exercising them."""
    import os
    env = dict(os.environ, VEXA_SKILL_ACT_URL="http://127.0.0.1:9/never", VEXA_SKILL_GRANT="g")
    got = _act("partic_create_pipeline", "{}", env=env)
    assert got["status"] == "unavailable"


def test_an_unreachable_control_plane_also_advertises_NOTHING():
    """A menu we cannot confirm must not name products the owner may not have granted."""
    import os
    env = dict(os.environ, VEXA_SKILL_ACT_URL="http://127.0.0.1:9/never", VEXA_SKILL_GRANT="g")
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, env=env)
    assert out[0]["result"]["tools"] == []


def test_a_turn_only_sees_the_tools_its_meeting_ENABLED():
    """The per-product switch has to be real at the tool boundary. A `tool.v1` grant attaches a
    whole MCP server, so the allow-list cannot express "this server, but only two of its five
    tools" — listing is where that narrowing can happen."""
    import os
    env = dict(os.environ, VEXA_SKILL_TOOLS="partic")
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, env=env)
    assert sorted(t["name"] for t in out[0]["result"]["tools"]) == \
        ["partic_create_pipeline", "partic_describe_repo"]


def test_calling_a_tool_the_meeting_did_not_enable_is_refused():
    """Listing is not a control on its own — a model can name a tool it was never shown."""
    import os
    env = dict(os.environ, VEXA_SKILL_TOOLS="partic")
    got = _call("matrix_create_task", "anything", env=env)
    assert got["status"] == "unavailable" and "turned on for this meeting" in got["message"]


def test_an_unknown_tool_is_an_error_not_a_silent_success():
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "delete_production", "arguments": {}}})
    assert out[0]["error"]["code"] == -32601


def test_a_malformed_frame_does_not_kill_the_server():
    proc = subprocess.run([sys.executable, str(_SERVER)],
                          input='not json\n{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n',
                          capture_output=True, text=True, timeout=30)
    assert json.loads(proc.stdout.splitlines()[0])["id"] == 7


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


# ── what an in-meeting turn is actually granted ───────────────────────────────────────────

def test_both_scopes_can_act_on_an_agreed_proposal():
    """Acting is not a question of how much history may be read. A transcript-scoped meeting is the
    ordinary case — the copilot proposed something out loud and the owner said yes — and refusing to
    act there would make the whole loop depend on a workspace grant nobody was asked for."""
    from control_plane.meeting_chat_responder import meet_chat_tools

    assert "product-actions" in meet_chat_tools("transcript")
    assert "product-actions" in meet_chat_tools("workspace")


def test_neither_scope_can_CHANGE_anything_in_the_workspace():
    """The question comes from a room the owner does not control."""
    from control_plane.meeting_chat_responder import meet_chat_tools

    for granted in (meet_chat_tools("transcript"), meet_chat_tools("workspace")):
        assert not ({"Write", "Edit", "Bash", "NotebookEdit"} & set(granted))


def test_every_granted_name_is_either_a_builtin_or_a_REAL_descriptor(tmp_path):
    """A granted name the registry cannot resolve becomes a bare string handed to the harness — the
    turn then reports success and simply cannot do the thing. Anything hyphenated is a toolbelt
    name by convention; it must exist in tools-seed."""
    from control_plane.meeting_chat_responder import meet_chat_tools
    known = set(_registry().names())
    for name in meet_chat_tools("workspace"):
        assert name in known or name.isalnum(), f"{name!r} resolves to nothing"


def test_the_workspace_grant_resolves_end_to_end(tmp_path):
    from control_plane.meeting_chat_responder import meet_chat_tools

    granted = meet_chat_tools("workspace")
    allowed, mcp_config = attach_toolbelt(tmp_path / "belt", granted, _registry())
    assert "mcp__product-actions" in allowed and mcp_config


# ── a meeting with nothing enabled must see NOTHING ───────────────────────────────────────

def test_no_skills_enabled_advertises_NO_product_tools():
    """The bug this replaces, reported verbatim from a live meeting with nothing turned on:
    "Partic, BIAMI, ContentMorph, Matrix, and 10x Factory are all wired up here."

    A tool list is prompt-visible. `if ENABLED and skill not in ENABLED` read an empty list as
    "no filter" rather than as "nothing", so every product's tool — and its description — reached a
    model whose owner had granted none of them. The knowledge leaked through the capability surface
    while the prompt was correctly empty."""
    import os
    env = {k: v for k, v in os.environ.items() if not k.startswith("VEXA_SKILL")}
    out = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, env=env)
    assert out[0]["result"]["tools"] == []


def test_no_skills_enabled_refuses_every_product_CALL_too():
    """Listing is not the only surface — a model can name a tool it was never shown."""
    import os
    env = {k: v for k, v in os.environ.items() if not k.startswith("VEXA_SKILL")}
    for tool in ("partic_create_pipeline", "matrix_create_task"):
        got = _call(tool, "anything", env=env)
        assert got["status"] == "unavailable", tool


def test_the_toolbelt_is_attached_and_decides_LIVE():
    """The belt is always attached and the server asks what its meeting allows, because a worker
    serves a whole meeting and its env is frozen at container creation — deciding here, once, would
    answer with whatever was enabled when the first message arrived, so enabling a product
    mid-meeting did nothing until the worker was reaped."""
    from control_plane.meeting_chat_responder import meet_chat_tools

    assert "product-actions" in meet_chat_tools("transcript")
    assert "product-actions" in meet_chat_tools("workspace")


def test_both_scopes_still_act_and_differ_only_by_history():
    """The rule that must survive this fix: transcript-vs-workspace is about how much MEETING
    history is in reach, and BOTH can build."""
    from control_plane.meeting_chat_responder import meet_chat_tools

    t, w = meet_chat_tools("transcript"), meet_chat_tools("workspace")
    assert "product-actions" in t and "product-actions" in w
    assert set(w) - set(t) == {"Read", "Glob", "Grep"}
