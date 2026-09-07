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
    assert next(m for m in out if m["role"] == "private")["write"] is False, out


def test_the_platform_continuity_tier_is_NOT_narrowed():
    """A grant says what the turn may change in the SUBJECT'S CONTENT. `_system` is not content — it
    is where worker code keeps the thread's continuity file, and no model tool addresses it.

    Narrowing it bought nothing and cost the turn: a live meeting-chat answer streamed out and then
    the worker died writing `sessions/meet-google_meet-37.session` onto a read-only mount, taking the
    thread with it."""
    out = _apply_granted_modes(_stack(), RO_GRANT)
    assert next(m for m in out if m["role"] == "system")["write"] is True
    # …and the thing the grant IS about is still narrowed.
    assert next(m for m in out if m["role"] == "private")["write"] is False


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


# ── a subject-level grant covers the WHOLE set ────────────────────────────────────────────

REAL_STACK_WITH_ATTACHED = [
    {"slug": "seed", "path": "/workspaces/6", "role": "private", "write": True, "primary": True},
    # An ATTACHED repo — what pinning a GitHub repo produces. Its slug is a hash of the repo URL and
    # its path ends in that slug, so neither matches a grant keyed on the subject.
    {"slug": "vibe-pipe-a1b2c3", "path": "/workspaces/.attached/6/vibe-pipe-a1b2c3",
     "role": "private", "write": True},
    # A SHARED workspace — someone ELSE's, that this subject is a member of.
    {"slug": "team-xyz", "path": "/shared-store/team-xyz", "role": "shared", "write": True},
    {"slug": "_system", "path": "/workspaces/.system/6", "role": "system", "write": True},
]


def _stack_with_attached():
    return [dict(m) for m in REAL_STACK_WITH_ATTACHED]


def test_an_ATTACHED_repo_is_narrowed_by_a_subject_grant():
    """The defect this fixes, live in shipped code: matching a subject-keyed grant per-workspace
    narrowed only the baseline (whose path ends in the subject) and left an attached repo READ-WRITE
    in a turn the caller declared read-only. Same failure as the incident the module documents,
    fixed then for the baseline only."""
    out = _apply_granted_modes(_stack_with_attached(), RO_GRANT, "6")
    assert next(m for m in out if m["slug"] == "vibe-pipe-a1b2c3")["write"] is False


def test_a_SHARED_workspace_is_narrowed_too():
    """It is not even this subject's own data — it belongs to whoever shared it."""
    out = _apply_granted_modes(_stack_with_attached(), RO_GRANT, "6")
    assert next(m for m in out if m["slug"] == "team-xyz")["write"] is False


def test_the_whole_set_except_the_continuity_tier():
    out = _apply_granted_modes(_stack_with_attached(), RO_GRANT, "6")
    assert [m["write"] for m in out] == [False, False, False, True]


def test_an_ordinary_rw_turn_keeps_every_mount_writable():
    """The negative control. A fix that narrowed everything would 'pass' the rows above and break
    the product — the owner typing in the Assistant tab must still be able to write."""
    out = _apply_granted_modes(_stack_with_attached(), [{"id": "6", "mode": "rw"}], "6")
    assert all(m["write"] for m in out)


def test_no_grant_at_all_changes_nothing():
    for granted in ([], None or []):
        out = _apply_granted_modes(_stack_with_attached(), granted, "6")
        assert all(m["write"] for m in out)


def test_without_a_subject_the_old_per_workspace_matching_still_applies():
    """The parameter is optional, so a caller that does not pass it keeps the previous behaviour
    rather than silently narrowing nothing."""
    out = _apply_granted_modes(_stack_with_attached(), [{"id": "vibe-pipe-a1b2c3", "mode": "ro"}])
    assert next(m for m in out if m["slug"] == "vibe-pipe-a1b2c3")["write"] is False
    assert next(m for m in out if m["slug"] == "team-xyz")["write"] is True


def test_a_grant_for_a_DIFFERENT_subject_does_not_narrow_this_stack():
    """The grant list is the invocation's; the subject is the dispatch's. They must agree before a
    turn-level narrowing applies."""
    out = _apply_granted_modes(_stack_with_attached(), [{"id": "7", "mode": "ro"}], "6")
    assert next(m for m in out if m["slug"] == "vibe-pipe-a1b2c3")["write"] is True


# ── internal hints must not reach the sealed contract ─────────────────────────────────────

def test_the_skill_grant_is_stripped_before_the_contract_check():
    """`unit.v1`'s context is additionalProperties:false. Carrying a routing value there without
    stripping it made EVERY meeting-chat turn fail validation and the assistant went silent — the
    failure mode is total, because the dispatch never happens at all.

    Widening the sealed schema is not the alternative: a new field would also make every worker
    older than the control plane reject its own config."""
    import contracts
    from control_plane.dispatch import _without_chat_session

    inv = {
        "identity": {"subject": "6", "launcher": "user:6"}, "runner": "claude-code",
        "workspaces": [{"id": "6", "mode": "ro"}], "trigger": "message",
        "start": {"entrypoint": {"inline": "hi"}},
        "context": {"kind": "none", "skill_grant": "s3cret", "skill_tools": "partic"},
    }
    clean = _without_chat_session(inv)
    assert clean["context"] == {"kind": "none"}
    contracts.validate_unit_invocation(clean)          # must not raise


def test_the_grant_SURVIVES_on_the_in_memory_dispatch():
    """Stripping is for the wire only — `build_unit_env` reads the hint off the original, so a copy
    that mutated the caller's dict would take the turn's authority to act away with it."""
    from control_plane.dispatch import _without_chat_session

    inv = {"identity": {"subject": "6", "launcher": "user:6"}, "runner": "claude-code",
           "workspaces": [{"id": "6", "mode": "ro"}], "trigger": "message",
           "start": {"entrypoint": {"inline": "hi"}},
           "context": {"kind": "none", "skill_grant": "s3cret"}}
    _without_chat_session(inv)
    assert inv["context"]["skill_grant"] == "s3cret"


def test_a_dispatch_with_no_hints_is_returned_UNCHANGED():
    """The common path allocates nothing — and identity is the same object, not a copy."""
    from control_plane.dispatch import _without_chat_session

    inv = {"identity": {"subject": "6", "launcher": "user:6"}, "runner": "claude-code",
           "workspaces": [{"id": "6", "mode": "ro"}], "trigger": "message",
           "start": {"entrypoint": {"inline": "hi"}}, "context": {"kind": "none"}}
    assert _without_chat_session(inv) is inv
