"""live_sessions — the IN-PERSON meeting lane's row ownership.

A Nexus live session is a meeting that happens in a ROOM: no bot, no meeting URL, no runtime
workload. Somebody opens the Nexus Chrome extension, writes down what the meeting is for, and
streams their microphone to the ``live`` capture host. That host needs a meetings-domain row —
otherwise the call cannot appear in history, the collector has nothing to attribute segments to,
and the terminal's live view has nothing to show.

Why its own module rather than a new public route: creating an ``active`` meeting with no bot is
NOT something an API consumer may do. The capture host is a platform service, so it authenticates
as the platform over the internal tier (``INTERNAL_API_SECRET``, never exposed through the
gateway) and names the owning user explicitly — exactly the pattern
``POST /internal/bots/{platform}/{native}/chat`` already uses for the agent.

Front door (P6): import from here.

* ``PLATFORM`` — the platform value these rows carry (``in_person``).
* ``LiveSessionStore`` — the port: create / end / patch / read / list, all OWNER-SCOPED.
* ``build_router`` — the internal routes, mounted by ``meeting_api.app.create_app``.
* ``InMemoryLiveSessionStore`` — the offline fake the app factory falls back to.
* ``build_production_live_session_store`` — the SQLAlchemy adapter.
"""
from __future__ import annotations

from .fakes import InMemoryLiveSessionStore
from .ports import PLATFORM, LiveSessionStore
from .router import build_router

__all__ = [
    "PLATFORM",
    "LiveSessionStore",
    "InMemoryLiveSessionStore",
    "build_router",
    "build_production_live_session_store",
]


def build_production_live_session_store(session_factory) -> LiveSessionStore:
    """The real adapter. Imported lazily so the fake paths never pull in SQLAlchemy."""
    from .adapters import SqlAlchemyLiveSessionStore

    return SqlAlchemyLiveSessionStore(session_factory)
