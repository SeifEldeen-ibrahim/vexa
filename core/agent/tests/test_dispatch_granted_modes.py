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


#: CAPTURED FROM A REAL DISPATCH (`docker inspect` on a live meet-chat worker, subject 6), not
#: invented. The first version of this file guessed `slug: "6"` for the private mount; the real slug
#: is the WORKSPACE's name and the subject appears only in the path. That guess is why the first fix
#: passed its test and still let an untrusted turn write — the same fixture-design failure that made
#: every Meet chat sender come back "Unknown". Fixtures for a seam get captured, not imagined.
REAL_MOUNTS = [
    {"slug": "seed", "path": "/workspaces/6", "role": "private", "write": True, "primary": True, "purpose": ""},
    {"slug": "_system", "path": "/workspaces/.system/6", "role": "system", "write": True, "primary": False},
]
#: The grant `units.make_dispatch` actually emits — keyed on the SUBJECT, not on a workspace name.
RO_GRANT = [{"id": "6", "mode": "ro"}]


def _stack():
    """The captured stack, plus the read-only `_global` tier a configured deployment also mounts."""
    return [
        {"slug": "_global", "path": "/workspaces/_global", "role": "global", "write": False, "primary": False},
        *[dict(m) for m in REAL_MOUNTS],
    ]


def test_an_ro_grant_makes_the_private_workspace_read_only():
    """The live failure, as a test — against the mount set a real dispatch produced."""
    out = _apply_granted_modes(_stack(), RO_GRANT)
    private = next(m for m in out if m["role"] == "private")
    assert private["write"] is False, "an ro grant must reach VEXA_MOUNTS, not just VEXA_WORKSPACES"


def test_the_grant_matches_by_path_when_the_slug_is_the_workspace_name():
    """The bug in the FIRST fix: the grant is keyed on the subject ("6") and the private mount's slug
    is the workspace's own name ("seed"), so slug-only matching narrowed nothing at all."""
    out = _apply_granted_modes([dict(m) for m in REAL_MOUNTS], RO_GRANT)
    assert all(m["write"] is False for m in out), out


def test_the_private_system_mount_is_narrowed_too():
    """A turn declared read-only has no business writing the agent's private memory either."""
    out = _apply_granted_modes(_stack(), RO_GRANT)
    assert next(m for m in out if m["role"] == "system")["write"] is False


def test_the_default_rw_dispatch_is_unchanged():
    """The negative control: an ordinary chat turn (the owner typing in the Assistant tab) keeps
    write. A fix that made everything read-only would 'pass' the row above and break the product."""
    for granted in ([{"id": "6", "mode": "rw"}], [], None or []):
        out = _apply_granted_modes(_stack(), granted)
        assert next(m for m in out if m["role"] == "private")["write"] is True
        assert next(m for m in out if m["role"] == "system")["write"] is True


def test_a_grant_can_only_narrow_never_widen():
    """A read-only tier stays read-only however the invocation asks."""
    out = _apply_granted_modes(_stack(), [{"id": "_global", "mode": "rw"}])
    assert next(m for m in out if m["slug"] == "_global")["write"] is False


def test_an_ro_grant_does_not_touch_another_subjects_mount():
    """A shared workspace belonging to someone else is not narrowed by THIS subject's grant."""
    stack = _stack() + [{"slug": "team", "path": "/workspaces/9", "role": "shared", "write": True, "primary": False}]
    out = _apply_granted_modes(stack, RO_GRANT)
    assert next(m for m in out if m["slug"] == "team")["write"] is True


def test_a_malformed_grant_leaves_the_stack_alone():
    for bad in (["not-a-dict"], [{"no_id": 1}], [None]):
        out = _apply_granted_modes(_stack(), bad)
        assert [m["write"] for m in out] == [False, True, True]


def test_the_original_mount_dicts_are_not_mutated():
    """The stack is reused across the env build; narrowing must copy, not edit in place."""
    stack = _stack()
    _apply_granted_modes(stack, RO_GRANT)
    assert stack[1]["write"] is True
