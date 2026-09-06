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
        # No endpoint yet. Say so in the SAME shape a real one answers in, so the assistant's
        # behaviour is identical the day a URL appears.
        return {"status": "accepted", "service": label, "stub": True,
                "message": f"{label} is being executed (stub — no {env_var} configured yet)",
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


def _tool_list() -> list:
    out = []
    for name, (_env, label, arg_help) in TOOLS.items():
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
        if name not in TOOLS:
            return {"jsonrpc": "2.0", "id": mid,
                    "error": {"code": -32601, "message": f"unknown tool {name!r}"}}
        result = _call(name, str(args.get("description") or "").strip())
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": json.dumps(result)}],
            "isError": result.get("status") == "failed",
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
