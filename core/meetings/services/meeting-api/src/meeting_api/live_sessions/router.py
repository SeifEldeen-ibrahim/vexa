"""The internal routes the Nexus live capture host calls.

AUTHENTICATION. Every route here authenticates the CALLER as the platform
(``Authorization: Bearer ${INTERNAL_API_SECRET}``) and takes the OWNING USER explicitly in the
body/query — the same shape as ``POST /internal/bots/{platform}/{native}/chat``. This tier is
never exposed through the gateway, and the secret is required: an unset secret refuses every
call (503) rather than defaulting to open, because the routes here can create an active meeting
for an arbitrary user id.

``include_in_schema=False`` throughout: internal, not api.v1.
"""
from __future__ import annotations

import hmac
import os
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query

from .ports import PLATFORM, LiveSessionStore

#: An agenda is a short human checklist, not a document. Bound every dimension of it: this blob
#: goes into a JSONB column that is read on every meetings list.
MAX_AGENDA_ITEMS = 40
MAX_DATA_BYTES = 64 * 1024
TITLE_CHARS = 512


def _require_platform_caller(authorization: Optional[str]) -> None:
    """Authenticate the caller as the platform. Possession of ``INTERNAL_API_SECRET`` IS the
    authorization, so the ``Bearer`` prefix is stripped when present and optional otherwise —
    the same leniency ``POST /internal/bots/{platform}/{native}/chat`` has, so one header form
    works across the whole internal tier. Compared with ``hmac.compare_digest``."""
    secret = (os.getenv("INTERNAL_API_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="internal tier requires INTERNAL_API_SECRET")
    bearer = (authorization or "").removeprefix("Bearer ").strip()
    if not bearer or not hmac.compare_digest(bearer, secret):
        raise HTTPException(status_code=401, detail="internal tier requires INTERNAL_API_SECRET")


def _user_id(raw) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="an integer `user_id` is required")
    if value <= 0:
        raise HTTPException(status_code=422, detail="an integer `user_id` is required")
    return value


def _bounded_data(payload: dict) -> dict:
    """Validate the row's ``data`` blob: a title, the agenda, and the capture host's own marks.
    Anything else the host wants to record is accepted but SIZE-BOUNDED."""
    import json

    data = payload.get("data")
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="'data' must be an object")

    title = data.get("title")
    if title is not None:
        if not isinstance(title, str):
            raise HTTPException(status_code=422, detail="'data.title' must be a string")
        data["title"] = title.strip()[:TITLE_CHARS]

    agenda = data.get("agenda")
    if agenda is not None:
        if not isinstance(agenda, dict) or not isinstance(agenda.get("items"), list):
            raise HTTPException(status_code=422, detail="'data.agenda' must be {items: [...]}")
        if len(agenda["items"]) > MAX_AGENDA_ITEMS:
            raise HTTPException(
                status_code=422, detail=f"an agenda may hold at most {MAX_AGENDA_ITEMS} items"
            )

    if len(json.dumps(data).encode()) > MAX_DATA_BYTES:
        raise HTTPException(status_code=413, detail="'data' is too large for a meeting row")
    return data


def build_router(store: LiveSessionStore) -> APIRouter:
    router = APIRouter()

    @router.post("/internal/live/sessions", status_code=201, include_in_schema=False)
    async def create_live_session(
        payload: dict,
        authorization: Optional[str] = Header(default=None),
    ):
        """Claim a meetings row for a call happening in a room. Idempotent per
        ``(user_id, session_uid)`` so a mid-call reconnect does not fork the meeting."""
        _require_platform_caller(authorization)
        user_id = _user_id((payload or {}).get("user_id"))
        session_uid = str((payload or {}).get("session_uid") or "").strip()
        if not session_uid or len(session_uid) > 255:
            raise HTTPException(status_code=422, detail="a `session_uid` is required")
        data = _bounded_data(payload or {})
        data.setdefault("source", "nexus-extension")
        return await store.create_live_session(user_id, session_uid=session_uid, data=data)

    @router.post(
        "/internal/live/sessions/{meeting_id}/end", include_in_schema=False
    )
    async def end_live_session(
        meeting_id: int,
        payload: dict,
        authorization: Optional[str] = Header(default=None),
    ):
        _require_platform_caller(authorization)
        user_id = _user_id((payload or {}).get("user_id"))
        row = await store.end_live_session(user_id, meeting_id)
        if row is None:
            raise HTTPException(status_code=404, detail="no such live session")
        return row

    @router.patch("/internal/live/sessions/{meeting_id}", include_in_schema=False)
    async def patch_live_session(
        meeting_id: int,
        payload: dict,
        authorization: Optional[str] = Header(default=None),
    ):
        """Merge the agenda (and its coverage) onto the row — the durable copy of what the call
        was for and how much of it was actually covered."""
        _require_platform_caller(authorization)
        user_id = _user_id((payload or {}).get("user_id"))
        data = _bounded_data(payload or {})
        if not data:
            raise HTTPException(status_code=422, detail="'data' must carry at least one key")
        row = await store.patch_live_session_data(user_id, meeting_id, data)
        if row is None:
            raise HTTPException(status_code=404, detail="no such live session")
        return row

    @router.get("/internal/live/sessions/{meeting_id}", include_in_schema=False)
    async def get_live_session(
        meeting_id: int,
        user_id: int = Query(...),
        authorization: Optional[str] = Header(default=None),
    ):
        _require_platform_caller(authorization)
        row = await store.get_live_session(_user_id(user_id), meeting_id)
        if row is None:
            raise HTTPException(status_code=404, detail="no such live session")
        return row

    @router.get("/internal/live/sessions", include_in_schema=False)
    async def list_live_sessions(
        user_id: int = Query(...),
        limit: int = Query(default=50),
        authorization: Optional[str] = Header(default=None),
    ):
        """The extension's History tab: this user's in-person calls, newest first."""
        _require_platform_caller(authorization)
        rows = await store.list_live_sessions(_user_id(user_id), limit=limit)
        return {"platform": PLATFORM, "sessions": rows}

    return router
