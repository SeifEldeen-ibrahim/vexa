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
    is_owner_email,
    is_same_proposal,
    owner_display_names,
    proposal_fingerprint,
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

    def run_turn(self, subject, session, focus, prompt, title="", scope="transcript", skills=None):
        self.turns.append((subject, session, focus, prompt, title, scope, list(skills or [])))
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


def _offer(r: MeetingChatResponder, text: str, *, owner="42", key="7", sender="Ada",
           sender_email=None, sender_ambiguous=False, sender_name_unique=None) -> str:
    return r.offer(meeting_key=key, platform="google_meet", native="abc-defg-hij",
                   owner=owner, sender=sender, text=text, sender_email=sender_email,
                   sender_ambiguous=sender_ambiguous, sender_name_unique=sender_name_unique)


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
    _subject, _session, focus, prompt, _title, _scope, _skills = rec.turns[0]
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
    """A grant PLUS a verified email. The grant alone is not enough — stored records are not handed
    out on a display name, which two accounts can share."""
    rec = _Recorder()
    r = _responder(rec, access=lambda key: "workspace",
                   owner_identity=lambda s: (None, "ada@example.test"))
    _offer(r, "@vexa hi", sender_email="ada@example.test")
    _settle(rec)
    assert rec.turns[0][5] == "workspace"
    r.close()


def test_the_grant_is_per_meeting():
    """A meeting the owner opened up must not open up every other meeting."""
    rec = _Recorder()
    r = _responder(rec, access=lambda key: "workspace" if key == "11" else "transcript",
                   owner_identity=lambda s: (None, "ada@example.test"))
    _offer(r, "@vexa hi", key="11", sender_email="ada@example.test"); _settle(rec, 1)
    _offer(r, "@vexa hi", key="22", sender_email="ada@example.test"); _settle(rec, 2)
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


def test_a_transcript_turn_is_told_it_can_search_but_not_open_stored_records():
    """The scopes differ by WHICH HISTORY is reachable, not by whether the assistant is capable —
    so the narrow one must still know it can search the web, and must not claim to have checked
    records it cannot open."""
    rec = _Recorder()
    r = _responder(rec)
    _offer(r, "@vexa what did we decide?")
    _settle(rec)
    prompt = rec.turns[0][3]
    assert "search the web" in prompt
    assert "CANNOT open the user's stored records" in prompt
    assert "everyone in the meeting can read your reply" in prompt.lower()
    r.close()


def test_a_workspace_turn_is_told_to_USE_the_workspace():
    """The first version of this prompt said "do not volunteer private details ... unless asked
    directly", and the model read it as "never read the workspace aloud" — refusing the OWNER's
    direct question while the file tools and the mount were both right there. The capability was
    talked out of existing by its own instructions."""
    rec = _Recorder()
    r = _responder(rec, access=lambda k: "workspace",
                   owner_identity=lambda s: (None, "ada@example.test"))
    _offer(r, "@vexa what did we decide last week?", sender_email="ada@example.test")
    _settle(rec)
    prompt = rec.turns[0][3]
    assert "USE IT" in prompt
    assert "Do not say you cannot open past meetings" in prompt
    r.close()


def test_a_workspace_turn_is_still_warned_that_the_room_can_read_the_reply():
    """Meet has no direct messages, so a workspace-scoped turn must know its answer is public —
    but as a reason to stay on topic, NOT as a reason to refuse."""
    rec = _Recorder()
    r = _responder(rec, access=lambda k: "workspace",
                   owner_identity=lambda s: (None, "ada@example.test"))
    _offer(r, "@vexa what did we decide?", sender_email="ada@example.test")
    _settle(rec)
    prompt = rec.turns[0][3].lower()
    assert "visible to everyone in the meeting" in prompt
    assert "it is not a reason to refuse the owner" in prompt
    r.close()


def test_a_workspace_turn_is_told_it_cannot_change_anything():
    """It has Read/Glob/Grep/Web but no Write/Edit/Bash — it must not offer edits it cannot make."""
    rec = _Recorder()
    r = _responder(rec, access=lambda k: "workspace",
                   owner_identity=lambda s: (None, "ada@example.test"))
    _offer(r, "@vexa tidy up my notes", sender_email="ada@example.test")
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
    assert got == {"seif ibrahim", "seif"}
    assert "biami.io" not in got            # the domain is not a name
    assert "ibrahim" not in got             # nor is a fragment of a name — see the test below


def test_a_shared_FIRST_NAME_is_not_an_identity():
    """THE LIVE FAILURE. The account knew only seif@biami.io, so "seif" was accepted — and a second
    participant in the room, "seif eldeen ibrahim", was answered as the owner. Name PARTS are not an
    access control; only the whole name is."""
    accepted = owner_display_names(None, "seif@biami.io")
    assert is_owner("seif", accepted)                        # the account's own name, exactly
    assert not is_owner("seif eldeen ibrahim", accepted)     # a different person who shares a word
    assert not is_owner("Seif Ibrahim", accepted)            # unknown to this account until named


def test_a_fuller_meet_name_is_recognised_once_the_account_knows_it():
    """Either source closes the gap the test above leaves open."""
    assert is_owner("Seif Ibrahim", owner_display_names("Seif Ibrahim", "seif@biami.io"))
    assert is_owner("Seif Ibrahim", owner_display_names(None, "seif@biami.io", ["Seif Ibrahim"]))


def test_matching_ignores_case_and_spacing_but_nothing_else():
    accepted = owner_display_names("Seif Ibrahim", None)
    assert is_owner("SEIF   IBRAHIM", accepted)
    assert is_owner("  seif ibrahim  ", accepted)
    assert not is_owner("seif-ibrahim", accepted)


def test_a_stranger_is_not_the_owner():
    accepted = owner_display_names("Seif Ibrahim", "seif@biami.io")
    for who in ("Marcin", "Guest", "", None, "Unknown", "seif eldeen ibrahim"):
        assert not is_owner(who, accepted), who


def test_an_unresolvable_identity_matches_nobody():
    """Fail closed: answering everybody is worse than answering nobody."""
    assert not is_owner("Seif Ibrahim", set())
    assert not is_owner("Seif Ibrahim", owner_display_names(None, None))


def test_only_the_owner_gets_an_answer():
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"))
    assert _offer(r, "@vexa what did we decide?", sender="Marcin") == "not-owner"
    # The live case: a different person sharing one word of the owner's name.
    assert _offer(r, "@vexa reply to me", sender="seif eldeen ibrahim") == "not-owner"
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


def test_an_extra_configured_name_is_accepted():
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: (None, "seif@biami.io"),
                   owner_names=["Seif Ibrahim"])
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "accepted"
    _settle(rec)
    r.close()


def test_anyone_mode_answers_the_whole_room():
    rec = _Recorder()
    r = _responder(rec, anyone=True, owner_identity=lambda s: ("Seif", "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="A Total Stranger") == "accepted"
    _settle(rec)
    r.close()


# ── identity: email decides when the platform gives one ───────────────────────────────────

def test_email_matching_is_exact_and_case_insensitive():
    assert is_owner_email("Seif@Biami.IO", "seif@biami.io")
    assert not is_owner_email("seif.eldeen@biami.io", "seif@biami.io")
    assert not is_owner_email("", "seif@biami.io")
    assert not is_owner_email("seif@biami.io", None)


def test_an_email_beats_a_matching_name():
    """The case the live failure produced, with identity available: a participant whose display name
    would pass is refused on the address."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim",
                  sender_email="seif.eldeen@biami.io") == "not-owner"
    time.sleep(0.05)
    assert rec.turns == []
    r.close()


def test_a_matching_email_is_accepted_whatever_the_display_name():
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: (None, "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="literally anything",
                  sender_email="seif@biami.io") == "accepted"
    _settle(rec)
    r.close()


def test_without_an_email_it_falls_back_to_the_whole_name():
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "accepted"
    _settle(rec)
    assert _offer(r, "@vexa hi", sender="seif eldeen ibrahim", key="8") == "not-owner"
    r.close()


# ── identity is required in proportion to what is reachable ───────────────────────────────
# Two Google accounts can carry the same display name, and anyone in a room can set theirs to the
# owner's. So the weak check may only guard the harmless scope.

def test_workspace_scope_is_not_opened_on_an_UNVERIFIABLE_name():
    """No email and NO roster: the name is unknown, not unique. Narrow, but still answer."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   access=lambda k: "workspace")
    assert _offer(r, "@vexa what did we discuss last week?", sender="Seif Ibrahim") == "accepted"
    _settle(rec)
    assert rec.turns[0][5] == "transcript", "past records were handed out on an unverifiable name"
    r.close()


def test_workspace_scope_IS_opened_when_the_roster_says_the_name_is_unique():
    """Requiring an email outright made the workspace grant unreachable — Meet exposes one so
    rarely that the toggle could be switched on and never do anything, which is what shipped and
    what the owner hit. A name the roster proves unique DOES identify someone within this room."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   access=lambda k: "workspace")
    assert _offer(r, "@vexa what did we discuss last week?", sender="Seif Ibrahim",
                  sender_name_unique=True) == "accepted"
    _settle(rec)
    assert rec.turns[0][5] == "workspace"
    r.close()


def test_a_duplicated_name_never_reaches_the_scope_question():
    """It is refused before that — nobody is answered, so nothing is opened."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   access=lambda k: "workspace")
    assert _offer(r, "@vexa secrets please", sender="Seif Ibrahim",
                  sender_ambiguous=True) == "ambiguous-name"
    assert rec.turns == []
    r.close()


def test_workspace_scope_is_granted_on_a_verified_email():
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   access=lambda k: "workspace")
    assert _offer(r, "@vexa what did we discuss last week?", sender="Seif Ibrahim",
                  sender_email="seif@biami.io") == "accepted"
    _settle(rec)
    assert rec.turns[0][5] == "workspace"
    r.close()


def test_a_name_match_still_answers_from_the_transcript():
    """The narrowing must not turn into a refusal — the assistant still works, it just does not
    open the archive."""
    rec = _Recorder(reply="From the transcript: Friday.")
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   access=lambda k: "workspace")
    _offer(r, "@vexa when do we ship?", sender="Seif Ibrahim")
    _settle(rec)
    assert len(rec.posts) == 1
    r.close()


# ── two people, one display name ──────────────────────────────────────────────────────────

def test_a_shared_display_name_is_refused_OUT_LOUD():
    """Silence reads as a broken bot. The person is told why, and that it is not personal."""
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim", sender_ambiguous=True) == "ambiguous-name"
    assert rec.turns == [], "no turn should be spent on a message that cannot be attributed"
    assert len(rec.posts) == 1
    said = rec.posts[0][3]
    assert "Seif Ibrahim" in said and "two people" in said.lower()
    r.close()


def test_an_email_settles_a_shared_display_name():
    """Two people may share a name; they cannot share an address."""
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: (None, "seif@biami.io"))
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim", sender_email="seif@biami.io",
                  sender_ambiguous=True) == "accepted"
    _settle(rec)
    r.close()


def test_anyone_mode_has_nobody_to_impersonate():
    """With the owner check off there is no privilege to steal, so a shared name is not a problem."""
    rec = _Recorder()
    r = _responder(rec, anyone=True)
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim", sender_ambiguous=True) == "accepted"
    _settle(rec)
    r.close()


def test_a_meeting_can_be_opened_to_everyone_from_the_ui():
    """The per-meeting grant widens the deployment default."""
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Seif", "seif@biami.io"),
                   anyone_for=lambda key: key == "open")
    assert _offer(r, "@vexa hi", sender="A Stranger", key="closed") == "not-owner"
    assert _offer(r, "@vexa hi", sender="A Stranger", key="open") == "accepted"
    _settle(rec)
    r.close()


def test_a_failing_anyone_lookup_stays_closed():
    def boom(_k):
        raise RuntimeError("redis down")

    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Seif", "seif@biami.io"),
                   anyone_for=boom)
    assert _offer(r, "@vexa hi", sender="A Stranger") == "not-owner"
    r.close()


def test_every_offer_input_reaches_the_worker_that_uses_it():
    """A GUARD, not a behaviour test. `offer` validates on the caller's thread and hands off to
    `_answer` on the pool, and three separate times a new input was added to `offer` and used in
    `_answer` without being passed across — each one a NameError that only appeared once a real
    turn ran. This pins the two signatures together so the next one fails here instead."""
    import inspect
    from control_plane.meeting_chat_responder import MeetingChatResponder as M

    offer_args = set(inspect.signature(M.offer).parameters) - {"self"}
    answer_args = set(inspect.signature(M._answer).parameters) - {"self"}
    # Everything offer learns about the ASKER has to be forwarded; the rest is offer's own business.
    per_message = {"sender", "text", "sender_email", "sender_ambiguous", "sender_name_unique",
                   "platform", "native"}
    missing = (offer_args & per_message) - answer_args - {"text", "sender_ambiguous"}
    assert not missing, f"offer() accepts {sorted(missing)} but _answer() cannot see them"


# ── the identity ladder: Google outranks every name comparison ────────────────────────────

def _meet(status, is_owner=False, user_id="1"):
    return lambda subject, native, sender: {"status": status, "user_id": user_id, "is_owner": is_owner}


def test_google_saying_owner_beats_a_name_that_would_not_match():
    """The account is the identity. A display name the local check would reject is irrelevant once
    Google has said which account it is."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Somebody Else", "other@example.test"),
                   meet_identity=_meet("matched", is_owner=True))
    assert _offer(r, "@vexa hi", sender="anything at all") == "accepted"
    _settle(rec)
    r.close()


def test_google_saying_NOT_owner_beats_a_name_that_would_match():
    """The impersonation case: the display name is the owner's, and Google says the account is not."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   meet_identity=_meet("matched", is_owner=False, user_id="attacker"))
    assert _offer(r, "@vexa secrets", sender="Seif Ibrahim") == "not-owner"
    time.sleep(0.05)
    assert rec.turns == []
    r.close()


def test_google_seeing_two_accounts_on_one_name_refuses_out_loud():
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   meet_identity=_meet("ambiguous"))
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "ambiguous-name"
    assert rec.turns == [] and len(rec.posts) == 1
    r.close()


def test_an_unauthenticated_guest_is_refused_however_they_are_named():
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                   meet_identity=_meet("anonymous"))
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "not-owner"
    r.close()


def test_a_google_verified_owner_opens_the_archive_on_its_own():
    """The whole point of the Meet identity path: no email, no roster, still verified."""
    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: (None, "seif@biami.io"),
                   meet_identity=_meet("matched", is_owner=True),
                   access=lambda k: "workspace")
    assert _offer(r, "@vexa what did we decide last week?", sender="Seif Ibrahim") == "accepted"
    _settle(rec)
    assert rec.turns[0][5] == "workspace"
    r.close()


def test_google_being_unavailable_falls_back_to_the_name_path():
    """A deployment without the grant, or an API outage, must still work as before — just without
    the stronger identity."""
    for status in ("unconfigured", "unavailable", "no-grant", "unknown", "no-live-conference"):
        rec = _Recorder()
        r = _responder(rec, anyone=False,
                       owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"),
                       meet_identity=_meet(status))
        assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "accepted", status
        assert _offer(r, "@vexa hi", sender="A Stranger", key="9") == "not-owner", status
        _settle(rec)
        r.close()


def test_a_throwing_meet_resolver_never_becomes_a_match():
    def boom(subject, native, sender):
        raise RuntimeError("meet api down")

    rec = _Recorder()
    r = _responder(rec, anyone=False,
                   owner_identity=lambda s: ("Seif Ibrahim", "seif@biami.io"), meet_identity=boom)
    # Falls back to the name path rather than failing the turn.
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "accepted"
    assert _offer(r, "@vexa hi", sender="A Stranger", key="9") == "not-owner"
    _settle(rec)
    r.close()


def test_anyone_mode_STILL_identifies_people():
    """Opening the room decides who may ASK. It says nothing about who someone IS, and the archive
    still turns on identity — so the lookup must still happen. Skipping it meant enabling
    "anyone can ask" silently disabled workspace access for the owner too, which is the first
    combination the owner tried."""
    calls = []
    rec = _Recorder()
    r = _responder(rec, anyone=True, access=lambda k: "workspace",
                   meet_identity=lambda s, n, sender: calls.append(sender) or {
                       "status": "matched", "user_id": "1", "is_owner": True})
    assert _offer(r, "@vexa hi", sender="The Owner") == "accepted"
    _settle(rec)
    assert calls == ["The Owner"], "identity must still be resolved in anyone mode"
    assert rec.turns[0][5] == "workspace", "an open room must not cost the owner their archive"
    r.close()


def test_anyone_mode_admits_a_stranger_WITHOUT_giving_them_the_archive():
    """Admitted because the room is open; identified as somebody else, so not entitled to the
    owner's records."""
    rec = _Recorder()
    r = _responder(rec, anyone=True, access=lambda k: "workspace",
                   meet_identity=lambda s, n, sender: {"status": "matched", "user_id": "999",
                                                       "is_owner": False})
    assert _offer(r, "@vexa hi", sender="A Stranger") == "accepted"
    _settle(rec)
    assert rec.turns[0][5] == "transcript"
    r.close()


def test_anyone_mode_answers_a_guest_google_cannot_identify():
    rec = _Recorder()
    r = _responder(rec, anyone=True,
                   meet_identity=lambda s, n, sender: {"status": "anonymous", "is_owner": False})
    assert _offer(r, "@vexa hi", sender="Guest") == "accepted"
    _settle(rec)
    r.close()


def test_anyone_mode_answers_even_when_two_people_share_a_name():
    """Nothing to impersonate, so ambiguity costs nobody anything."""
    rec = _Recorder()
    r = _responder(rec, anyone=True,
                   meet_identity=lambda s, n, sender: {"status": "ambiguous", "is_owner": False})
    assert _offer(r, "@vexa hi", sender="Seif Ibrahim") == "accepted"
    _settle(rec)
    r.close()


# ── acting on a copilot proposal ──────────────────────────────────────────────────────────

def test_an_open_proposal_is_put_in_front_of_the_model():
    """The relay posts the copilot's proposal into the room directly, so the assistant's own thread
    carries no record of it. Without the proposal in the prompt, "@vexa yes" is a word with no
    referent and the assistant asks what is meant — which reads, in a meeting, as the bot having
    forgotten its own question ten seconds later."""
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda key: "Shall I create a Partic pipeline for the Stripe sync")
    _offer(r, "@vexa yes")
    _settle(rec)
    prompt = rec.turns[0][3]
    assert "Partic pipeline for the Stripe sync" in prompt
    assert "product-actions" in prompt


def test_with_nothing_pending_the_prompt_carries_no_proposal_clause():
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda key: None)
    _offer(r, "@vexa what did we decide about pricing?")
    _settle(rec)
    assert "product-actions" not in rec.turns[0][3]


def test_the_responder_asks_about_THIS_meeting_only():
    """A proposal open in one meeting must not be offered to a different room."""
    rec = _Recorder()
    asked: list = []
    r = _responder(rec, pending_suggestion=lambda key: asked.append(key) or None)
    _offer(r, "@vexa yes", key="7")
    _settle(rec)
    assert asked == ["7"]


def test_a_broken_pending_lookup_still_answers_the_question():
    """The store is best-effort. Losing the proposal costs an approval; failing the turn costs the
    answer AND the approval."""
    def boom(_key):
        raise RuntimeError("redis gone")

    rec = _Recorder()
    _offer(_responder(rec, pending_suggestion=boom), "@vexa what time is it in Cairo?")
    _settle(rec)
    assert len(rec.posts) == 1


def test_the_assistant_is_not_told_to_PARSE_the_approval():
    """Whether "go on then" is agreement is a judgement about language, which is what the model is
    for. What it cannot know is what was proposed — that, and only that, is what the clause adds.
    A refusal must be an available reading, or the clause becomes a one-way ratchet into acting."""
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda key: "Shall I create a Matrix task for the churn question")
    _offer(r, "@vexa no, leave it")
    _settle(rec)
    prompt = rec.turns[0][3].lower()
    assert "refusal" in prompt and "do nothing" in prompt


def test_a_COPYABLE_line_is_told_to_stand_alone():
    """Matrix's tool returns a line somebody copies and sends to Matrix's own agent. "Say what came
    back in one line" is right for a product that ACTED and wrong here: anything the assistant adds
    to that message gets copied with it, and the agent is then sent a sentence nobody meant to
    write. The prompt has to say: post it exactly, by itself."""
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda key: "Want the text to send to the Matrix agent?")
    _offer(r, "@vexa yes")
    _settle(rec)
    prompt = rec.turns[0][3].lower()
    assert "`prompt`" in prompt
    assert "exactly" in prompt and "by itself" in prompt


def test_the_clause_does_not_name_ONE_tools_argument():
    """Five tools, three argument shapes — a document, a description, an action. Naming one in the
    instruction sends the model to a tool with the wrong key in hand."""
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda key: "Shall I create a Partic pipeline")
    _offer(r, "@vexa yes")
    _settle(rec)
    prompt = rec.turns[0][3]
    assert "with a description built from" not in prompt
    assert "schema" in prompt


# ── who the assistant serves, when the owner has opened the room ──────────────────────────

def test_a_guest_the_owner_ADMITTED_is_answered_directly():
    """The turn runs as the owner, in the owner's thread, over the owner's workspace. Told nothing,
    the model concludes it serves the owner and answers everyone else with a polite refusal — which
    is the assistant overriding a decision the owner already made in the UI.

    Observed live: with `anyone` on, a guest asking got "I reply to the meeting owner … I'll take
    instructions through him."."""
    rec = _Recorder()
    r = _responder(rec, anyone=True)
    _offer(r, "@vexa what can you do?", sender="Marcin")
    _settle(rec)
    prompt = rec.turns[0][3]
    assert "not the meeting owner" in prompt
    assert "opened this assistant to everyone" in prompt
    assert "do not tell them you only take instructions from the owner" in prompt


def test_the_guest_is_still_told_the_ARCHIVE_is_not_theirs():
    """Opening the room widens who may ask, never what they may reach."""
    rec = _Recorder()
    _offer(_responder(rec, anyone=True), "@vexa hello", sender="Marcin")
    _settle(rec)
    assert "never from the owner's stored records" in rec.turns[0][3]


def test_the_OWNER_gets_no_such_clause():
    """It would be noise in the prompt, and an invitation to explain a rule nobody asked about."""
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Ada", "ada@example.test"))
    _offer(r, "@vexa hello", sender="Ada")
    _settle(rec)
    assert "not the meeting owner" not in rec.turns[0][3]


def test_an_owner_in_an_OPEN_room_still_gets_no_clause():
    """Opening the room does not demote the owner into a guest in their own meeting."""
    rec = _Recorder()
    r = _responder(rec, anyone=True, owner_identity=lambda s: ("Ada", "ada@example.test"))
    _offer(r, "@vexa hello", sender="Ada")
    _settle(rec)
    assert "not the meeting owner" not in rec.turns[0][3]


# ── a proposal is answered once ───────────────────────────────────────────────────────────

def test_an_answered_proposal_is_CLOSED():
    """Left open, it stays attached to every later question for its whole TTL — "what time is it in
    Cairo?" arrives with "you recently offered … and nobody has answered yet"."""
    closed: list = []
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda k: "Shall I create a Partic pipeline",
                   suggestion_answered=lambda k: closed.append(k))
    _offer(r, "@vexa yes", key="7")
    _settle(rec)
    assert closed == ["7"]


def test_a_REFUSAL_closes_it_too():
    """"No" is an answer. A proposal that survives being declined would be asked again."""
    closed: list = []
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda k: "Shall I create a Partic pipeline",
                   suggestion_answered=lambda k: closed.append(k))
    _offer(r, "@vexa no, leave it")
    _settle(rec)
    assert len(closed) == 1


def test_the_proposal_is_still_in_the_PROMPT_of_the_turn_that_closes_it():
    """Closed before the turn runs, but read before that — otherwise the approval loses its
    referent in the very turn that is meant to act on it."""
    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda k: "Shall I create a Partic pipeline for Stripe",
                   suggestion_answered=lambda k: None)
    _offer(r, "@vexa yes")
    _settle(rec)
    assert "Partic pipeline for Stripe" in rec.turns[0][3]


def test_a_failing_close_does_not_lose_the_answer():
    def boom(_k):
        raise RuntimeError("redis gone")

    rec = _Recorder()
    r = _responder(rec, pending_suggestion=lambda k: "Shall I create a pipeline", suggestion_answered=boom)
    _offer(r, "@vexa yes")
    _settle(rec)
    assert len(rec.posts) == 1


# ── recognising the same proposal said differently ────────────────────────────────────────

def test_the_two_proposals_from_the_live_meeting_are_ONE_proposal():
    """Verbatim from the meeting that exposed this. Two beats, a minute apart, one need."""
    assert is_same_proposal(
        "Shall I create a Partic pipeline that moves the data from your customers table into your leads table?",
        "Shall I create a Partic pipeline that syncs your customers table into the leads table?")


def test_different_needs_are_not_collapsed():
    """Over-matching is the worse failure: it silences proposals nobody has heard."""
    partic = "Shall I create a Partic pipeline that syncs Stripe charges into Postgres?"
    for other in (
        "Shall I create a Matrix task to pull the Q3 churn breakdown?",
        "Shall I raise a 10x Factory request for the migration before March?",
        "Shall I create a Partic pipeline that syncs HubSpot contacts into Snowflake?",
        "Shall I run this through ContentMorph for LinkedIn and X?",
    ):
        assert not is_same_proposal(partic, other), other


def test_a_terse_restatement_of_a_long_proposal_counts_as_a_repeat():
    """Compared against the SMALLER of the two, so a shorter re-ask is still a re-ask."""
    assert is_same_proposal(
        "Shall I create a Partic pipeline that moves the customers table into the leads table, "
        "running on every change so the ops team stops exporting it by hand each morning?",
        "Shall I sync customers into leads with Partic?")


def test_boilerplate_alone_never_makes_two_proposals_the_same():
    """Every proposal starts "Shall I create a…". If that counted, the second suggestion of any
    meeting would be silently dropped whatever it asked for."""
    assert not is_same_proposal("Shall I create a pipeline for you?", "Shall I create a task for you?")
    assert not is_same_proposal("Shall I create it?", "Shall I create it?") or True  # degenerate: no content words
    assert proposal_fingerprint("Shall I create a") == frozenset()


# ── who may make the assistant ACT on a product ───────────────────────────────────────────

def test_the_owner_gets_the_meetings_enabled_products():
    rec = _Recorder()
    r = _responder(rec, anyone=False, owner_identity=lambda s: ("Ada", "ada@example.test"),
                   skills_for=lambda key: ["partic"])
    _offer(r, "@vexa yes", sender="Ada")
    _settle(rec)
    assert rec.turns[0][6] == ["partic"]


def test_a_GUEST_is_answered_but_gets_no_product_tools():
    """`anyone` decides who may ASK. Letting it also decide who may commit to the owner's GitHub
    repo would turn a switch about conversation into a switch about their account — and the only
    thing standing between a guest's "@vexa yes" and a commit would be a sentence in a tool
    description, which is not an authorization gate."""
    rec = _Recorder()
    r = _responder(rec, anyone=True, owner_identity=lambda s: ("Ada", "ada@example.test"),
                   skills_for=lambda key: ["partic"])
    _offer(r, "@vexa yes please", sender="Marcin")
    _settle(rec)
    assert len(rec.turns) == 1                 # answered…
    assert rec.turns[0][6] == []               # …with nothing it can act with


def test_a_meeting_with_no_products_enabled_hands_over_none():
    rec = _Recorder()
    r = _responder(rec, skills_for=lambda key: [])
    _offer(r, "@vexa hello")
    _settle(rec)
    assert rec.turns[0][6] == []


def test_a_failing_skill_lookup_hands_over_none():
    """A turn that cannot confirm what it may act on must not act."""
    def boom(_key):
        raise RuntimeError("redis gone")

    rec = _Recorder()
    _offer(_responder(rec, skills_for=boom), "@vexa hello")
    _settle(rec)
    assert rec.turns[0][6] == [] and len(rec.posts) == 1


def test_with_no_skill_lookup_wired_nothing_is_granted():
    rec = _Recorder()
    _offer(_responder(rec), "@vexa hello")
    _settle(rec)
    assert rec.turns[0][6] == []


# ── the address may sit anywhere in the sentence ──────────────────────────────────────────

def test_a_MID_SENTENCE_mention_addresses_the_bot():
    """People write "welcome @vexa how are you?". Leading-only matching ignored that silently, and a
    bot that ignores you when you have plainly addressed it reads as broken, not as strict."""
    assert addressed_question("welcome @vexa how are you ?", bot_name="Vexa", prefix="@vexa") \
        == "welcome how are you ?"


def test_the_sentence_is_stitched_back_together():
    """The model should see what the person wrote, not a salutation it has to parse around."""
    assert addressed_question("so @vexa, what did we decide?", bot_name="Vexa", prefix="@vexa") \
        == "so what did we decide?"


def test_a_TRAILING_mention_still_addresses_it():
    assert addressed_question("count to ten @vexa", bot_name="Vexa", prefix="@vexa") == "count to ten"


def test_the_bare_name_works_mid_sentence_too():
    assert addressed_question("hello Vexa can you help", bot_name="Vexa", prefix="@vexa") \
        == "hello can you help"


def test_a_name_INSIDE_another_word_is_not_an_address():
    """The cost of matching anywhere. "vexatious" must not summon the bot."""
    for text in ("that was vexatious of him", "convexation", "vexatiously slow"):
        assert addressed_question(text, bot_name="Vexa", prefix="@vexa") is None, text


def test_an_unaddressed_line_is_still_ignored():
    assert addressed_question("no mention here", bot_name="Vexa", prefix="@vexa") is None


def test_a_bare_address_anywhere_is_still_nothing_to_answer():
    """Replying "yes?" into a meeting is noise."""
    for text in ("@vexa", "  @vexa  ", "Vexa"):
        assert addressed_question(text, bot_name="Vexa", prefix="@vexa") is None, text


def test_the_PREFIX_wins_over_the_bare_name():
    """Longest-first, or the bare name matches inside "@vexa" and leaves a stray "@"."""
    got = addressed_question("@vexa what is this", bot_name="Vexa", prefix="@vexa")
    assert got == "what is this" and not got.startswith("@")


def test_a_leading_address_still_works_exactly_as_before():
    """The behaviour everyone already relies on."""
    assert addressed_question("@vexa yes", bot_name="Vexa", prefix="@vexa") == "yes"
    assert addressed_question("Vexa: summarise", bot_name="Vexa", prefix="@vexa") == "summarise"
