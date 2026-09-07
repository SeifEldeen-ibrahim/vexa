#!/usr/bin/env python3
"""product-actions — the tools the in-meeting assistant uses to ACT on a copilot suggestion.

The loop this closes: someone talks, the copilot recognises the topic and asks "shall I create a
Partic pipeline that does X?", the person answers "@vexa yes", and the assistant calls one of these.

Each tool is an HTTP POST and nothing else. Creating the thing is not this codebase's job — the
endpoint owns that. Point a tool at its real service by setting its endpoint variable; with none set
it reports that it would have called, which is what makes the whole loop demonstrable before any of
the five services has an endpoint to call.

The stub answer is deliberately shaped like the real one (same JSON, same fields), so swapping in a
URL changes where the work happens and nothing about what the assistant does with the answer.

Speaks MCP over stdio: one JSON-RPC message per line on stdin, one per line on stdout. No SDK — the
protocol surface used here is three methods, and a dependency in a sandboxed worker image is a cost
with no matching benefit.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

#: Where the control plane accepts a write, and this turn's grant. Both are stamped by dispatch.
#: The GitHub token is deliberately NOT here: the harness passes its whole environment to the CLI
#: and to this server, and an ordinary chat turn has Bash — a token here is a token the model can
#: print. The control plane holds it and does the git work.
ACT_URL = (os.environ.get("VEXA_SKILL_ACT_URL") or "").strip()
DESCRIBE_URL = ACT_URL.replace("/act", "/describe") if ACT_URL else ""
ACT_GRANT = (os.environ.get("VEXA_SKILL_GRANT") or "").strip()

#: Which products this turn may act on. FAIL CLOSED: absent means NONE, never "all".
#:
#: It was the other way round, and the tool list is prompt-visible — so a meeting with nothing
#: enabled advertised all five tools, the model read its own menu, and told the room "Partic, BIAMI,
#: ContentMorph, Matrix and 10x Factory are all wired up here". That is precisely the property the
#: whole feature exists to provide, defeated by a truthiness check: an empty list read as "no
#: filter" rather than as "nothing".
#:
#: A turn cannot use these without a grant anyway, so refusing when none is named costs nothing.
ENABLED = [s.strip() for s in (os.environ.get("VEXA_SKILL_TOOLS") or "").split(",") if s.strip()]

#: tool name → the skill it READS for. A repo-backed product's import gate rejects anything
#: non-canonical, and its contract and connector list are the only statement of what canonical
#: means — so the model has to be able to look, not just write.
DESCRIBE_SKILL = {
    "partic_describe_repo": "partic",
    "biami_describe_repo": "biami",
}

#: tool name → the skill it acts for. Repo-backed skills write a document; the rest report.
TOOL_SKILL = {
    "partic_create_pipeline": "partic",
    "biami_create_process": "biami",
    "matrix_create_task": "matrix",
    "contentmorph_transform": "contentmorph",
    "tenx_request": "tenx",
}
REPO_BACKED = {"partic", "biami"}

#: tool name → (env var holding its endpoint, human label, the argument it takes)
TOOLS = {
    "partic_create_pipeline": (
        "PARTIC_ENDPOINT", "Partic pipeline",
        "What the pipeline should move, and between which systems.",
    ),
    "biami_create_process": (
        "BIAMI_ENDPOINT", "BIAMI process",
        "The business process to automate, in the words it was described in.",
    ),
    "matrix_create_task": (
        "MATRIX_ENDPOINT", "Matrix task",
        "The task or plan for Matrix to execute, and against which data.",
    ),
    "contentmorph_transform": (
        "CONTENTMORPH_ENDPOINT", "ContentMorph transform",
        "The source content and the channels it should be adapted for.",
    ),
    "tenx_request": (
        "TENXFACTORY_ENDPOINT", "10x Factory request",
        "The delivery ask: scope, and the date or cadence it is wanted on.",
    ),
}

TIMEOUT_SEC = 15


def _call(tool: str, description: str) -> dict:
    """POST the description to the tool's endpoint. Never raises — a tool that throws inside an agent
    turn reads to the model as a broken tool rather than a service that is down, and it will then
    tell the meeting something confident and wrong."""
    env_var, label, _ = TOOLS[tool]
    url = (os.environ.get(env_var) or "").strip()
    if not url:
        # No endpoint, and no repo contract for this product yet. It must NOT read as success:
        # `accepted` plus "is being executed" is what the assistant turns into "it's happening" in
        # front of a customer, for a thing that will never happen.
        return {"status": "unavailable", "service": label,
                "message": f"{label} isn't connected to this deployment yet — I've noted what you "
                           f"wanted, but nothing was created.",
                "request": description}
    body = json.dumps({"description": description}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            raw = resp.read().decode() or "{}"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw[:500]}
        return {"status": "accepted", "service": label, "stub": False, "response": payload}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:300]
        except Exception:  # noqa: BLE001
            pass
        return {"status": "failed", "service": label,
                "message": f"{label} refused the request ({e.code}): {detail}"}
    except Exception as e:  # noqa: BLE001
        return {"status": "failed", "service": label,
                "message": f"could not reach {label}: {e}"}


def _act(skill: str, document: str, name: str) -> dict:
    """Ask the control plane to write this document into the owner's pinned repo.

    All of the work — the token, the clone, the validation, the commit, the push — is on the other
    side of this call. What happens here is one POST and one fixed vocabulary of outcomes, because
    git's own error text carries the remote URL and, on a failed auth, the credential; a message
    from here is read aloud in a room the owner does not control."""
    if not ACT_URL or not ACT_GRANT:
        return {"status": "unavailable",
                "message": "I can't write to a repo from this meeting — nothing was created."}
    body = json.dumps({"grant": ACT_GRANT, "skill": skill, "document": document,
                       "name": name}).encode()
    req = urllib.request.Request(ACT_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return {"status": "unavailable",
                    "message": "This turn is no longer allowed to write — nothing was created."}
        return {"status": "failed",
                "message": "I couldn't write that just now. Nothing was changed."}
    except Exception:  # noqa: BLE001 — never raise: a throwing tool reads as broken to the model,
        return {"status": "failed",          # and it then tells the meeting something confident
                "message": "I couldn't reach the repo service. Nothing was changed."}
    return payload


def _describe(skill: str) -> dict:
    """Ask the control plane what this product's repo looks like."""
    if not DESCRIBE_URL or not ACT_GRANT:
        return {"status": "unavailable",
                "message": "I can't read that product's repo from this meeting."}
    body = json.dumps({"grant": ACT_GRANT, "skill": skill}).encode()
    req = urllib.request.Request(DESCRIBE_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode() or "{}")
    except Exception:  # noqa: BLE001 — never raise inside a turn
        return {"status": "failed", "message": "I couldn't read that product's repo just now."}


def _tool_list() -> list:
    """The tools this turn may call — narrowed to the products the meeting enabled.

    Narrowed HERE, not in the allow-list: a `tool.v1` grant attaches a whole MCP server, so the
    allow-list cannot express "this server, but only two of its five tools". Listing only the
    enabled ones is what makes the per-product switch real at the tool boundary."""
    out = []
    for name, skill in DESCRIBE_SKILL.items():
        if skill not in ENABLED:
            continue
        label = next(l for t, (_e, l, _a) in TOOLS.items() if TOOL_SKILL.get(t) == skill)
        out.append({
            "name": name,
            "description": f"Read the owner's {label} repo: its authoring contract, its real "
                           f"connectors or script vocabulary, and what already exists. Call this "
                           f"BEFORE writing one — the import gate rejects anything that does not "
                           f"already match, and invented names are the usual reason.",
            "inputSchema": {"type": "object", "properties": {}},
        })
    for name, (_env, label, arg_help) in TOOLS.items():
        if name in DESCRIBE_SKILL:
            d_skill = DESCRIBE_SKILL[name]
            result = ({"status": "unavailable",
                       "message": "That product isn't turned on for this meeting."}
                      if d_skill not in ENABLED else _describe(d_skill))
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}],
                "isError": result.get("status") in ("failed", "invalid"),
            }}
        skill = TOOL_SKILL.get(name, "")
        if skill not in ENABLED:
            continue
        if skill in REPO_BACKED:
            out.append({
                "name": name,
                "description": f"Write a {label} into the owner's repo and push it. Call this ONLY "
                               f"after the meeting owner has agreed. You supply the COMPLETE "
                               f"document; read the repo's authoring contract first if you have it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "document": {"type": "string", "description":
                                     "The complete document, in the product's own format."},
                        "name": {"type": "string", "description":
                                 "A short name for it, used as the file name."},
                    },
                    "required": ["document"],
                },
            })
            continue
        out.append({
            "name": name,
            "description": f"Create a {label} from a description given in the meeting. "
                           f"Call this ONLY after the meeting owner has agreed to it.",
            "inputSchema": {
                "type": "object",
                "properties": {"description": {"type": "string", "description": arg_help}},
                "required": ["description"],
            },
        })
    return out


def _handle(msg: dict) -> "dict | None":
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "product-actions", "version": "0.1.0"},
        }}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": _tool_list()}}
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name not in TOOLS and name not in DESCRIBE_SKILL:
            return {"jsonrpc": "2.0", "id": mid,
                    "error": {"code": -32601, "message": f"unknown tool {name!r}"}}
        skill = TOOL_SKILL.get(name, "")
        if skill not in ENABLED:
            result = {"status": "unavailable",
                      "message": f"{TOOLS[name][1]} isn't turned on for this meeting."}
        elif skill in REPO_BACKED:
            result = _act(skill, str(args.get("document") or ""), str(args.get("name") or ""))
        else:
            result = _call(name, str(args.get("description") or "").strip())
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": json.dumps(result)}],
            "isError": result.get("status") in ("failed", "invalid"),
        }}
    if mid is None:
        return None                       # a notification; nothing to answer
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"unknown method {method!r}"}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue                      # a malformed frame is dropped, never fatal
        reply = _handle(msg)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
