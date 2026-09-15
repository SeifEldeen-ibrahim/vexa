#!/usr/bin/env python3
"""product-actions — the tools the in-meeting assistant uses to ACT on a copilot suggestion.

The loop this closes: someone talks, the copilot recognises the topic and asks "shall I create a
Partic pipeline that does X?", the person answers "@nexus yes", and the assistant calls one of these.

Three kinds of tool, because the products are reached in three different ways:

  REPO      Partic and BIAMI read from a git repo, so authoring is a commit. The tool hands a
            complete document to the control plane, which owns the token and the push.
  ENDPOINT  an HTTP POST and nothing else. Creating the thing is not this codebase's job — the
            endpoint owns that. Point a tool at its real service by setting its endpoint variable.
  HANDOFF   Matrix is reached through its own chat agent, which is already in the room and already
            authenticated as the person. The tool calls nothing: it renders the exact line for
            someone to send to that agent. The human is the executor, which is why this path needs
            no endpoint, no credential and no write reach of its own.

The stub answer is deliberately shaped like the real one (same JSON, same fields), so swapping in a
URL changes where the work happens and nothing about what the assistant does with the answer.

Speaks MCP over stdio: one JSON-RPC message per line on stdin, one per line on stdout. No SDK — the
protocol surface used here is three methods, and a dependency in a sandboxed worker image is a cost
with no matching benefit.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

#: Where the control plane accepts a write, and this turn's grant. Both are stamped by dispatch.
#: The GitHub token is deliberately NOT here: the harness passes its whole environment to the CLI
#: and to this server, and an ordinary chat turn has Bash — a token here is a token the model can
#: print. The control plane holds it and does the git work.
ACT_URL = (os.environ.get("VEXA_SKILL_ACT_URL") or "").strip()
DESCRIBE_URL = ACT_URL.replace("/act", "/describe") if ACT_URL else ""
ENABLED_URL = ACT_URL.replace("/act", "/enabled") if ACT_URL else ""
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
def _enabled_now() -> list:
    """Which products this meeting currently allows.

    ASKED, not read from the environment. A worker serves a whole meeting and its env is frozen at
    container creation — a create for a running workload is a TOUCH that discards the spec — so an
    env-read menu reflects whatever was enabled when the first message arrived. Enabling a product
    mid-meeting then changed nothing until the worker was reaped, which is exactly what happened.

    This process is started fresh for each turn, so asking here is asking now. Any failure is NONE:
    a menu we cannot confirm must not name products the owner may not have granted."""
    if not ENABLED_URL or not ACT_GRANT:
        # No control plane to ask — the local answer. Production always stamps both, so this is the
        # offline/dev path; dispatch no longer sets this variable at all, which means production
        # falls through to an empty list rather than to "everything".
        return [s.strip() for s in (os.environ.get("VEXA_SKILL_TOOLS") or "").split(",") if s.strip()]
    body = json.dumps({"grant": ACT_GRANT}).encode()
    req = urllib.request.Request(ENABLED_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode() or "{}")
    except Exception:  # noqa: BLE001
        return []
    got = payload.get("enabled")
    return [str(x) for x in got] if isinstance(got, list) else []

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
    "matrix_agent_prompt": "matrix",
    "contentmorph_transform": "contentmorph",
    "tenx_request": "tenx",
}
REPO_BACKED = {"partic", "biami"}
#: Tools that render a line for a person to relay, rather than calling anything.
HANDOFF = {"matrix_agent_prompt"}

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
    "matrix_agent_prompt": (
        "", "Matrix",
        "What was asked for, in the words the meeting used.",
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


#: How the Matrix agent is addressed in the room. The app's display name is chosen per deployment
#: when it is installed into the space, so the handle is configuration rather than a constant.
MATRIX_HANDLE = (os.environ.get("MATRIX_AGENT_HANDLE") or "@matrix agent").strip()

#: Google Meet's composer refuses anything past 500 characters and the assistant's replies are
#: chunked below that. A line someone has to copy as ONE message must fit in one, so a request that
#: would not fit is refused here with the cap named rather than split into two halves that are
#: useless apart.
MAX_PROMPT_CHARS = 400

#: What the Matrix agent can actually be told to do — its own typed vocabulary, written the way a
#: person would say it.
#:
#: Everything outside this map is something the agent will not do, and a line it cannot act on is
#: worse than no line at all: the person pastes it, nothing happens, and they conclude the whole
#: integration is broken. Two absences drive most of the map's shape, because both are natural to
#: assume and neither is true — a space can be listed and selected but never CREATED, and a task is
#: never created directly: asking for one produces a draft that somebody approves in Matrix.
#:
#: action → (how it is said, whether it needs their words, what to expect afterwards)
MATRIX_ACTIONS = {
    "create_chat": ('create a chat called "{d}"', True,
                    "Matrix opens the chat."),
    "ask": ("{d}", True,
            "Matrix answers in the chat it currently has selected."),
    "task": ("create a task to {d}", True,
             "Matrix drafts the task and someone approves the draft there — the draft alone runs "
             "nothing."),
    "schedule": ("schedule {d}", True,
                 "Matrix drafts a schedule for someone to approve."),
    "task_status": ("what is the status of {d}", True,
                    "Matrix reports where that task stands."),
    "list_tasks": ("list my tasks", False,
                   "Matrix lists the tasks it can see."),
    "list_spaces": ("list spaces", False,
                    "Matrix lists the spaces the person can reach."),
    "select_space": ('switch to the "{d}" space', True,
                     "Matrix moves its context there; later lines act inside it."),
    "find_chat": ('search chats for "{d}"', True,
                  "Matrix lists the chats that match."),
}

#: Handles that address a ROOM rather than the agent. Their words are relayed verbatim into a chat
#: where handles are live, so one arriving inside a description must not become a page sent to every
#: member by something nobody in the meeting typed.
#:
#: Only the leading ``@`` is dropped — the word itself is usually part of the sentence ("tell
#: everyone the date"), and removing it would change what was asked for. The trailing boundary is
#: what keeps this from reaching into a real value: without it ``@all`` matches inside
#: ``bob@allstate.com`` and quietly rewrites an address somebody has to read.
_BROADCAST_RE = re.compile(r"@(everyone|here|all|channel|space)\b", re.IGNORECASE)


def _one_line(text: str) -> str:
    """Their words, reduced to something that survives being copied as a single message."""
    # Anything unprintable BECOMES a space rather than being dropped: a line break between two
    # words is a word boundary, and deleting it welds them into one that nobody said.
    cleaned = "".join(ch if ch == " " or ch.isprintable() else " " for ch in (text or ""))
    cleaned = _BROADCAST_RE.sub(r"\1", cleaned)
    return " ".join(cleaned.split()).strip(" \"'")


def _handoff(detail: str, action: str) -> dict:
    """Render the line someone sends to the Matrix agent. Calls nothing and creates nothing.

    The whole value is that the line is TRUE — an instruction the agent accepts, carrying the words
    the meeting actually used. So every refusal here names what to do instead, because the model is
    about to say something to a room either way."""
    spec = MATRIX_ACTIONS.get(action)
    if spec is None:
        return {"status": "invalid", "service": "Matrix",
                "message": f"Matrix has no {action!r} action. It can do: "
                           f"{', '.join(sorted(MATRIX_ACTIONS))}. There is no way to create a "
                           f"space, and a task is reached with 'task' — Matrix drafts it.",
                "actions": sorted(MATRIX_ACTIONS)}
    template, needs_detail, note = spec
    detail = _one_line(detail)
    if needs_detail and not detail:
        return {"status": "invalid", "service": "Matrix",
                "message": f"'{action}' needs what was asked for, in the meeting's own words."}
    prompt = f"{MATRIX_HANDLE} {template.format(d=detail)}".strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        return {"status": "invalid", "service": "Matrix",
                "message": f"That line is {len(prompt)} characters and has to be copied as one "
                           f"message, so it has to fit in {MAX_PROMPT_CHARS}. Say the same thing "
                           f"shorter — the agent can be asked for the detail afterwards."}
    return {"status": "ready", "service": "Matrix", "prompt": prompt,
            "mention": MATRIX_HANDLE, "instruction": template.format(d=detail), "note": note,
            "message": "Nothing was created. Post `prompt` into the meeting chat exactly as it is, "
                       "for someone to send to the Matrix agent."}


def _tool_list(enabled: "list | None" = None) -> list:
    """The tools this turn may call — narrowed to the products the meeting enabled.

    Narrowed HERE, not in the allow-list: a `tool.v1` grant attaches a whole MCP server, so the
    allow-list cannot express "this server, but only two of its five tools". Listing only the
    enabled ones is what makes the per-product switch real at the tool boundary."""
    ENABLED = _enabled_now() if enabled is None else enabled
    out = []
    for name, skill in DESCRIBE_SKILL.items():
        if skill not in ENABLED:
            continue
        label = next(l for t, (_e, l, _a) in TOOLS.items() if TOOL_SKILL.get(t) == skill)
        out.append({
            "name": name,
            "description": f"Read this meeting's {label} repo: its authoring contract, its real "
                           f"connectors or script vocabulary, and what already exists. "
                           f"SAFE AND EXPECTED — it reads nothing but the product's own setup, "
                           f"which the meeting owner enabled for this meeting, and changes nothing. "
                           f"Use it freely to answer any question about {label}, and ALWAYS before "
                           f"writing: the import gate rejects anything that does not already match, "
                           f"and invented names are the usual reason. Only the create tool needs "
                           f"someone's agreement first.",
            "inputSchema": {"type": "object", "properties": {}},
        })
    for name, (_env, label, arg_help) in TOOLS.items():
        skill = TOOL_SKILL.get(name, "")
        if skill not in ENABLED:
            continue
        if name in HANDOFF:
            out.append({
                "name": name,
                "description": f"Write the line someone sends to the {label} agent in this "
                               f"meeting's chat. It CREATES NOTHING and calls nothing — {label} "
                               f"acts when a person relays the line. Call this ONLY after someone "
                               f"has agreed, then post the `prompt` it returns into the chat "
                               f"exactly as it comes back, on its own, so it can be copied.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": sorted(MATRIX_ACTIONS),
                                   "description":
                                       "What the agent is being asked to do. This list is "
                                       "everything it can do: it cannot create a space, and "
                                       "'task' asks for a task that it DRAFTS for approval."},
                        "detail": {"type": "string", "description": arg_help},
                    },
                    "required": ["action"],
                },
            })
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
        enabled = _enabled_now()
        # The READ tools first: they are not in TOOLS, and the generic path below indexes TOOLS by
        # name. Falling through raised a KeyError, which killed the server mid-call — the model saw
        # only "MCP error -32000: Connection closed" and told the meeting the integration was
        # flapping, which was a true description of the symptom and no help at all.
        if name in DESCRIBE_SKILL:
            d_skill = DESCRIBE_SKILL[name]
            result = ({"status": "unavailable",
                       "message": "That product isn't turned on for this meeting."}
                      if d_skill not in enabled else _describe(d_skill))
            return {"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}],
                "isError": result.get("status") in ("failed", "invalid"),
            }}
        skill = TOOL_SKILL.get(name, "")
        if skill not in enabled:
            result = {"status": "unavailable",
                      "message": f"{TOOLS[name][1]} isn't turned on for this meeting."}
        elif name in HANDOFF:
            result = _handoff(str(args.get("detail") or ""), str(args.get("action") or "").strip())
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
        try:
            reply = _handle(msg)
        except Exception as e:  # noqa: BLE001
            # A fault handling ONE call must not end the server. It did: a KeyError on an unlisted
            # tool name killed the process mid-call, and all the model ever saw was
            # "MCP error -32000: Connection closed" — so it told the meeting the integration was
            # flapping, which described the symptom perfectly and pointed nowhere near the cause.
            # An error frame keeps the session alive and says which call failed.
            reply = {"jsonrpc": "2.0", "id": msg.get("id"),
                     "error": {"code": -32603, "message": f"{type(e).__name__}: {e}"[:200]}}
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
