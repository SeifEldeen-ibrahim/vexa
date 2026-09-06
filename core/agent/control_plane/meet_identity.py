"""meet_identity — who is actually in a Google Meet, from Google rather than from the page.

The problem this exists to solve: Meet's in-call chat carries a DISPLAY NAME and nothing else. A
display name is not an identity — two Google accounts can carry the same one, and anyone in a room
can set theirs to the meeting owner's. Scraping the participants panel for an email was tried and
Meet exposed none, so the page cannot answer "who sent this" at all.

The Meet REST API can. ``conferenceRecords.participants.list`` filtered to ``latestEndTime IS NULL``
returns who is in the call RIGHT NOW, and every signed-in participant carries a stable account id
(``signedinUser.user`` = ``users/{id}``) beside their display name. That id is the identity; the name
is only the bridge from a chat line to a roster row.

WHAT THIS CAN AND CANNOT DO, stated plainly because the difference decides the security story:

  CAN   say, with Google's authority, which accounts are in the room and what each one is called.
        So a display name shared by two accounts becomes VISIBLE, where on the page it is invisible.
  CANNOT bind a specific chat MESSAGE to a specific account. Google does not expose that link. So the
        rule is "exactly one participant answers to this name, and that participant is the owner" —
        and two people on one name is refused rather than guessed.

Unauthenticated guests come back as ``anonymousUser`` with no id at all. That is the right answer:
they are exactly the participants whose self-chosen name should carry no weight.

Everything here is best-effort and FAILS CLOSED: an unreachable API, a missing token, an expired
grant all resolve to "unknown", never to "it's the owner".
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

logger = logging.getLogger("agent_api.meet_identity")

MEET_API = "https://meet.googleapis.com/v2"
TOKEN_URL = "https://oauth2.googleapis.com/token"

#: The scope a user grants once at sign-in. Read-only, and only about meeting spaces they can
#: already see — it grants no ability to join, change or record anything.
MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly"

#: Access tokens last an hour; refresh a little early so a turn never races the expiry.
_TOKEN_SKEW_SEC = 120


class MeetIdentityError(Exception):
    """Any failure resolving identity. Callers treat it as 'unknown', never as a match."""


def _get_json(url: str, access_token: str, timeout: int = 8) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:300]
        except Exception:  # noqa: BLE001
            pass
        raise MeetIdentityError(f"{e.code} from {url.split('?')[0]}: {body}") from e
    except Exception as e:  # noqa: BLE001
        raise MeetIdentityError(f"unreachable: {url.split('?')[0]}: {e}") from e


def exchange_refresh_token(refresh_token: str, client_id: str, client_secret: str) -> tuple:
    """Refresh token → (access_token, expires_at_epoch). Raises MeetIdentityError on any failure.

    A refresh token can be revoked by the user at any time from their Google account, so this failing
    is a NORMAL state, not an exception in the surprising sense — it means the grant is gone and
    identity is unavailable until they sign in again."""
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:200]
        except Exception:  # noqa: BLE001
            pass
        raise MeetIdentityError(f"token refresh refused ({e.code}): {detail}") from e
    except Exception as e:  # noqa: BLE001
        raise MeetIdentityError(f"token endpoint unreachable: {e}") from e
    token = body.get("access_token")
    if not token:
        raise MeetIdentityError("token refresh returned no access_token")
    return token, time.time() + float(body.get("expires_in") or 3600) - _TOKEN_SKEW_SEC


def space_name_for(meeting_code: str, access_token: str) -> str:
    """A Meet code (`abc-defg-hij`) → the canonical `spaces/{id}`.

    The code works directly as an alias on ``spaces.get``, which is what makes this usable at all:
    the meetings domain already stores the code as ``native_meeting_id``, so no new plumbing is
    needed to know WHICH meeting to ask about."""
    code = (meeting_code or "").strip()
    if not code:
        raise MeetIdentityError("no meeting code")
    body = _get_json(f"{MEET_API}/spaces/{urllib.parse.quote(code)}", access_token)
    name = body.get("name")
    if not name:
        raise MeetIdentityError(f"no space for meeting code {code!r}")
    return name


def active_conference_for(space_name: str, access_token: str) -> Optional[str]:
    """The conference record for the call happening in this space NOW, or None if none is live.

    ``endTime IS NULL`` is the "still running" filter — a space accumulates one conference record per
    call, and asking about a finished one would answer about the wrong meeting."""
    q = urllib.parse.quote(f'space.name="{space_name}"')
    body = _get_json(f"{MEET_API}/conferenceRecords?filter={q}", access_token)
    for rec in body.get("conferenceRecords") or []:
        if not rec.get("endTime"):
            return rec.get("name")
    return None


def live_participants(conference_name: str, access_token: str) -> list:
    """Who is in the call right now: ``[{display_name, user_id|None, anonymous: bool}]``.

    ``latestEndTime IS NULL`` restricts the list to participants who have not left. Without it the
    list includes everyone who was EVER in the call, which would let someone who has already gone
    keep answering."""
    q = urllib.parse.quote("latestEndTime IS NULL")
    out: list = []
    url = f"{MEET_API}/{conference_name}/participants?filter={q}&pageSize=100"
    seen_pages = 0
    while url and seen_pages < 5:          # a meeting with >500 live participants is not our case
        body = _get_json(url, access_token)
        for p in body.get("participants") or []:
            signed = p.get("signedinUser") or {}
            anon = p.get("anonymousUser") or {}
            phone = p.get("phoneUser") or {}
            name = signed.get("displayName") or anon.get("displayName") or phone.get("displayName") or ""
            uid = (signed.get("user") or "").split("/")[-1] if signed.get("user") else None
            out.append({"display_name": name, "user_id": uid, "anonymous": not signed})
        token = body.get("nextPageToken")
        url = f"{MEET_API}/{conference_name}/participants?filter={q}&pageSize=100&pageToken={token}" if token else None
        seen_pages += 1
    return out


def match_sender(participants: list, sender: str) -> dict:
    """Resolve a chat display name against the live roster.

    Returns ``{"status": …, "user_id": …}`` where status is one of:

      ``matched``    exactly one SIGNED-IN participant answers to this name — ``user_id`` is theirs.
      ``ambiguous``  two or more do. A chat message cannot say which, so nobody is identified.
      ``anonymous``  the only match is an unauthenticated guest: a self-chosen label, no account.
      ``unknown``    nobody in the roster answers to this name (they left, or the name is stale).

    The whole point is that ``ambiguous`` is DISTINGUISHABLE. On the page it is invisible, which is
    how a second participant sharing one word of the owner's name was answered as the owner."""
    want = " ".join((sender or "").strip().lower().split())
    if not want:
        return {"status": "unknown", "user_id": None}
    hits = [p for p in participants
            if " ".join((p.get("display_name") or "").strip().lower().split()) == want]
    if not hits:
        return {"status": "unknown", "user_id": None}
    signed = [p for p in hits if p.get("user_id")]
    if len(hits) > 1:
        return {"status": "ambiguous", "user_id": None}
    if not signed:
        return {"status": "anonymous", "user_id": None}
    return {"status": "matched", "user_id": signed[0]["user_id"]}


class MeetIdentityResolver:
    """Resolves a chat sender to a Google account id, using the OWNER's own grant.

    The owner's token is what makes this legal and simple: they are asking Google about a meeting
    they are in, not about strangers. Access tokens are cached per owner until they expire.

    ``credentials(subject) -> (refresh_token, google_user_id)`` is injected so the whole class is
    provable offline and holds no opinion about where secrets live.
    """

    def __init__(self, *, credentials: Callable[[str], tuple], client_id: str, client_secret: str,
                 fetch: Optional[Callable] = None) -> None:
        self._credentials = credentials
        self._client_id = client_id
        self._client_secret = client_secret
        self._fetch = fetch            # test seam: replaces the three Meet calls wholesale
        self._tokens: dict = {}        # subject -> (access_token, expires_at)

    def _access_token(self, subject: str, refresh_token: str) -> str:
        tok, exp = self._tokens.get(subject, (None, 0.0))
        if tok and time.time() < exp:
            return tok
        tok, exp = exchange_refresh_token(refresh_token, self._client_id, self._client_secret)
        self._tokens[subject] = (tok, exp)
        return tok

    def resolve(self, subject: str, meeting_code: str, sender: str) -> dict:
        """Who is this chat sender? Returns ``{"status", "user_id", "is_owner"}``.

        ``is_owner`` is True only for ``matched`` whose account id equals the owner's own. Every
        other outcome — ambiguous, anonymous, unknown, or any failure at all — is False. There is no
        path here that upgrades uncertainty into a match."""
        try:
            refresh_token, owner_user_id = self._credentials(subject)
        except Exception:  # noqa: BLE001
            logger.exception("meet-identity: credential lookup failed for subject %s", subject)
            return {"status": "unavailable", "user_id": None, "is_owner": False}
        if not refresh_token:
            return {"status": "no-grant", "user_id": None, "is_owner": False}
        try:
            if self._fetch is not None:
                participants = self._fetch(subject, meeting_code)
            else:
                token = self._access_token(subject, refresh_token)
                space = space_name_for(meeting_code, token)
                conference = active_conference_for(space, token)
                if not conference:
                    return {"status": "no-live-conference", "user_id": None, "is_owner": False}
                participants = live_participants(conference, token)
        except MeetIdentityError as e:
            logger.warning("meet-identity: %s/%s unavailable — %s", subject, meeting_code, e)
            return {"status": "unavailable", "user_id": None, "is_owner": False}
        except Exception:  # noqa: BLE001
            logger.exception("meet-identity: unexpected failure for %s/%s", subject, meeting_code)
            return {"status": "unavailable", "user_id": None, "is_owner": False}

        result = match_sender(participants, sender)
        uid = result.get("user_id")
        is_owner = bool(uid and owner_user_id and str(uid) == str(owner_user_id))
        # The comparison that decides whether a People API hop is ever needed: Meet's account id
        # against the id stored at sign-in. Logged on a mismatch so the answer comes from a real
        # meeting rather than from an assumption about how Google numbers accounts.
        if uid and owner_user_id and not is_owner:
            logger.info("meet-identity: %r resolved to account %s; the owner is %s (not a match)",
                        sender, uid, owner_user_id)
        elif uid and not owner_user_id:
            logger.warning("meet-identity: resolved %r to account %s but this owner has no stored "
                           "account id to compare against — sign in again to record one", sender, uid)
        return {"status": result["status"], "user_id": uid, "is_owner": is_owner}
