"""The copilot's suggestions reaching the meeting's own chat.

The copilot is deliberately tool-less and networkless — it consumes an untrusted transcript — so it
cannot speak into a meeting itself. It writes proposals onto one shared stream and the control plane
delivers them, the same split the bot's transcript already uses.

These drive the SHIPPED `_deliver_suggestion` over fakes, and pin the rules that decide whether a
proposal is posted at all.
"""
from __future__ import annotations

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
    assert '@vexa yes' in text


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
