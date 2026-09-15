"""Every host port the compose file publishes is PINNED by the gate's own stack (offline).

The gate boots a second, whole stack on a machine that usually already runs one. A published port
variable the gate does not pin falls through to `deploy/compose/.env` — the developer's live stack —
and compose then tries to bind a port that is already taken, which fails the whole gate with
"port is already allocated" and no hint of which service escaped.

That is not hypothetical: `flows-api` (`FLOWS_API_HOST_PORT`, :18200) and the dashboard
(`DASHBOARD_PORT`, :13001) were both added to the compose file after the gate's env was written,
and neither was pinned — so `gate:compose` could not run beside a v0.12 deployment at all. The
conftest comment already stated the rule; nothing enforced it. This test does.
"""
from __future__ import annotations

import re
from pathlib import Path

import conftest

COMPOSE = Path(__file__).resolve().parents[3] / "deploy" / "compose" / "docker-compose.yml"

#: `- "127.0.0.1:${VAR:-default}:container"` — the only shape this compose publishes with.
_PUBLISHED = re.compile(r'127\.0\.0\.1:\$\{([A-Z0-9_]+):-\d+\}:\d+')


def test_every_published_host_port_is_pinned_by_the_gates_env():
    published = set(_PUBLISHED.findall(COMPOSE.read_text()))
    assert published, "no published host ports found — the regex or the compose shape moved"
    pinned = set(conftest._stack_env())
    assert published <= pinned, (
        f"published but not pinned by the gate: {sorted(published - pinned)} — these fall through "
        f"to deploy/compose/.env and collide with a running local stack")


def test_dynamic_ports_give_every_service_a_free_one(monkeypatch):
    """With COMPOSE_DYNAMIC_PORTS=1 the proof stack must claim nothing a live stack is holding."""
    monkeypatch.setenv("COMPOSE_DYNAMIC_PORTS", "1")
    for var in _PUBLISHED.findall(COMPOSE.read_text()):
        monkeypatch.delenv(var, raising=False)
        got = conftest._host_port(var, "18200")
        assert got != "18200" and got.isdigit(), f"{var} did not get a free port"
