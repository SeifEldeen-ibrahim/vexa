"""The reconcile sweep must not end a meeting that is still happening.

An in-person Nexus session has NO bot and NO runtime workload, so to the general
stale-nonterminal reconcile every live one looks exactly like a bot that exited without
reporting — and the reap would mark a call `completed` while people are still talking in the
room, the moment the room went quiet for longer than `active_grace`.

Both listings (the SQL adapter's query and this in-memory mirror) carry the same exclusion, keyed
on the one literal in `bot_spawn.ports.LIVE_PLATFORM`; this proves the mirror, which is what the
sweep's own tests drive.
"""
from __future__ import annotations

from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
from meeting_api.bot_spawn.ports import LIVE_PLATFORM

GRACES = dict(stop_grace=1.0, active_grace=1.0, preactive_grace=1.0)


async def _stale_row(repo, platform: str, uid: str) -> int:
    row = await repo.create_meeting(
        user_id=7, platform=platform, native_meeting_id=uid, data={}
    )
    await repo.create_session(meeting_id=row["id"], session_uid=uid)
    repo.set_status(row["id"], "active")
    # The fake's rows carry a static timestamp in the past, so they are already stale.
    return row["id"]


async def test_a_quiet_bot_meeting_is_still_reaped():
    """The control: the sweep must keep doing its job for real bot meetings."""
    repo = InMemoryMeetingRepo()
    mid = await _stale_row(repo, "google_meet", "abc-defg-hij")
    listed = await repo.list_stale_nonterminal(**GRACES)
    assert [row[0] for row in listed] == [mid]


async def test_a_quiet_in_person_session_is_never_reaped():
    repo = InMemoryMeetingRepo()
    await _stale_row(repo, LIVE_PLATFORM, "nx-live-1")
    assert await repo.list_stale_nonterminal(**GRACES) == []


async def test_an_in_person_session_does_not_hide_a_stale_bot_beside_it():
    repo = InMemoryMeetingRepo()
    await _stale_row(repo, LIVE_PLATFORM, "nx-live-1")
    bot = await _stale_row(repo, "google_meet", "abc-defg-hij")
    assert [row[0] for row in await repo.list_stale_nonterminal(**GRACES)] == [bot]
