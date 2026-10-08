"""The live-session port. Every method is OWNER-SCOPED: the caller names the user, and a row
that is not theirs is indistinguishable from a row that does not exist (``None``), so the
internal tier can never be walked to read another tenant's meeting."""
from __future__ import annotations

from typing import Optional, Protocol

#: The platform value an in-person Nexus session carries. It is deliberately NOT one of the
#: bot platforms: nothing joins, nothing is admitted, and no runtime workload exists, so every
#: bot-shaped sweep and cap must be able to tell these rows apart (see
#: ``bot_spawn.adapters.list_stale_nonterminal``, which must not reap a row with no container).
PLATFORM = "in_person"


class LiveSessionStore(Protocol):
    async def create_live_session(
        self, user_id: int, *, session_uid: str, data: dict
    ) -> dict:
        """INSERT an ``active`` in-person row (plus its ``MeetingSession``) and return it.

        Idempotent on ``(user_id, session_uid)``: a retry — the extension's WebSocket
        reconnecting mid-call, say — returns the SAME row rather than a second meeting."""
        ...

    async def end_live_session(self, user_id: int, meeting_id: int) -> Optional[dict]:
        """Mark the session finished (``completed`` + ``end_time``). Idempotent; ``None`` when
        the row is absent or owned by someone else."""
        ...

    async def patch_live_session_data(
        self, user_id: int, meeting_id: int, patch: dict
    ) -> Optional[dict]:
        """Shallow-merge ``patch`` into the row's ``data`` JSONB (the agenda + its coverage live
        here). ``None`` when absent / not owned."""
        ...

    async def get_live_session(self, user_id: int, meeting_id: int) -> Optional[dict]:
        ...

    async def list_live_sessions(self, user_id: int, *, limit: int = 50) -> list[dict]:
        """The user's in-person rows, newest first — the extension's History tab."""
        ...
