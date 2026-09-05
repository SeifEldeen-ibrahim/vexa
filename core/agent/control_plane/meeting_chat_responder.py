"""meeting_chat_responder — the assistant, reachable from inside the meeting's own chat.

A participant types ``@vexa what did we decide about pricing?`` into the Google Meet chat; the
answer arrives in that same chat, from the same agent, in the same conversation thread the Terminal's
Assistant tab shows. One assistant, two transports.

WHERE THIS SITS. The bot already publishes in-meeting chat as ``transcript.v1`` segments with
``source:'chat'`` (the gmeet/jitsi readers), and those ride ``transcription_segments`` — the stream
the agent's watcher ALREADY consumes. So the trigger costs no new transport: the watcher hands each
chat segment to :meth:`MeetingChatResponder.offer` and everything else happens here.

THREE RULES THIS MODULE EXISTS TO ENFORCE, each because the obvious implementation is wrong:

1. **Never block the caller.** ``transcription_watcher``'s arm loop is ONE daemon thread serving
   EVERY live meeting on the deployment, and it is the sole arbiter that re-arms and reaps every
   copilot. Running an agent turn inside it would stall re-arm/reap for every other concurrent
   meeting for the length of that turn. :meth:`offer` therefore only matches and hands off; the turn
   runs on this module's own bounded pool.

2. **Key on the meetings-domain ROW id, never the native code.** The native code collides across
   different users AND across one user's re-sends of the same link — that collision is the
   cross-tenant leak the transcript carrier was already re-keyed to avoid. A chat SESSION keyed by
   it would merge two owners' threads exactly the same way.

3. **Untrusted input gets read-only mounts.** This is the first agent-input surface reachable by
   someone who is not the account owner: ANY participant in the room, including an external guest.
   ``units.mode_for("message")`` grants ``rw`` because a chat turn is normally the owner typing; that
   assumption does not hold here, so the dispatch pins ``ro`` explicitly rather than inheriting it.

WHO MAY ASK. By default only the meeting's OWNER is answered; everyone else is read and ignored.
That is the real permission check — the ``@vexa`` prefix is only a spam and cost filter, and anyone
in the room can type it.

Matching is by DISPLAY NAME, because that is all Google Meet gives a bot: its chat carries a
participant's name and no email, account id or any other identity. So "is this the owner?" is
answered by comparing the chat name against the owner's account name and their email's local part.
That is a heuristic, and it is stated as one: a participant who sets their Meet display name to the
owner's would pass it. It bounds casual use, not a determined impersonator — the transcript-only
default is what bounds the damage either way. Set ``VEXA_MEET_CHAT_ANYONE=true`` to answer the whole
room instead.

GROUNDING SCOPE — and why the default is the narrow one. The turn runs as the meeting's OWNER, so
whatever it can read, it can read ALOUD into a room the owner does not control. Read-only mounts stop
an untrusted participant CHANGING the workspace; they do nothing about a guest typing
"@vexa what do my notes say about salaries?" and getting the answer printed into the chat. Access is
therefore:

  ``transcript``  (default) — the CURRENT meeting's transcript and nothing else. There is no private
                  material in scope, so there is nothing to exfiltrate. This answers what the feature
                  is actually for: questions about what was said in this room.
  ``workspace``   (opt-in, per meeting, from the UI) — the owner's full workspace, READ-ONLY, plus
                  the search and web tools that make it useful. Past meetings' notes are in there
                  because the copilot writes them regardless of this setting, so switching a meeting
                  to ``workspace`` also brings prior meetings into scope, not just this one. Write
                  and shell tools stay off in BOTH scopes: the request comes from a room the owner
                  does not control.

The knob is per MEETING and defaults closed on every new meeting: a room you trusted last week is not
the room you are in today.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

logger = logging.getLogger("agent_api.meet_chat")

#: Meet's composer caps one message at 500 characters; meeting-api refuses more. Replies are chunked
#: to just under that so a long answer arrives as several messages rather than a 422.
REPLY_CHUNK_CHARS = 480
#: At most this many messages per reply. A wall of text in a meeting chat is worse than a short
#: answer plus "(continued in the Assistant tab)" — the full turn is always readable there.
REPLY_MAX_CHUNKS = 3

#: Grounding scopes. `transcript` is the default and the safe one — see GROUNDING SCOPE above.
SCOPE_TRANSCRIPT = "transcript"
SCOPE_WORKSPACE = "workspace"


def owner_display_names(name: "str | None", email: "str | None") -> set:
    """The display names that count as the owner, lower-cased.

    Google Meet shows a chosen display name ("Seif Ibrahim"), while the account may only have an
    email ("seif@biami.io"). So the local part is included, and matching is per WORD as well as
    whole-string: "seif" matches "Seif Ibrahim". Dots and underscores in a local part are split too
    ("ada.lovelace@x" → "ada", "lovelace")."""
    out: set = set()
    for v in (name, email):
        v = (v or "").strip().lower()
        if not v:
            continue
        if "@" in v:
            v = v.split("@", 1)[0]
        out.add(v)
        for part in re.split(r"[.\s_+-]+", v):
            if len(part) >= 3:
                out.add(part)
    return {v for v in out if v}


def is_owner(sender: "str | None", accepted: set) -> bool:
    """Does this chat display name belong to the owner? Empty ``accepted`` ⇒ False (fail closed:
    an identity we could not resolve is not a match)."""
    who = (sender or "").strip().lower()
    if not who or not accepted:
        return False
    if who in accepted:
        return True
    return any(w in accepted for w in re.split(r"[.\s_+-]+", who) if len(w) >= 3)


def strip_markdown(text: str) -> str:
    """Flatten an agent's markdown into something readable as plain chat text.

    Meet chat renders no markdown, so ``**bold**`` and ``### heads`` arrive as literal punctuation.
    This is a presentation concern at the boundary, not a change to what the agent wrote — the
    Assistant tab still shows the original."""
    out = text
    out = re.sub(r"```[a-zA-Z0-9_-]*\n(.*?)```", r"\1", out, flags=re.DOTALL)  # fenced blocks
    out = re.sub(r"`([^`]+)`", r"\1", out)                                     # inline code
    out = re.sub(r"^\s{0,3}#{1,6}\s*", "", out, flags=re.MULTILINE)            # headings
    out = re.sub(r"\*\*([^*]+)\*\*", r"\1", out)                               # bold
    out = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", out)                    # italic
    out = re.sub(r"^\s{0,3}[-*+]\s+", "- ", out, flags=re.MULTILINE)           # bullets
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1 (\2)", out)         # links
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def chunk_reply(text: str, *, size: int = REPLY_CHUNK_CHARS, max_chunks: int = REPLY_MAX_CHUNKS) -> list[str]:
    """Split a reply into chat-sized messages, preferring paragraph then sentence boundaries.

    An over-long answer is TRUNCATED with a pointer rather than paged endlessly into the meeting —
    see REPLY_MAX_CHUNKS."""
    body = text.strip()
    if not body:
        return []
    chunks: list[str] = []
    while body and len(chunks) < max_chunks:
        if len(body) <= size:
            chunks.append(body)
            body = ""
            break
        window = body[:size]
        cut = max(window.rfind("\n\n"), window.rfind(". "), window.rfind("\n"))
        if cut < size // 3:      # no sensible boundary — hard-cut on a word
            cut = window.rfind(" ")
        if cut <= 0:
            cut = size
        chunks.append(body[:cut].strip())
        body = body[cut:].strip()
    if body:
        tail = chunks[-1] if chunks else ""
        suffix = " […] (full answer in the Assistant tab)"
        chunks[-1] = (tail[: size - len(suffix)].rstrip() + suffix) if tail else suffix.strip()
    return [c for c in chunks if c]


#: Characters a chat session id may contain. The session id flows into the unit id and from there
#: into a DOCKER CONTAINER NAME, which docker restricts to ``[a-zA-Z0-9][a-zA-Z0-9_.-]*``. A `:` or
#: `/` in the session makes the spawn fail with a 400 the agent sees only as a 502 — so the id is
#: built safe at the source rather than sanitised at the point it breaks.
_SESSION_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def meeting_session_id(platform: str, meeting_key: str) -> str:
    """The chat-thread id for a meeting: readable in the Assistant tab, legal as a container name.

    Keyed on the meetings-domain ROW id, never the native code — the native code collides across
    users and across one user's re-sends of the same link."""
    safe = lambda v: _SESSION_SAFE.sub("-", str(v or "").strip()).strip("-.") or "unknown"
    return f"meet-{safe(platform)}-{safe(meeting_key)}"


def address_to(reply: str, sender: str) -> str:
    """Prefix a reply with the asker's name, so a busy chat shows who each answer is for.

    THIS IS NOT PRIVACY, and the distinction matters. Google Meet's in-call chat has no direct
    messages — every message goes to everyone in the room, and a bot cannot opt out of that. So the
    most that can be done here is to ADDRESS the reply; everyone still sees it. Anything that must
    not be readable by the room must not be asked for in the room: that is what the transcript-only
    default is for.

    An unresolved sender gets no prefix rather than a fake one ("Unknown, ...")."""
    who = (sender or "").strip()
    if not who or who.lower() in ("unknown", "someone"):
        return reply
    return f"@{who} {reply}"


def addressed_question(text: str, *, bot_name: str, prefix: str, always: bool = False) -> Optional[str]:
    """The question a chat line is asking the bot, or ``None`` when it is not addressed to it.

    Recognised: the configured prefix (``@vexa …``), the bot's own display name with or without an
    ``@``, and — only when ``always`` is set — every line. Returns the message with the address
    stripped, so the agent sees the question rather than the salutation.

    A bare address with no question ("@vexa") returns None: there is nothing to answer, and replying
    "yes?" into a meeting is noise."""
    body = (text or "").strip()
    if not body:
        return None
    for token in filter(None, [prefix, f"@{bot_name}".strip(), bot_name.strip()]):
        t = token.strip()
        if not t:
            continue
        if body.lower().startswith(t.lower()):
            rest = body[len(t):].lstrip(" ,:;-–—")
            return rest or None
    return body if always else None


class MeetingChatResponder:
    """Turns an addressed in-meeting chat message into an agent turn and a reply in that chat.

    Every collaborator is injected so the whole flow is provable offline:
      ``run_turn(subject, session, focus, prompt, title, scope) -> str`` — one agent turn, returns
        the reply text. ``title`` names the thread in the Assistant tab and is the QUESTION alone, not
        the prompt. ``scope`` is ``"transcript"`` or ``"workspace"`` (see GROUNDING SCOPE above).
      ``access(meeting_key) -> str`` — the meeting's granted scope. Anything that is not exactly
        ``"workspace"`` is treated as ``"transcript"``: an unreachable store, a typo or a missing key
        must all fail CLOSED, because failing open here means reading private notes into a room.
      ``post_reply(owner, platform, native, text) -> bool``  — deliver one message into the meeting,
        AS the named owner. The owner is passed explicitly rather than implied by a key, so a
        deployment serving many users does not depend on one of them holding the credential.
    """

    def __init__(
        self,
        *,
        run_turn: Callable[[str, str, dict, str, str, str], str],
        post_reply: Callable[[str, str, str, str], bool],
        access: Optional[Callable[[str], str]] = None,
        bot_name: str = "Vexa",
        prefix: str = "@vexa",
        always: bool = False,
        anyone: bool = False,
        owner_identity: Optional[Callable[[str], "tuple"]] = None,
        max_workers: int = 2,
        min_interval_s: float = 5.0,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._run_turn = run_turn
        self._post_reply = post_reply
        self._access = access
        self._bot_name = bot_name
        self._prefix = prefix
        self._always = always
        self._anyone = anyone
        self._owner_identity = owner_identity
        self._min_interval_s = min_interval_s
        self._log = log or (lambda m: logger.info("%s", m))
        # Bounded on purpose: a Meet bot is already most of this box's CPU, and every turn is a
        # container dispatch competing with the capture pipeline it is answering from.
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="meet-chat")
        self._lock = threading.Lock()
        self._inflight: set[str] = set()      # meeting keys with a turn running
        self._last_at: dict[str, float] = {}  # meeting key → last accepted turn (monotonic)

    # ── the trigger (called from the watcher's single arm thread — MUST NOT BLOCK) ──────────────
    def offer(
        self,
        *,
        meeting_key: str,
        platform: str,
        native: str,
        owner: Optional[object],
        sender: str,
        text: str,
    ) -> str:
        """Consider one ``source:'chat'`` segment. Returns a verdict string (for logs and tests);
        never raises, never blocks, and never runs the turn on the caller's thread.

        Verdicts: ``not-addressed`` · ``no-owner`` · ``not-owner`` · ``busy`` · ``rate-limited`` ·
        ``accepted``.
        """
        try:
            question = addressed_question(text, bot_name=self._bot_name, prefix=self._prefix, always=self._always)
            if not question:
                return "not-addressed"
            # FAIL CLOSED. Without the owner we cannot attribute the turn, and the alternative —
            # a placeholder subject — answers out of a workspace that belongs to nobody.
            subject = str(owner).strip() if owner not in (None, "") else ""
            if not subject:
                self._log(f"meet-chat: no ownerUserId on {platform}/{native} — refusing to answer "
                          f"(a placeholder subject would answer from the wrong workspace)")
                return "no-owner"
            # WHO MAY ASK — the real permission check, before any work is done.
            if not self._anyone and not self._sender_is_owner(subject, sender):
                self._log(f"meet-chat: ignoring a question from {sender!r} — not the meeting owner")
                return "not-owner"
            now = time.monotonic()
            with self._lock:
                if meeting_key in self._inflight:
                    return "busy"
                last = self._last_at.get(meeting_key)
                if last is not None and (now - last) < self._min_interval_s:
                    return "rate-limited"
                self._inflight.add(meeting_key)
                self._last_at[meeting_key] = now
            self._pool.submit(self._answer, meeting_key, platform, native, subject, sender, question)
            return "accepted"
        except Exception:  # noqa: BLE001 — the watcher thread must survive anything that happens here
            logger.exception("meet-chat: offer failed for %s", meeting_key)
            return "error"

    # ── the turn (pool thread) ─────────────────────────────────────────────────────────────────
    def _answer(self, meeting_key: str, platform: str, native: str, subject: str, sender: str, question: str) -> None:
        try:
            # The SAME thread identity the Terminal's Assistant tab shows.
            session = meeting_session_id(platform, meeting_key)
            scope = self._scope_for(meeting_key)
            focus = {
                "kind": "meeting",
                "platform": platform,
                "native_id": native,
                "meeting_id": meeting_key,
                "status": "active",
            }
            # Name the asker: several people share this chat, so "who wants this" is part of the ask.
            # A sender the reader could not resolve is "Unknown", which reads as a name — say
            # "Someone" instead rather than putting a fake name in front of the model.
            who = "Someone" if sender.strip().lower() in ("", "unknown") else sender
            scoped = (
                "Answer ONLY from this meeting's transcript. You have no access to any workspace, "
                "notes or documents, and anyone in the meeting can read your reply — do not guess at "
                "private information and do not offer to look anything up."
                if scope == SCOPE_TRANSCRIPT else
                "Answer from this meeting's transcript, the workspace you can read, and the web if "
                "it helps. You cannot change anything — you have no write or shell tools, so do not "
                "offer to edit or create files. EVERYONE IN THE MEETING CAN READ YOUR REPLY: do not "
                "volunteer private details from the workspace that were not already said aloud here "
                "unless you were asked for them directly."
            )
            prompt = (
                f"{who} asked in the meeting chat: {question}\n\n"
                f"{scoped} Be brief — a few sentences at most, plain text, no markdown formatting. "
                "If you do not have the answer, say so plainly."
            )
            reply = self._run_turn(subject, session, focus, prompt, question, scope)
            body = strip_markdown(reply or "")
            if not body:
                self._log(f"meet-chat: empty reply for {platform}/{native} — posting nothing")
                return
            body = address_to(body, sender)
            for chunk in chunk_reply(body):
                if not self._post_reply(subject, platform, native, chunk):
                    self._log(f"meet-chat: reply delivery failed for {platform}/{native}")
                    break
            self._log(f"meet-chat: answered {sender} in {platform}/{native} ({len(body)} chars)")
        except Exception:  # noqa: BLE001 — a failed turn must not take the pool thread down
            logger.exception("meet-chat: turn failed for %s", meeting_key)
        finally:
            with self._lock:
                self._inflight.discard(meeting_key)

    def _sender_is_owner(self, subject: str, sender: str) -> bool:
        """Is this chat display name the meeting's owner? FAILS CLOSED — an identity service that is
        down means nobody is answered, which is quieter than answering everybody."""
        if self._owner_identity is None:
            return False
        try:
            name, email = self._owner_identity(subject)
        except Exception:  # noqa: BLE001
            logger.exception("meet-chat: owner identity lookup failed for subject %s", subject)
            return False
        return is_owner(sender, owner_display_names(name, email))

    def _scope_for(self, meeting_key: str) -> str:
        """The meeting's granted grounding scope. FAILS CLOSED to ``transcript``."""
        if self._access is None:
            return SCOPE_TRANSCRIPT
        try:
            return SCOPE_WORKSPACE if self._access(meeting_key) == SCOPE_WORKSPACE else SCOPE_TRANSCRIPT
        except Exception:  # noqa: BLE001 — an unreadable grant is not a grant
            logger.exception("meet-chat: access lookup failed for %s - falling back to transcript-only",
                             meeting_key)
            return SCOPE_TRANSCRIPT

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
