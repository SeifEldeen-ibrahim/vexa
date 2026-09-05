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

Identity is required IN PROPORTION TO WHAT IS REACHABLE, because a display name is not an identity:
two Google accounts can carry the same one, and anyone in a meeting can set theirs to the owner's.

  ``transcript``  a whole-name match is enough. An impersonator gains help with a meeting they are
                  already sitting in, and nothing private is in reach.
  ``workspace``   a VERIFIED EMAIL is required. Past records are never handed out on the strength of
                  a name. If Meet exposed no address for the asker, the turn silently narrows to
                  ``transcript`` — it answers, it just does not open the archive.

Identity, in order of strength:

  EMAIL   — exact match, and decisive when present. Meet's CHAT carries no email, so the bot reads
            the people panel for one; Meet exposes an address for some participants (typically
            same-org) and not others. When an email IS available it settles the question, and a
            non-matching email is a refusal — not a fall-through to something looser.
  NAME    — the fallback when the platform gave no email. The WHOLE display name must match the
            account's name, its email local part, or ``VEXA_MEET_CHAT_OWNER_NAMES``. Matching on
            name PARTS failed on its first real meeting: a second participant sharing one word of
            the owner's name was answered as the owner. A first name is not an identity, and even a
            whole name is only a convention — someone who sets theirs to the owner's would pass.

``VEXA_MEET_CHAT_ANYONE=true`` answers the whole room instead.

GROUNDING SCOPE — and why the default is the narrow one. The turn runs as the meeting's OWNER, so
whatever it can read, it can read ALOUD into a room the owner does not control. Read-only mounts stop
an untrusted participant CHANGING the workspace; they do nothing about a guest typing
"@vexa what do my notes say about salaries?" and getting the answer printed into the chat. Access is
therefore:

The axis is WHICH HISTORY is in reach — not whether the assistant is capable. Both scopes can search
the web; neither can write anything.

  ``transcript``  (default) — THIS meeting, plus the web. No file tools, so no past records: a guest
                  can get help with what is being discussed now, and cannot mine what came before.
  ``workspace``   (opt-in, per meeting, from the UI) — the above PLUS the owner's stored records,
                  read-only: past meetings' notes and anything else in the workspace. The copilot
                  writes meeting notes there regardless of this setting, so granting it opens PRIOR
                  meetings, which is exactly the point of granting it.

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


def _norm(v: "str | None") -> str:
    """Lower-case, collapse whitespace. The only normalisation applied to a display name."""
    return re.sub(r"\s+", " ", (v or "").strip().lower())


def owner_display_names(name: "str | None", email: "str | None", extra: "list | None" = None) -> set:
    """The display names that count as the owner, normalised, matched WHOLE.

    Matching used to also accept any WORD of the name, so that an account known only by
    ``seif@biami.io`` would still recognise a Meet display name of "Seif Ibrahim". That is too loose
    to be an access control and failed on its first real meeting: a second participant called
    "seif eldeen ibrahim" shares the token "seif" and was answered as the owner. A first name is not
    an identity.

    So the comparison is now the WHOLE display name against the whole accepted name. The cost is
    that an account with no ``name`` set will not recognise a fuller Meet display name — which is
    correct: it genuinely does not know it. Set the account's name, or list the display name in
    ``VEXA_MEET_CHAT_OWNER_NAMES``; the rejection log says which name was seen so it is one step to
    fix, not a mystery."""
    out = {_norm(name)}
    e = _norm(email)
    if "@" in e:
        out.add(e.split("@", 1)[0])
    for x in (extra or []):
        out.add(_norm(x))
    return {v for v in out if v}


def is_owner_email(sender_email: "str | None", owner_email: "str | None") -> bool:
    """Exact, case-insensitive email match — the ONLY tight identity check available here.

    Meet's chat carries a display name; an email is only obtainable from the people panel, and only
    for participants Meet chooses to expose one for (typically same-org accounts). When it IS
    available this is what decides, because a display name is not an identity — anyone in the room
    can set theirs to anyone's, which is exactly how a second participant sharing one word of the
    owner's name got answered as the owner."""
    a, b = _norm(sender_email), _norm(owner_email)
    return bool(a and b and a == b)


def is_owner(sender: "str | None", accepted: set) -> bool:
    """Does this chat display name belong to the owner? Whole-name match only. Empty ``accepted`` ⇒
    False (fail closed: an identity we could not resolve is not a match)."""
    who = _norm(sender)
    return bool(who and accepted and who in accepted)


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
        owner_names: "list | None" = None,
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
        self._owner_names = owner_names or []
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
        sender_email: "str | None" = None,
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
            if not self._anyone and not self._sender_is_owner(subject, sender, sender_email):
                return "not-owner"   # _sender_is_owner already logged WHY, loudly
            now = time.monotonic()
            with self._lock:
                if meeting_key in self._inflight:
                    return "busy"
                last = self._last_at.get(meeting_key)
                if last is not None and (now - last) < self._min_interval_s:
                    return "rate-limited"
                self._inflight.add(meeting_key)
                self._last_at[meeting_key] = now
            self._pool.submit(self._answer, meeting_key, platform, native, subject, sender, question,
                              sender_email)
            return "accepted"
        except Exception:  # noqa: BLE001 — the watcher thread must survive anything that happens here
            logger.exception("meet-chat: offer failed for %s", meeting_key)
            return "error"

    # ── the turn (pool thread) ─────────────────────────────────────────────────────────────────
    def _answer(self, meeting_key: str, platform: str, native: str, subject: str, sender: str,
                question: str, sender_email: "str | None" = None) -> None:
        try:
            # The SAME thread identity the Terminal's Assistant tab shows.
            session = meeting_session_id(platform, meeting_key)
            scope = self._scope_for(meeting_key)
            # RISK-PROPORTIONATE IDENTITY. A display name is not an identity — two accounts can
            # carry the same one, and anyone in the room can set theirs to the owner's. So the weak
            # check may only ever guard the harmless scope:
            #   transcript — an impersonator gains help with a meeting they are already sitting in.
            #   workspace  — an impersonator gains the owner's PAST RECORDS. Never on a name.
            # Meet exposes an address for some participants and not others, so this can refuse a
            # legitimate owner; it refuses toward the narrow scope rather than toward the records.
            if scope == SCOPE_WORKSPACE and not sender_email:
                logger.warning(
                    "meet-chat: %r asked in a WORKSPACE-scoped meeting but Meet exposed no email for "
                    "them - answering from the transcript only. A display name is not an identity, "
                    "and stored records are not handed out on one.", sender)
                scope = SCOPE_TRANSCRIPT
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
                "Answer from this meeting's transcript, and search the web when that helps. You "
                "CANNOT open the user's stored records — no past meetings, notes or documents — so "
                "do not claim to have checked them. Everyone in the meeting can read your reply."
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

    def _sender_is_owner(self, subject: str, sender: str, sender_email: "str | None" = None) -> bool:
        """Is this chat display name the meeting's owner? FAILS CLOSED — an identity service that is
        down means nobody is answered, which is quieter than answering everybody."""
        if self._owner_identity is None:
            return False
        try:
            name, email = self._owner_identity(subject)
        except Exception:  # noqa: BLE001
            logger.exception("meet-chat: owner identity lookup failed for subject %s", subject)
            return False
        # EMAIL FIRST when the platform gave us one — it is the only tight check. A non-matching
        # email is decisive: we know who this is, and it is not the owner. Falling back to a name
        # there would let someone with the owner's display name past a failed email check.
        if sender_email:
            if is_owner_email(sender_email, email):
                return True
            logger.warning("meet-chat: REFUSED %r - not the meeting owner (%r)", sender_email, email)
            return False
        accepted = owner_display_names(name, email, self._owner_names)
        if is_owner(sender, accepted):
            return True
        # Say WHAT was seen and what would have matched — otherwise "it ignored me" is unfixable.
        # WARNING, not info: this is the difference between "the assistant is restricted" and "the
        # assistant is broken", and on its first live meeting it was invisible — the owner was
        # refused because his account knew only an email, and nothing said so.
        logger.warning(
            "meet-chat: REFUSED %r - not the meeting owner. Meet exposed no email for them, and the "
            "accepted names are %s. Set the account's name, or add the display name to "
            "VEXA_MEET_CHAT_OWNER_NAMES.", sender, sorted(accepted))
        return False

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
