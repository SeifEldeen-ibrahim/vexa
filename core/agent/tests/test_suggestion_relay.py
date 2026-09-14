"""The copilot's suggestions reaching the meeting's own chat.

The copilot is deliberately tool-less and networkless — it consumes an untrusted transcript — so it
cannot speak into a meeting itself. It writes proposals onto one shared stream and the control plane
delivers them, the same split the bot's transcript already uses.

These drive the SHIPPED `_deliver_suggestion` over fakes, and pin the rules that decide whether a
proposal is posted at all.
"""
from __future__ import annotations

from control_plane.meeting_chat_responder import DEFAULT_MEET_CHAT_PREFIX, meet_chat_prefix
from control_plane.transcription_watcher import _deliver_suggestion


class _Poster:
    def __init__(self, ok: bool = True):
        self.posts: list = []
        self._ok = ok

    def __call__(self, owner, platform, native, text):
        self.posts.append({"owner": owner, "platform": platform, "native": native, "text": text})
        return self._ok


def _payload(**over):
    base = {"meeting_id": "42", "native_id": "abc-defg-hij", "platform": "google_meet",
            "title": "Partic pipeline", "body": "Shall I create a Partic pipeline for the Stripe sync"}
    base.update(over)
    return base


def test_a_suggestion_is_posted_into_the_meeting_as_the_owner():
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6")
    assert len(post.posts) == 1
    p = post.posts[0]
    assert p["owner"] == "6" and p["platform"] == "google_meet" and p["native"] == "abc-defg-hij"
    assert "Partic pipeline for the Stripe sync" in p["text"]


def test_the_proposal_reads_as_a_QUESTION_and_says_how_to_accept():
    """It lands mid-conversation in a meeting chat. Someone must see instantly that nothing has
    happened yet, and what would."""
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6")
    text = post.posts[0]["text"]
    assert "?" in text
    assert f'{DEFAULT_MEET_CHAT_PREFIX} yes' in text


def test_the_accept_hint_quotes_the_token_the_GATE_accepts(monkeypatch):
    """The hint and the gate read one setting. When they did not, a renamed deployment told the room
    to reply "@vexa yes" while the gate had moved on — the assistant ignoring its own instruction."""
    monkeypatch.setenv("VEXA_MEET_CHAT_PREFIX", "@somethingelse")
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6")
    assert '@somethingelse yes' in post.posts[0]["text"]
    assert '@nexus yes' not in post.posts[0]["text"]


def test_an_unset_or_blank_setting_falls_back_to_the_shipped_token(monkeypatch):
    monkeypatch.setenv("VEXA_MEET_CHAT_PREFIX", "   ")
    assert meet_chat_prefix() == DEFAULT_MEET_CHAT_PREFIX
    monkeypatch.delenv("VEXA_MEET_CHAT_PREFIX", raising=False)
    assert meet_chat_prefix() == "@nexus"


def test_a_body_that_is_already_a_question_is_not_double_punctuated():
    post = _Poster()
    _deliver_suggestion(_payload(body="Shall I create a pipeline?"), post, lambda key: "6")
    assert "??" not in post.posts[0]["text"]


def test_no_known_owner_means_the_suggestion_is_DROPPED():
    """A proposal posted under a guessed identity is worse than one never made — it would be
    attributed to whoever the deployment happened to fall back to."""
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: None)
    assert post.posts == []


def test_an_empty_suggestion_is_not_posted():
    post = _Poster()
    for bad in (_payload(title="", body=""), _payload(title="   ", body="  "), _payload(meeting_id="")):
        _deliver_suggestion(bad, post, lambda key: "6")
    assert post.posts == []


def test_the_title_is_used_when_there_is_no_body():
    post = _Poster()
    _deliver_suggestion(_payload(body=""), post, lambda key: "6")
    assert "Partic pipeline" in post.posts[0]["text"]


def test_a_failing_delivery_does_not_raise():
    """The relay serves every meeting on the deployment; one undeliverable proposal must not stop
    the next one."""
    def boom(*_a):
        raise RuntimeError("meeting-api down")

    _deliver_suggestion(_payload(), boom, lambda key: "6")     # must not raise
    post = _Poster(ok=False)
    _deliver_suggestion(_payload(), post, lambda key: "6")     # a False return is not an error
    assert len(post.posts) == 1


def test_a_failing_owner_lookup_does_not_raise():
    def boom(_key):
        raise RuntimeError("registry gone")

    try:
        _deliver_suggestion(_payload(), _Poster(), boom)
    except RuntimeError:
        raise AssertionError("an owner-lookup fault escaped the relay")


# ── remembering what was proposed, so an approval has a referent ──────────────────────────

def test_a_DELIVERED_proposal_is_remembered():
    """The relay posts into the room directly, not through an agent turn — so without this record
    the assistant has no memory of having offered anything, and "@vexa yes" arrives as a word with
    no referent."""
    seen: list = []
    _deliver_suggestion(_payload(), _Poster(), lambda key: "6",
                        lambda key, text: seen.append((key, text)))
    assert seen == [("42", "Shall I create a Partic pipeline for the Stripe sync")]


def test_an_UNDELIVERED_proposal_is_not_remembered():
    """An approval can only follow something someone actually read. Remembering a proposal that
    never reached the room would leave the assistant ready to act on a question nobody was asked."""
    seen: list = []
    _deliver_suggestion(_payload(), _Poster(ok=False), lambda key: "6",
                        lambda key, text: seen.append(key))
    _deliver_suggestion(_payload(), _Poster(), lambda key: None,
                        lambda key, text: seen.append(key))
    assert seen == []


def test_a_failing_recorder_does_not_raise():
    def boom(_key, _text):
        raise RuntimeError("redis gone")

    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", boom)
    assert len(post.posts) == 1        # the proposal still reached the meeting


# ── asked once ────────────────────────────────────────────────────────────────────────────

def test_a_proposal_this_meeting_ALREADY_HEARD_is_not_asked_again():
    """Each copilot beat proposes from a fresh transcript window with no memory of the beat before
    it, so a need still being discussed is offered again in different words. Observed live, twice a
    minute apart: "moves the data from your customers table into your leads table" and then "syncs
    your customers table into the leads table"."""
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", None, lambda key, text: True)
    assert post.posts == []


def test_a_NEW_proposal_still_gets_through():
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", None, lambda key, text: False)
    assert len(post.posts) == 1


def test_the_duplicate_check_sees_the_PROPOSAL_and_its_meeting():
    seen: list = []
    _deliver_suggestion(_payload(), _Poster(), lambda key: "6", None,
                        lambda key, text: seen.append((key, text)) or False)
    assert seen == [("42", "Shall I create a Partic pipeline for the Stripe sync")]


def test_a_failing_duplicate_check_still_posts():
    """A repeated question is an annoyance; a proposal never made is the feature not working."""
    def boom(_key, _text):
        raise RuntimeError("redis gone")

    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", None, boom)
    assert len(post.posts) == 1


# ── the meeting must be about this product ────────────────────────────────────────────────

def test_a_proposal_for_a_meeting_with_NO_SKILLS_is_dropped():
    """A copilot with no product knowledge should never produce a proposal — but "should never" is
    a property of a prompt, and a prompt is a hope. Nothing downstream checked, so a model that
    invented one anyway got it posted into the room, and the approval then reached a tool for a
    product the owner never enabled. Here it is a fact instead."""
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", None, None, lambda key: [])
    assert post.posts == []


def test_a_proposal_for_an_ENABLED_meeting_still_goes():
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", None, None, lambda key: ["partic"])
    assert len(post.posts) == 1


def test_the_skill_lookup_is_asked_about_THIS_meeting():
    seen: list = []
    _deliver_suggestion(_payload(meeting_id="42"), _Poster(), lambda key: "6", None, None,
                        lambda key: seen.append(key) or ["partic"])
    assert seen == ["42"]


def test_a_FAILING_skill_lookup_drops_the_proposal():
    """Fails closed, unlike the duplicate check. A repeated question is an annoyance; a proposal for
    a product this meeting never enabled is the feature doing something nobody asked for."""
    def boom(_key):
        raise RuntimeError("redis gone")

    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6", None, None, boom)
    assert post.posts == []


def test_with_no_skill_lookup_wired_the_relay_still_delivers():
    """A deployment that has not wired the gate keeps working — the gate is an addition, not a
    precondition, so an older composition root does not silently go mute."""
    post = _Poster()
    _deliver_suggestion(_payload(), post, lambda key: "6")
    assert len(post.posts) == 1
