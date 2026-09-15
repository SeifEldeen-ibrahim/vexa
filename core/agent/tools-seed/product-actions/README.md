# product-actions — the tools the in-meeting assistant uses to ACT

One MCP server over stdio, five products, reached three different ways:

| tool | service | endpoint variable |
| --- | --- | --- |
| `partic_create_pipeline` | Partic (`partic.ai`) | `PARTIC_ENDPOINT` |
| `biami_create_process` | BIAMI (`biami.dev`) | `BIAMI_ENDPOINT` |
| `matrix_agent_prompt` | Matrix (`matrixhq.ai`) | — (renders a line; calls nothing) |
| `contentmorph_transform` | ContentMorph (`contentmorph.ai`) | `CONTENTMORPH_ENDPOINT` |
| `tenx_request` | 10x Factory (`10xfactory.io`) | `TENXFACTORY_ENDPOINT` |

## What it is for

It closes the loop the copilot opens. Someone talks; the copilot — which has no tools and no network,
because it consumes an untrusted transcript — recognises the topic from `agents/products.md` and asks
in the meeting chat *"shall I create a Partic pipeline that does X?"*; a person answers `@nexus yes`;
the chat assistant calls one of these.

## Matrix is a handoff, not a call

Matrix's own chat agent sits in the meeting's Google Chat space, already signed in as the person who
paired it. So `matrix_agent_prompt` calls nothing: it renders the exact line for someone to send to
that agent, and the agent does the work under its own identity.

The human being the executor is what makes this the cheapest of the three paths — no endpoint, no
credential, no write reach, and nothing new to operate. It is also the safest: the assistant reads an
untrusted room, and here it cannot act on what it reads, only phrase it.

What may be rendered is bounded by what that agent actually accepts. Two limits carry most of the
weight, because both are natural to assume and neither is true: **a space cannot be created** (spaces
are listed and selected), and **a task cannot be created directly** — asking for one produces a draft
somebody approves in Matrix. A line outside the vocabulary is refused here rather than handed to
someone who would paste it and watch nothing happen.

`MATRIX_AGENT_HANDLE` sets how the agent is addressed (default `@matrix agent`); the app's display
name is chosen when it is installed into the space.

## What it is NOT

Creating the pipeline, process or task is **not this codebase's job** — the endpoint owns that. Every
tool here does one thing: `POST {"description": "…"}` and report the answer. Pointing a tool at a real
service is setting its endpoint variable on the worker, and nothing else changes.

With no endpoint set, a tool answers in the **same shape** a real one does (`status: accepted`, the
service label, the request echoed, `stub: true`). That is what makes the whole loop demonstrable
before any of the five services has an endpoint to call, and it is why swapping in a URL changes
where the work happens and nothing about what the assistant then says in the meeting.

A tool NEVER raises. A tool that throws inside an agent turn reads to the model as a broken tool
rather than a service that is down, and it will then tell the meeting something confident and wrong;
an unreachable or refusing endpoint comes back as `status: failed` with the reason.

## How it is attached

`product-actions.json` (one directory up) is the `tool.v1` descriptor: `grant: auto`, `transport:
mcp`, and the launch spec for this server. A dispatch names `product-actions` in `unit.v1.tools`; the
worker resolves it through `shared.tools.attach_toolbelt` into `mcp__product-actions` on the
allow-set plus a generated `.mcp.json`. Adding a sixth product is an entry in `TOOLS`, a section in
`agents/products.md`, and no code anywhere else.

There is no SDK dependency: the protocol surface used here is three JSON-RPC methods, and a
dependency inside a sandboxed worker image is a cost with no matching benefit.
