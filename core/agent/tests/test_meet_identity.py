"""Resolving a chat sender to a Google account, via the Meet REST API.

The page cannot answer "who sent this" — Meet's chat carries a display name, and scraping the
participants panel for an email returned nothing on a real meeting. The Meet API can say which
ACCOUNTS are in the room, which is what these pin.

The rules that matter are the ones about NOT matching: ambiguity, anonymity and every kind of
failure must all resolve to "not the owner". A resolver that upgrades uncertainty into a match is
worse than no resolver, because it looks like a control.
"""
from __future__ import annotations

import pytest

from control_plane.meet_identity import (
    MeetIdentityError,
    MeetIdentityResolver,
    match_sender,
)

OWNER = "108123456789"
ROSTER = [
    {"display_name": "Seif Ibrahim", "user_id": OWNER, "anonymous": False},
    {"display_name": "Marcin Kowalski", "user_id": "22299", "anonymous": False},
    {"display_name": "Guest", "user_id": None, "anonymous": True},
]


# ── matching a chat name against the live roster ──────────────────────────────────────────

def test_one_signed_in_participant_with_that_name_resolves_to_their_account():
    assert match_sender(ROSTER, "Seif Ibrahim") == {"status": "matched", "user_id": OWNER}


def test_matching_ignores_case_and_spacing():
    assert match_sender(ROSTER, "  seif   IBRAHIM ")["user_id"] == OWNER


def test_two_participants_on_one_name_resolve_to_NOBODY():
    """The case the whole feature turns on: a chat message cannot say which of them wrote it, and
    on the page this is invisible. Here it is a distinct, refusable state."""
    roster = ROSTER + [{"display_name": "Seif Ibrahim", "user_id": "99999", "anonymous": False}]
    assert match_sender(roster, "Seif Ibrahim") == {"status": "ambiguous", "user_id": None}


def test_an_impersonator_makes_the_OWNERS_own_name_ambiguous():
    """Renaming yourself to the owner does not steal their identity — it destroys the usefulness of
    the name for BOTH of you, which is the honest outcome."""
    roster = ROSTER + [{"display_name": "Seif Ibrahim", "user_id": "attacker", "anonymous": False}]
    assert match_sender(roster, "Seif Ibrahim")["status"] == "ambiguous"


def test_an_unauthenticated_guest_is_never_an_account():
    """A guest's display name is a self-chosen label with no account behind it."""
    assert match_sender(ROSTER, "Guest") == {"status": "anonymous", "user_id": None}


def test_a_name_nobody_in_the_room_answers_to_is_unknown():
    assert match_sender(ROSTER, "Ada Lovelace")["status"] == "unknown"
    assert match_sender(ROSTER, "")["status"] == "unknown"
    assert match_sender([], "Seif Ibrahim")["status"] == "unknown"


# ── the resolver, end to end over an injected roster ──────────────────────────────────────

def _resolver(roster, *, refresh="rt", owner_id=OWNER):
    return MeetIdentityResolver(
        credentials=lambda subject: (refresh, owner_id),
        client_id="cid", client_secret="secret",
        fetch=lambda subject, code: roster,
    )


def test_the_owner_is_identified_by_their_ACCOUNT_not_their_name():
    r = _resolver(ROSTER)
    got = r.resolve("6", "abc-defg-hij", "Seif Ibrahim")
    assert got == {"status": "matched", "user_id": OWNER, "is_owner": True}


def test_someone_else_signed_in_is_not_the_owner():
    r = _resolver(ROSTER)
    got = r.resolve("6", "abc-defg-hij", "Marcin Kowalski")
    assert got["status"] == "matched" and got["is_owner"] is False


def test_an_impersonator_does_not_become_the_owner():
    roster = ROSTER + [{"display_name": "Seif Ibrahim", "user_id": "attacker", "anonymous": False}]
    got = _resolver(roster).resolve("6", "abc-defg-hij", "Seif Ibrahim")
    assert got["status"] == "ambiguous" and got["is_owner"] is False


def test_a_guest_is_not_the_owner_however_they_are_named():
    roster = [{"display_name": "Seif Ibrahim", "user_id": None, "anonymous": True}]
    got = _resolver(roster).resolve("6", "abc-defg-hij", "Seif Ibrahim")
    assert got["status"] == "anonymous" and got["is_owner"] is False


def test_no_stored_account_id_means_no_match_even_on_a_clean_resolve():
    """A deployment that never recorded the owner's account cannot claim anyone IS the owner."""
    got = _resolver(ROSTER, owner_id=None).resolve("6", "abc-defg-hij", "Seif Ibrahim")
    assert got["status"] == "matched" and got["is_owner"] is False


# ── every failure is 'not the owner' ──────────────────────────────────────────────────────

def test_a_user_who_never_granted_access_yields_no_grant():
    got = _resolver(ROSTER, refresh="").resolve("6", "abc-defg-hij", "Seif Ibrahim")
    assert got == {"status": "no-grant", "user_id": None, "is_owner": False}


def test_a_revoked_or_unreachable_grant_is_not_a_match():
    def boom(subject, code):
        raise MeetIdentityError("401 invalid_grant")

    r = MeetIdentityResolver(credentials=lambda s: ("rt", OWNER), client_id="c",
                             client_secret="s", fetch=boom)
    assert r.resolve("6", "abc-defg-hij", "Seif Ibrahim") == {
        "status": "unavailable", "user_id": None, "is_owner": False}


def test_an_unexpected_fault_is_not_a_match_either():
    def boom(subject, code):
        raise RuntimeError("something nobody predicted")

    r = MeetIdentityResolver(credentials=lambda s: ("rt", OWNER), client_id="c",
                             client_secret="s", fetch=boom)
    assert r.resolve("6", "abc-defg-hij", "Seif Ibrahim")["is_owner"] is False


def test_a_broken_credential_lookup_is_not_a_match():
    def boom(subject):
        raise RuntimeError("store down")

    r = MeetIdentityResolver(credentials=boom, client_id="c", client_secret="s",
                             fetch=lambda s, c: ROSTER)
    assert r.resolve("6", "abc-defg-hij", "Seif Ibrahim") == {
        "status": "unavailable", "user_id": None, "is_owner": False}


def test_no_live_conference_is_not_a_match():
    """Asked about a meeting that is not running — answer about nobody, not about the last call."""
    calls = []

    def creds(subject):
        calls.append(subject)
        return ("rt", OWNER)

    r = MeetIdentityResolver(credentials=creds, client_id="c", client_secret="s",
                             fetch=lambda s, c: [])
    got = r.resolve("6", "abc-defg-hij", "Seif Ibrahim")
    assert got["status"] == "unknown" and got["is_owner"] is False


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
