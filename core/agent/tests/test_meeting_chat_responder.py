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

import re

from control_plane.meeting_chat_responder import (
    MeetingChatResponder,
    address_to,
    addressed_question,
    is_owner,
    owner_display_names,
    chunk_reply,
    meeting_session_id,
    strip_markdown,
)

#: What docker accepts as a container name. The session id ends up inside one.
DOCKER_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


class _Recorder:
    """Captures the turns run and the replies posted."""

    def __init__(self, reply: str = "the answer", delay: float = 0.0):
        self.turns: list[tuple[str, str, dict, str]] = []
        self.posts: list[tuple[str, str, str]] = []
        self._reply = reply
        self._delay = delay
        self.entered = threading.Event()
        self.release = threading.Event()

    def run_turn(self, subject, session, focus, prompt, title="", scope="transcript"):
        self.turns.append((subject, session, focus, prompt, title, scope))
        self.entered.set()
        if self._delay:
            time.sleep(self._delay)
        if not self.release.is_set() and self._delay < 0:
            self.release.wait(timeout=5)
        return self._reply

    def post_reply(self, owner, platform, native, text):
        self.posts.append((owner, platform, native, text))
        return True


def _responder(rec: _Recorder, **kw) -> MeetingChatResponder:
    kw.setdefault("min_interval_s", 0.0)
    # These tests are about the rest of the flow, not about WHO may ask, so the owner gate is open
    # unless a test says otherwise. The gate has its own tests (see "who may ask") which set
    # `anyone=False` explicitly — the shipped default is owner-only.
    kw.setdefault("anyone", True)
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
    assert rec.posts == [("42", "google_meet", "abc-defg-hij", "@Ada We decided to ship on Friday.")]
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


def test_the_session_id_is_legal_as_a_docker_container_name():
    """Found live: `meet:google_meet/27` reached `docker create` as
    `vexa-worker-6-chat-meet:google_meet/27` and was rejected 400 — which the agent saw only as a
    502 Bad Gateway from the runtime. The id must be safe at the SOURCE, not sanitised downstream."""
    sid = meeting_session_id("google_meet", "27")
    assert sid == "meet-google_meet-27"
    assert DOCKER_NAME.match(sid), sid
    assert ":" not in sid and "/" not in sid


def test_the_session_id_survives_hostile_platform_and_key_values():
    for platform, key in [("google/meet", "2:7"), ("", ""), ("../etc", "a b"), ("--", "..")]:
        sid = meeting_session_id(platform, key)
        assert DOCKER_NAME.match(sid), (platform, key, sid)


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
    assert sessions == {"meet-google_meet-11", "meet-google_meet-22"}
    # and the native code appears in NEITHER session id
    assert not any("abc-defg-hij" in s for s in sessions)
    r.close()


def test_the_turn_is_grounded_in_the_meeting_and_names_the_asker():
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa what did we decide?", sender="Grace")
    _settle(rec)
    _subject, _session, focus, prompt, _title, _scope = rec.turns[0]
    assert focus["kind"] == "meeting" and focus["meeting_id"] == "7"
    assert focus["native_id"] == "abc-defg-hij" and focus["status"] == "active"
    assert "Grace" in prompt and "what did we decide?" in prompt


def test_the_thread_is_titled_with_the_question_not_the_prompt_scaffolding():
    """Live, the Assistant tab showed the thread as "Someone asked in the meeting chat: how are you
    Answer them …" — this module's own instructions leaking into the thread list."""
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa what did we decide about pricing?")
    _settle(rec)
    title = rec.turns[0][4]
    assert title == "what did we decide about pricing?"
    assert "Answer them" not in title and "meeting chat" not in title
    r.close()


# ── grounding scope: what a guest in the room can get read out to them ────────────────────

def test_the_shipped_default_is_owner_only():
    """The constructor default — not the test helper's — is that only the owner is answered."""
    rec = _Recorder()
    r = MeetingChatResponder(run_turn=rec.run_turn, post_reply=rec.post_reply, min_interval_s=0.0,
                             owner_identity=lambda s: ("Seif", "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="Marcin") == "not-owner"
    r.close()


def test_the_default_scope_is_transcript_only():
    """No access resolver at all ⇒ the narrow scope. A deployment that forgets to wire the grant
    store must not thereby grant everyone the owner's workspace."""
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa hi")
    _settle(rec)
    assert rec.turns[0][5] == "transcript"
    r.close()


def test_a_granted_meeting_gets_workspace_scope():
    rec = _Recorder()
    r = _responder(rec, access=lambda key: "workspace")
    _offer(r, "@vexa hi")
    _settle(rec)
    assert rec.turns[0][5] == "workspace"
    r.close()


def test_the_grant_is_per_meeting():
    """A meeting the owner opened up must not open up every other meeting."""
    rec = _Recorder()
    r = _responder(rec, access=lambda key: "workspace" if key == "11" else "transcript")
    _offer(r, "@vexa hi", key="11"); _settle(rec, 1)
    _offer(r, "@vexa hi", key="22"); _settle(rec, 2)
    got = {t[1]: t[5] for t in rec.turns}
    assert got["meet-google_meet-11"] == "workspace"
    assert got["meet-google_meet-22"] == "transcript"
    r.close()


def test_an_unreadable_or_unexpected_grant_fails_CLOSED():
    """Failing open here means a guest gets private notes read aloud. Every fault is transcript."""
    def boom(_key):
        raise RuntimeError("redis down")

    for resolver in (boom, lambda k: None, lambda k: "", lambda k: "WORKSPACE", lambda k: "rw"):
        rec = _Recorder()
        r = _responder(rec, access=resolver)
        _offer(r, "@vexa hi")
        _settle(rec)
        assert rec.turns[0][5] == "transcript", resolver
        r.close()


def test_the_prompt_tells_a_transcript_turn_it_has_no_workspace():
    """The model must not offer to look something up it cannot reach, in front of the room."""
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa what did we decide?")
    _settle(rec)
    prompt = rec.turns[0][3]
    assert "no access to any workspace" in prompt
    assert "anyone in the meeting can read your reply" in prompt.lower()
    r.close()


def test_a_workspace_turn_is_still_warned_that_the_room_can_read_the_reply():
    """Meet has no direct messages, so a workspace-scoped turn must know its answer is public."""
    rec = _Recorder()
    r = _responder(rec, access=lambda k: "workspace")
    _offer(r, "@vexa what did we decide?")
    _settle(rec)
    prompt = rec.turns[0][3].lower()
    assert "everyone in the meeting can read your reply" in prompt
    r.close()


def test_a_workspace_turn_is_told_it_cannot_change_anything():
    """It has Read/Glob/Grep/Web but no Write/Edit/Bash — it must not offer edits it cannot make."""
    rec = _Recorder()
    r = _responder(rec, access=lambda k: "workspace")
    _offer(r, "@vexa tidy up my notes")
    _settle(rec)
    assert "no write or shell tools" in rec.turns[0][3]
    r.close()


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
                             min_interval_s=0.0, anyone=True)
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


# ── addressing the reply ──────────────────────────────────────────────────────────────────
# Meet's in-call chat has NO direct messages: every message reaches the whole room and a bot cannot
# opt out. Naming the asker is the most that is achievable — it is a readability aid, NOT privacy.

def test_the_reply_names_who_asked():
    assert address_to("Friday.", "Ada Lovelace") == "@Ada Lovelace Friday."


def test_an_unresolved_asker_gets_no_fake_name():
    for who in ("", "   ", "Unknown", "someone"):
        assert address_to("Friday.", who) == "Friday."


def test_the_reply_is_delivered_AS_the_meeting_owner():
    """Not with a shared deployment key: that only ever worked for one user's meetings, and made
    possession of a host secret the answer to "who may make the bot speak here"."""
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa hi", owner="99")
    _settle(rec)
    assert rec.posts[0][0] == "99"
    r.close()


def test_the_posted_reply_is_addressed():
    rec = _Recorder(reply="Friday.")
    r = _responder(rec)
    _offer(r, "@vexa when do we ship?", sender="Grace Hopper")
    _settle(rec)
    assert rec.posts[0][3] == "@Grace Hopper Friday."
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


# ── who may ask ───────────────────────────────────────────────────────────────────────────
# Meet's chat gives a bot a display NAME and nothing else — no email, no account id — so the owner
# check is name matching, and is documented as the heuristic it is.

def test_owner_names_cover_the_account_name_and_the_email_local_part():
    got = owner_display_names("Seif Ibrahim", "seif@biami.io")
    assert "seif ibrahim" in got and "seif" in got and "ibrahim" in got
    assert "biami.io" not in got            # the domain is not a name


def test_owner_names_split_a_dotted_local_part():
    got = owner_display_names(None, "ada.lovelace@example.test")
    assert "ada" in got and "lovelace" in got


def test_owner_names_drop_initials_too_short_to_identify_anyone():
    assert "a" not in owner_display_names(None, "a.lovelace@example.test")


def test_the_owner_is_recognised_by_their_meet_display_name():
    accepted = owner_display_names(None, "seif@biami.io")
    assert is_owner("Seif Ibrahim", accepted)      # the real case, from a live meeting
    assert is_owner("seif", accepted)
    assert is_owner("SEIF IBRAHIM", accepted)


def test_a_stranger_is_not_the_owner():
    accepted = owner_display_names("Seif Ibrahim", "seif@biami.io")
    for who in ("Marcin", "Guest", "", None, "Unknown"):
        assert not is_owner(who, accepted), who


def test_an_unresolvable_identity_matches_nobody():
    """Fail closed: answering everybody is worse than answering nobody."""
    assert not is_owner("Seif Ibrahim", set())
    assert not is_owner("Seif Ibrahim", owner_display_names(None, None))


def test_only_the_owner_gets_an_answer():
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"))
    assert _offer(r, "@vexa what did we decide?", sender="Marcin") == "not-owner"
    time.sleep(0.05)
    assert rec.turns == [] and rec.posts == []
    assert _offer(r, "@vexa what did we decide?", sender="Seif Ibrahim") == "accepted"
    _settle(rec)
    assert len(rec.posts) == 1
    r.close()


def test_a_failing_identity_lookup_answers_nobody():
    def boom(_s):
        raise RuntimeError("admin-api down")

    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=boom)
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "not-owner"
    time.sleep(0.05)
    assert rec.turns == []
    r.close()


def test_anyone_mode_answers_the_whole_room():
    rec = _Recorder()
    r = _responder(rec, anyone=True, owner_identity=lambda s: ("Seif", "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="A Total Stranger") == "accepted"
    _settle(rec)
    r.close()
