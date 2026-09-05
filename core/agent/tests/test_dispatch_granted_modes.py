"""A dispatch's `mode: "ro"` grant must actually reach the worker's mount set.

THE RED HALF OF THIS PAIR WAS OBSERVED LIVE. A turn dispatched read-only from an untrusted input
surface — a question typed into a meeting's own chat, which ANY participant including an external
guest can send — created and git-committed a file in the meeting owner's private workspace:

    -rw-r--r-- 1 root root 31 /workspaces/6/test.md
    14575a0 Done - I created test.md in your private workspace at /workspaces/6/test

`unit.v1` said ro. `VEXA_WORKSPACES` said ro. `VEXA_MOUNTS` — the list the worker actually
materializes — said write:True, because build_mount_set re-derives the active set from the store and
stamps the private baseline writable unconditionally. The grant was decorative.
"""
from __future__ import annotations

from control_plane.dispatch import _apply_granted_modes


def _stack():
    """The three-tier stack build_mount_set produces: _global (ro), private (rw), _system (rw)."""
    return [
        {"slug": "_global", "path": "/workspaces/_global", "role": "global", "write": False, "primary": False},
        {"slug": "6", "path": "/workspaces/6", "role": "private", "write": True, "primary": True},
        {"slug": "_system", "path": "/workspaces/_system/6", "role": "system", "write": True, "primary": False},
    ]


def test_an_ro_grant_makes_the_private_workspace_read_only():
    """The live failure, as a test."""
    out = _apply_granted_modes(_stack(), [{"id": "6", "mode": "ro"}])
    private = next(m for m in out if m["slug"] == "6")
    assert private["write"] is False, "an ro grant must reach VEXA_MOUNTS, not just VEXA_WORKSPACES"


def test_the_default_rw_dispatch_is_unchanged():
    """The negative control: an ordinary chat turn (the owner typing in the Assistant tab) keeps
    write. A fix that made everything read-only would 'pass' the row above and break the product."""
    for granted in ([{"id": "6", "mode": "rw"}], [], None or []):
        out = _apply_granted_modes(_stack(), granted)
        assert next(m for m in out if m["slug"] == "6")["write"] is True


def test_a_grant_can_only_narrow_never_widen():
    """A read-only tier stays read-only however the invocation asks."""
    out = _apply_granted_modes(_stack(), [{"id": "_global", "mode": "rw"}])
    assert next(m for m in out if m["slug"] == "_global")["write"] is False


def test_an_ro_grant_narrows_only_the_workspace_it_names():
    out = _apply_granted_modes(_stack(), [{"id": "6", "mode": "ro"}])
    assert next(m for m in out if m["slug"] == "_system")["write"] is True


def test_a_malformed_grant_leaves_the_stack_alone():
    for bad in (["not-a-dict"], [{"no_id": 1}], [None]):
        out = _apply_granted_modes(_stack(), bad)
        assert [m["write"] for m in out] == [False, True, True]


def test_the_original_mount_dicts_are_not_mutated():
    """The stack is reused across the env build; narrowing must copy, not edit in place."""
    stack = _stack()
    _apply_granted_modes(stack, [{"id": "6", "mode": "ro"}])
    assert stack[1]["write"] is True
