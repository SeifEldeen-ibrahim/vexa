"""The SQLAlchemy adapter for the in-person lane. Mirrors the shapes
``bot_spawn.adapters`` uses (``_row_to_dict``, the per-user advisory lock) so a live session row
is indistinguishable from a bot's row to every reader downstream."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .ports import PLATFORM

#: Statuses that mean "this session is still going". Mirrors the bot FSM's non-terminal set as it
#: applies here: a live session is only ever `active` or terminal.
_LIVE = ("active",)


def _utc_naive() -> datetime:
    """UTC *without* a tzinfo — what ``meetings.start_time`` / ``end_time`` accept.

    The two meeting tables differ, and asyncpg enforces it: ``meetings.start_time`` is a
    ``TIMESTAMP WITHOUT TIME ZONE`` (naive), while ``meeting_sessions.session_start_time`` is
    ``DateTime(timezone=True)`` (aware). Passing an AWARE datetime to the naive column fails the
    INSERT outright — "can't subtract offset-naive and offset-aware datetimes" — so the two writes
    below deliberately use different clocks. Mirrors ``bot_spawn.adapters``, which does the same.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _row(m) -> dict:
    return {
        "id": m.id,
        "user_id": m.user_id,
        "platform": m.platform,
        "native_meeting_id": m.platform_specific_id,
        "status": m.status,
        "start_time": _iso(m.start_time),
        "end_time": _iso(m.end_time),
        "data": m.data if isinstance(m.data, dict) else {},
        "created_at": _iso(m.created_at),
        "updated_at": _iso(m.updated_at),
    }


class SqlAlchemyLiveSessionStore:
    def __init__(self, session_factory):
        self._session_factory = session_factory

    async def create_live_session(self, user_id: int, *, session_uid: str, data: dict) -> dict:
        from sqlalchemy import bindparam, select, text

        from ..sessions import new_session
        from ..sessions.models import Meeting

        now = _utc_naive()
        async with self._session_factory() as db:
            # Serialize per user exactly as spawn/plan do, so a reconnect racing the first
            # connect cannot produce two rows for one call.
            await db.execute(
                text("SELECT pg_advisory_xact_lock(:uid)").bindparams(bindparam("uid", user_id))
            )
            existing = (
                await db.execute(
                    select(Meeting).where(
                        Meeting.user_id == user_id,
                        Meeting.platform == PLATFORM,
                        Meeting.platform_specific_id == session_uid,
                        Meeting.status.in_(_LIVE),
                    )
                )
            ).scalars().first()
            if existing is not None:
                return _row(existing)

            meeting = Meeting(
                user_id=user_id,
                platform=PLATFORM,
                platform_specific_id=session_uid,
                # Born ACTIVE: the capture host only asks for a row once audio is actually
                # flowing, and there is no join/admission phase to pass through.
                status="active",
                start_time=now,
                data=dict(data or {}),
            )
            db.add(meeting)
            await db.flush()
            # The session row the recordings path and the stale-sweep join look up by uid.
            db.add(new_session(meeting.id, session_uid))
            await db.commit()
            await db.refresh(meeting)
            return _row(meeting)

    async def end_live_session(self, user_id: int, meeting_id: int) -> Optional[dict]:
        from sqlalchemy import select

        from ..sessions.models import Meeting

        now = _utc_naive()
        async with self._session_factory() as db:
            meeting = (
                await db.execute(
                    select(Meeting).where(
                        Meeting.id == meeting_id,
                        Meeting.user_id == user_id,
                        Meeting.platform == PLATFORM,
                    )
                )
            ).scalars().first()
            if meeting is None:
                return None
            if meeting.status != "completed":
                meeting.status = "completed"
                meeting.end_time = meeting.end_time or now
                await db.commit()
                await db.refresh(meeting)
            return _row(meeting)

    async def patch_live_session_data(
        self, user_id: int, meeting_id: int, patch: dict
    ) -> Optional[dict]:
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            meeting = (
                await db.execute(
                    select(Meeting).where(
                        Meeting.id == meeting_id,
                        Meeting.user_id == user_id,
                        Meeting.platform == PLATFORM,
                    )
                )
            ).scalars().first()
            if meeting is None:
                return None
            # Reassign rather than mutate: SQLAlchemy does not track in-place JSONB edits, so a
            # mutated dict is a write that silently never happens.
            merged = dict(meeting.data if isinstance(meeting.data, dict) else {})
            merged.update(patch or {})
            meeting.data = merged
            await db.commit()
            await db.refresh(meeting)
            return _row(meeting)

    async def get_live_session(self, user_id: int, meeting_id: int) -> Optional[dict]:
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            meeting = (
                await db.execute(
                    select(Meeting).where(
                        Meeting.id == meeting_id,
                        Meeting.user_id == user_id,
                        Meeting.platform == PLATFORM,
                    )
                )
            ).scalars().first()
            return _row(meeting) if meeting is not None else None

    async def list_live_sessions(self, user_id: int, *, limit: int = 50) -> list[dict]:
        from sqlalchemy import select

        from ..sessions.models import Meeting

        capped = max(1, min(int(limit or 50), 200))
        async with self._session_factory() as db:
            rows = (
                await db.execute(
                    select(Meeting)
                    .where(Meeting.user_id == user_id, Meeting.platform == PLATFORM)
                    .order_by(Meeting.created_at.desc(), Meeting.id.desc())
                    .limit(capped)
                )
            ).scalars().all()
            return [_row(m) for m in rows]
