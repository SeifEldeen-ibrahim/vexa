"""In-memory ``LiveSessionStore`` — what the app factory falls back to with no DB, and what the
router's tests drive. Same owner-scoping and same idempotence as the SQL adapter, so a test that
passes here is a test about the ROUTER, not about the fake."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .ports import PLATFORM


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class InMemoryLiveSessionStore:
    def __init__(self) -> None:
        self.rows: list[dict] = []
        self._next_id = 1

    def _owned(self, user_id: int, meeting_id: int) -> Optional[dict]:
        for row in self.rows:
            if (
                row["id"] == meeting_id
                and row["user_id"] == user_id
                and row["platform"] == PLATFORM
            ):
                return row
        return None

    async def create_live_session(self, user_id: int, *, session_uid: str, data: dict) -> dict:
        for row in self.rows:
            if (
                row["user_id"] == user_id
                and row["native_meeting_id"] == session_uid
                and row["status"] == "active"
            ):
                return dict(row)
        row = {
            "id": self._next_id,
            "user_id": user_id,
            "platform": PLATFORM,
            "native_meeting_id": session_uid,
            "status": "active",
            "start_time": _now(),
            "end_time": None,
            "data": dict(data or {}),
            "created_at": _now(),
            "updated_at": _now(),
        }
        self._next_id += 1
        self.rows.append(row)
        return dict(row)

    async def end_live_session(self, user_id: int, meeting_id: int) -> Optional[dict]:
        row = self._owned(user_id, meeting_id)
        if row is None:
            return None
        if row["status"] != "completed":
            row["status"] = "completed"
            row["end_time"] = row["end_time"] or _now()
            row["updated_at"] = _now()
        return dict(row)

    async def patch_live_session_data(
        self, user_id: int, meeting_id: int, patch: dict
    ) -> Optional[dict]:
        row = self._owned(user_id, meeting_id)
        if row is None:
            return None
        merged = dict(row["data"])
        merged.update(patch or {})
        row["data"] = merged
        row["updated_at"] = _now()
        return dict(row)

    async def get_live_session(self, user_id: int, meeting_id: int) -> Optional[dict]:
        row = self._owned(user_id, meeting_id)
        return dict(row) if row is not None else None

    async def list_live_sessions(self, user_id: int, *, limit: int = 50) -> list[dict]:
        capped = max(1, min(int(limit or 50), 200))
        mine = [dict(r) for r in self.rows if r["user_id"] == user_id and r["platform"] == PLATFORM]
        return list(reversed(mine))[:capped]
