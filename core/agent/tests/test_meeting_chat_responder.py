"""The in-meeting chat assistant — addressing, isolation, and the guards that keep it safe.

Drives the SHIPPED MeetingChatResponder with both collaborators faked, so every rule is provable
offline. The rules under test are the ones whose obvious implementation is wrong:

  * the arm thread must never block on a turn (B-13),
  * two owners of one native meeting code must not share a chat thread (B-12),
  * a segment with no owner produces NO turn — never a placeholder subject (B-10),
  * an unaddressed line is ignored (B-2).
"""
from __future__ import annotations

import threading
import time

import pytest

from control_plane.meeting_chat_responder import (
    MeetingChatResponder,
    addressed_question,
    chunk_reply,
    strip_markdown,
)


class _Recorder:
    """Captures the turns run and the replies posted."""

    def __init__(self, reply: str = "the answer", delay: float = 0.0):
        self.turns: list[tuple[str, str, dict, str]] = []
        self.posts: list[tuple[str, str, str]] = []
        self._reply = reply
        self._delay = delay
        self.entered = threading.Event()
        self.release = threading.Event()

    def run_turn(self, subject, session, focus, prompt):
        self.turns.append((subject, session, focus, prompt))
        self.entered.set()
        if self._delay:
            time.sleep(self._delay)
        if not self.release.is_set() and self._delay < 0:
            self.release.wait(timeout=5)
        return self._reply

    def post_reply(self, platform, native, text):
        self.posts.append((platform, native, text))
        return True


def _responder(rec: _Recorder, **kw) -> MeetingChatResponder:
    kw.setdefault("min_interval_s", 0.0)
    return MeetingChatResponder(run_turn=rec.run_turn, post_reply=rec.post_reply, **kw)


def _offer(r: MeetingChatResponder, text: str, *, owner="42", key="7", sender="Ada") -> str:
    return r.offer(meeting_key=key, platform="google_meet", native="abc-defg-hij",
                   owner=owner, sender=sender, text=text)


def _settle(rec: _Recorder, n: int = 1, timeout: float = 5.0) -> None:
    """Wait for n replies to be posted (the pool is async by design)."""
    deadline = time.time() + timeout
    while time.time() < deadline and len(rec.posts) < n:
        time.sleep(0.01)


# ── addressing ────────────────────────────────────────────────────────────────────────────

def test_addressing_recognises_the_prefix_the_bot_name_and_an_at_name():
    for line in ("@vexa what did we decide?", "Vexa what did we decide?", "@Vexa what did we decide?"):
        assert addressed_question(line, bot_name="Vexa", prefix="@vexa") == "what did we decide?"


def test_addressing_strips_punctuation_after_the_address():
    assert addressed_question("@vexa: summarise", bot_name="Vexa", prefix="@vexa") == "summarise"
    assert addressed_question("@vexa, summarise", bot_name="Vexa", prefix="@vexa") == "summarise"


def test_an_unaddressed_line_is_not_a_question_for_the_bot():
    """B-2 negative control: ordinary meeting chatter must never trigger a turn."""
    assert addressed_question("sounds good to me", bot_name="Vexa", prefix="@vexa") is None
    assert addressed_question("", bot_name="Vexa", prefix="@vexa") is None


def test_a_bare_address_with_no_question_is_ignored():
    """Replying "yes?" into a meeting is noise."""
    assert addressed_question("@vexa", bot_name="Vexa", prefix="@vexa") is None
    assert addressed_question("@vexa   ", bot_name="Vexa", prefix="@vexa") is None


def test_always_mode_takes_every_line():
    assert addressed_question("no address here", bot_name="Vexa", prefix="@vexa", always=True) == "no address here"


# ── the trigger's guards ──────────────────────────────────────────────────────────────────

def test_an_addressed_message_runs_a_turn_and_posts_the_answer_back_to_the_meeting():
    rec = _Recorder(reply="We decided to ship on Friday.")
    r = _responder(rec)
    assert _offer(r, "@vexa what did we decide?") == "accepted"
    _settle(rec)
    assert rec.posts == [("google_meet", "abc-defg-hij", "We decided to ship on Friday.")]
    r.close()


def test_an_unaddressed_message_runs_nothing_at_all():
    rec = _Recorder()
    r = _responder(rec)
    assert _offer(r, "sounds good to me") == "not-addressed"
    time.sleep(0.05)
    assert rec.turns == [] and rec.posts == []
    r.close()


def test_a_segment_with_no_owner_refuses_rather_than_using_a_placeholder_subject():
    """B-10. The watcher's own copilot dispatch still runs under a `u_live` placeholder; the
    responder must NOT inherit that — an answer from a workspace nobody owns is worse than none."""
    rec = _Recorder()
    r = _responder(rec)
    for missing in (None, "", "   "):
        assert _offer(r, "@vexa hello", owner=missing) == "no-owner"
    time.sleep(0.05)
    assert rec.turns == []
    r.close()


def test_the_turn_is_attributed_to_the_owner_off_the_segment():
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa hi", owner=99)
    _settle(rec)
    assert rec.turns[0][0] == "99"
    r.close()


def test_the_session_is_keyed_on_the_row_id_not_the_native_code():
    """B-12. The native code collides across users AND across one user's re-sends — the same
    collision that leaked transcripts before the carrier was re-keyed. Two owners on one Meet link
    must land in DIFFERENT threads."""
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa hi", owner="1", key="11")
    _settle(rec, 1)
    _offer(r, "@vexa hi", owner="2", key="22")
    _settle(rec, 2)
    sessions = {t[1] for t in rec.turns}
    assert sessions == {"meet:google_meet/11", "meet:google_meet/22"}
    # and the native code appears in NEITHER session id
    assert not any("abc-defg-hij" in s for s in sessions)
    r.close()


def test_the_turn_is_grounded_in_the_meeting_and_names_the_asker():
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa what did we decide?", sender="Grace")
    _settle(rec)
    _subject, _session, focus, prompt = rec.turns[0]
    assert focus["kind"] == "meeting" and focus["meeting_id"] == "7"
    assert focus["native_id"] == "abc-defg-hij" and focus["status"] == "active"
    assert "Grace" in prompt and "what did we decide?" in prompt


def test_offer_never_blocks_the_calling_thread():
    """B-13. `offer` runs on the watcher's single arm daemon, which also re-arms and reaps every
    copilot on the deployment. A turn taking a second must not cost the caller a second."""
    rec = _Recorder(reply="slow", delay=0.75)
    r = _responder(rec)
    t0 = time.monotonic()
    assert _offer(r, "@vexa slow question") == "accepted"
    elapsed = time.monotonic() - t0
    assert elapsed < 0.1, f"offer blocked the caller for {elapsed:.3f}s"
    rec.entered.wait(timeout=5)
    _settle(rec)
    r.close()


def test_a_second_question_while_one_is_in_flight_is_refused_not_queued():
    rec = _Recorder(reply="slow", delay=0.5)
    r = _responder(rec)
    assert _offer(r, "@vexa first") == "accepted"
    rec.entered.wait(timeout=5)
    assert _offer(r, "@vexa second") == "busy"
    _settle(rec)
    r.close()


def test_a_rapid_repeat_is_rate_limited():
    """A participant pasting @vexa repeatedly is not an echo loop, but it is still a capacity
    attack on a box where one meeting bot is already most of the CPU."""
    rec = _Recorder()
    r = _responder(rec, min_interval_s=60.0)
    assert _offer(r, "@vexa one") == "accepted"
    _settle(rec)
    assert _offer(r, "@vexa two") == "rate-limited"
    r.close()


def test_different_meetings_do_not_rate_limit_each_other():
    rec = _Recorder()
    r = _responder(rec, min_interval_s=60.0)
    assert _offer(r, "@vexa one", key="1") == "accepted"
    assert _offer(r, "@vexa two", key="2") == "accepted"
    _settle(rec, 2)
    r.close()


def test_a_failing_turn_never_escapes_and_frees_the_meeting_for_the_next_question():
    def boom(*_a):
        raise RuntimeError("model exploded")

    posts: list = []
    r = MeetingChatResponder(run_turn=boom, post_reply=lambda *a: posts.append(a) or True,
                             min_interval_s=0.0)
    assert _offer(r, "@vexa hi") == "accepted"
    time.sleep(0.2)
    assert posts == []
    # the meeting is not left permanently "busy"
    assert _offer(r, "@vexa again") == "accepted"
    r.close()


def test_an_empty_reply_posts_nothing():
    rec = _Recorder(reply="   ")
    r = _responder(rec)
    _offer(r, "@vexa hi")
    time.sleep(0.2)
    assert rec.posts == []
    r.close()


# ── reply presentation ────────────────────────────────────────────────────────────────────

def test_markdown_is_flattened_for_a_chat_that_renders_none():
    md = "## Decisions\n\n- **Ship** on `Friday`\n- See [the doc](https://x.test/d)"
    out = strip_markdown(md)
    assert "##" not in out and "**" not in out and "`" not in out
    assert "Ship on Friday" in out
    assert "the doc (https://x.test/d)" in out


def test_a_short_reply_is_one_message():
    assert chunk_reply("short answer") == ["short answer"]


def test_a_long_reply_is_split_on_a_boundary_and_each_chunk_fits_the_platform_cap():
    body = ("Sentence number %d is here. " % 1) + " ".join(f"Sentence {i} follows." for i in range(2, 90))
    chunks = chunk_reply(body)
    assert len(chunks) > 1
    assert all(len(c) <= 500 for c in chunks)


def test_an_overlong_reply_is_truncated_with_a_pointer_rather_than_paged_forever():
    body = " ".join(f"Filler sentence {i} carries on and on." for i in range(400))
    chunks = chunk_reply(body)
    assert len(chunks) == 3
    assert "Assistant tab" in chunks[-1]


def test_chunking_an_empty_reply_yields_nothing():
    assert chunk_reply("") == []
    assert chunk_reply("   ") == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
