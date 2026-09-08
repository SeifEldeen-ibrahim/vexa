"""The trigger seam: a `source:'chat'` segment on the transcript wire reaches the responder.

Drives the SHIPPED `transcription_watcher._handle` directly with the wire payloads the BOT actually
publishes, so the branch is proved against the real envelope shape rather than a guess:

    {"type": "transcription", "meeting_id": …, "native_meeting_id": …, "owner_user_id": …,
     "segments": [{"speaker": …, "text": …, "source": "chat"|…}]}

The point of this file is the SEPARATION: speech goes to the copilot path only, typed chat goes to
the responder, and the arm loop hands off without ever running a turn itself.
"""
from __future__ import annotations

from control_plane import transcription_watcher as tw


class _FakeRedis:
    """Enough redis for `_handle`: the copilot opt-in flag is OFF, so no arm is attempted."""

    def get(self, _key):
        return None

    def expire(self, *_a, **_k):
        return True

    def delete(self, *_a, **_k):
        return True


class _FakeLive:
    def __init__(self):
        self.rows = []

    def add(self, row):
        self.rows.append(row)

    def drop(self, _key):
        pass


class _SpyResponder:
    def __init__(self, verdict="accepted"):
        self.offers = []
        self._verdict = verdict

    def offer(self, **kw):
        self.offers.append(kw)
        return self._verdict


def _payload(segments, *, owner=77, mid="7"):
    p = {
        "type": "transcription",
        "meeting_id": mid,
        "native_meeting_id": "abc-defg-hij",
        "platform": "google_meet",
        "segments": segments,
    }
    if owner is not None:
        p["owner_user_id"] = owner
    return p


def _handle(payload, responder):
    tw._handle(_FakeRedis(), object(), _FakeLive(), "u_live", payload, {}, {}, {}, responder)


def _seg(text, *, source, speaker="Ada"):
    return {"speaker": speaker, "text": text, "source": source, "completed": True}


def test_a_typed_chat_segment_reaches_the_responder():
    spy = _SpyResponder()
    _handle(_payload([_seg("@vexa what did we decide?", source="chat")]), spy)
    assert len(spy.offers) == 1
    off = spy.offers[0]
    assert off["text"] == "@vexa what did we decide?"
    assert off["sender"] == "Ada"
    assert off["platform"] == "google_meet"
    assert off["native"] == "abc-defg-hij"
    # keyed on the meetings-domain ROW id, never the native code
    assert off["meeting_key"] == "7"
    assert off["owner"] == 77


def test_spoken_segments_never_reach_the_responder():
    """The negative control that matters: everything anyone SAYS is not a question for the bot."""
    spy = _SpyResponder()
    _handle(_payload([
        _seg("so I think we should ship on Friday", source="caption"),
        _seg("agreed", source="glow-bound"),
        _seg("@vexa this was spoken aloud, not typed", source="merged"),
    ]), spy)
    assert spy.offers == []


def test_the_owner_is_carried_through_and_absent_when_the_bot_did_not_stamp_it():
    spy = _SpyResponder()
    _handle(_payload([_seg("@vexa hi", source="chat")], owner=None), spy)
    # The branch still OFFERS — refusing is the responder's decision (and its own test), so that the
    # "no owner" case is logged in one place rather than silently dropped in two.
    assert spy.offers[0]["owner"] is None


def test_empty_chat_text_is_dropped_before_the_responder():
    spy = _SpyResponder()
    _handle(_payload([_seg("   ", source="chat"), {"source": "chat"}]), spy)
    assert spy.offers == []


def test_several_chat_lines_in_one_batch_are_each_offered():
    spy = _SpyResponder()
    _handle(_payload([
        _seg("@vexa first", source="chat", speaker="Ada"),
        _seg("unrelated chatter", source="chat", speaker="Grace"),
        _seg("@vexa second", source="chat", speaker="Ada"),
    ]), spy)
    assert [o["text"] for o in spy.offers] == ["@vexa first", "unrelated chatter", "@vexa second"]
    assert [o["sender"] for o in spy.offers] == ["Ada", "Grace", "Ada"]


def test_a_deployment_with_the_feature_off_passes_no_responder_and_nothing_breaks():
    """`chat_responder=None` is the default: the branch is skipped entirely."""
    tw._handle(_FakeRedis(), object(), _FakeLive(), "u_live",
               _payload([_seg("@vexa hi", source="chat")]), {}, {}, {}, None)


def test_a_throwing_responder_cannot_take_down_the_arm_thread():
    class _Boom:
        def offer(self, **_kw):
            raise RuntimeError("responder exploded")

    # _handle is called inside the watcher's own try/except, but the responder contract is
    # never-raise; assert we do not depend on the caller's guard for an ordinary failure.
    try:
        _handle(_payload([_seg("@vexa hi", source="chat")]), _Boom())
    except RuntimeError:
        raise AssertionError("a responder fault escaped into the arm loop")
