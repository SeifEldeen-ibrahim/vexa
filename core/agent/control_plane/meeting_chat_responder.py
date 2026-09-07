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
  ``workspace``   requires a verified email OR a display name the ROSTER confirms is unique in this
                  room. A bare name is not enough; an unverifiable one narrows the turn to
                  ``transcript`` rather than refusing it. Requiring an email outright was tried and
                  was wrong — Meet exposes one so rarely that the workspace grant became unreachable,
                  which is a worse failure than the one it prevented.

Identity, in order of strength — and the top rung is the reason this module exists:

  GOOGLE  the Meet REST API says which ACCOUNT each participant in the room is. It settles the
          question in both directions: a non-owner account is refused outright, and two accounts on
          one display name are refused out loud. Requires the owner's one-time read-only grant.



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

#: What the assistant says when two people in the room share the asker's display name. It SPEAKS
#: rather than going quiet: silence reads as a broken bot, and the person deserves to know why they
#: were refused and that it is not personal.
AMBIGUOUS_NAME_REPLY = (
    "I can't answer that one. Two people in this meeting are using the name {name}, and a chat "
    "message only carries a name — so I can't tell which of you sent it, and one of you might be "
    "the meeting owner. Google Meet has no private replies, so I won't guess. Rename one account, "
    "or the owner can allow anyone to ask from the meeting's panel in Vexa."
)

#: Words that carry no proposal-identity. Two offers to build the same thing rarely share a
#: phrasing, but they always share the nouns.
_PROPOSAL_NOISE = frozenset((
    "shall", "i", "you", "your", "the", "a", "an", "and", "or", "of", "to", "in", "into", "from",
    "for", "on", "at", "by", "with", "that", "this", "it", "is", "are", "be", "do", "want", "would",
    "like", "me", "we", "us", "so", "can", "could", "should", "create", "make", "build", "set", "up",
))


def proposal_fingerprint(text: str) -> frozenset:
    """The content words of a proposal, as a set.

    A copilot beat has no memory of the beat before it — each one sees a transcript window and
    proposes afresh — so the same need gets offered twice in different words: "moves the data from
    your customers table into your leads table" and "syncs your customers table into the leads
    table". Titles differ, wording differs, and the nouns do not. That is what is compared."""
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return frozenset(w for w in words if w not in _PROPOSAL_NOISE and len(w) > 2)


def is_same_proposal(a: str, b: str, *, overlap: float = 0.6) -> bool:
    """Are these two proposals asking for the same thing? Compared against the SMALLER of the two,
    so a terse restatement of a long proposal still counts as a repeat."""
    fa, fb = proposal_fingerprint(a), proposal_fingerprint(b)
    if not fa or not fb:
        return False
    return len(fa & fb) / min(len(fa), len(fb)) >= overlap


#: Grounding scopes. `transcript` is the default and the safe one — see GROUNDING SCOPE above.
SCOPE_TRANSCRIPT = "transcript"
SCOPE_WORKSPACE = "workspace"

#: What each scope may DO — the `unit.v1.tools` list an in-meeting turn is dispatched with.
#:
#: The two scopes differ by WHAT HISTORY is in reach, not by whether the assistant is capable. The
#: web is on in both — an assistant that cannot look anything up is not an assistant, and nothing
#: private leaks through a search engine.
#:
#:   transcript — THIS meeting, plus the web. No file tools, so no past records.
#:   workspace  — the above PLUS the owner's stored records (past meetings, notes), read-only.
#:
#: Write/Edit/Bash are absent from BOTH: the request comes from a room the owner does not control,
#: so the assistant answers and never changes anything IN THE WORKSPACE.
#:
#: `product-actions` is the exception, and a deliberate one: it is a `tool.v1` toolbelt name (the
#: worker resolves it against the tool registry into an MCP attachment) whose every tool is one
#: outbound HTTP call to a product's own endpoint, which owns whatever gets created. It is on in
#: both scopes because doing what was agreed to is not a question of how much history may be read —
#: the copilot proposed it out loud in the room, and someone the owner gate accepted said yes.
MEET_CHAT_ACTION_TOOLS = ["product-actions"]
MEET_CHAT_WEB_TOOLS = ["WebSearch", "WebFetch"]
MEET_CHAT_WORKSPACE_TOOLS = ["Read", "Glob", "Grep"] + MEET_CHAT_WEB_TOOLS


def meet_chat_tools(scope: str, skill_ids=None) -> list:
    """The tools an in-meeting turn is dispatched with.

    The action toolbelt is ALWAYS attached, and what it offers is decided inside it, live. That is
    not laziness about the gate — it is the only thing that can be correct here. A worker serves a
    whole meeting and its environment is frozen at container creation, so a decision made here, once,
    is a decision made with whatever was enabled when the first message arrived: turning a product on
    mid-meeting would do nothing until the worker was reaped.

    So the server asks the control plane which products its meeting currently allows, every time it
    is started — which is once per turn — and lists nothing when it cannot confirm. A meeting with
    nothing enabled therefore attaches a server that offers no tools, rather than no server; the
    property that matters (a model is never shown a product its owner did not grant) holds either
    way, and this one also holds a minute after the toggle.

    The two scopes still differ only by how much HISTORY is in reach, and both can act."""
    base = list(MEET_CHAT_WORKSPACE_TOOLS if scope == SCOPE_WORKSPACE else MEET_CHAT_WEB_TOOLS)
    return base + MEET_CHAT_ACTION_TOOLS


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

    The address may sit ANYWHERE in the line, not only at the front. People write "welcome @vexa how
    are you?" and "so @vexa, what did we decide?" — leading-only matching ignored both, silently, and
    a bot that ignores you when you have plainly addressed it reads as broken rather than as strict.
    The address is cut out and the rest is stitched back together, so the model sees the sentence the
    person wrote rather than a salutation it has to parse around.

    A bare address with no question ("@vexa") returns None: there is nothing to answer, and replying
    "yes?" into a meeting is noise."""
    body = (text or "").strip()
    if not body:
        return None
    lower = body.lower()
    # Longest first: "@vexa" must win over "vexa", or the bare name would match inside the prefix
    # and leave a stray "@" at the head of the question.
    tokens = sorted({t.strip() for t in (prefix, f"@{bot_name}".strip(), bot_name.strip()) if t.strip()},
                    key=len, reverse=True)
    for t in tokens:
        at = lower.find(t.lower())
        if at < 0:
            continue
        # Only on a word boundary: "vexatious" is not an address, and neither is a name inside
        # another word. The prefix carries its own boundary in the "@".
        before_ok = at == 0 or not (body[at - 1].isalnum() or body[at - 1] == "@")
        end = at + len(t)
        after_ok = end >= len(body) or not body[end].isalnum()
        if not (before_ok and after_ok):
            continue
        head = body[:at].rstrip(" ,:;-–—")
        rest = body[end:].lstrip(" ,:;-–—")
        joined = f"{head} {rest}".strip() if head and rest else (head or rest)
        return joined or None
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
        anyone_for: Optional[Callable[[str], bool]] = None,
        owner_identity: Optional[Callable[[str], "tuple"]] = None,
        meet_identity: Optional[Callable[[str, str, str], dict]] = None,
        owner_names: "list | None" = None,
        pending_suggestion: Optional[Callable[[str], "str | None"]] = None,
        suggestion_answered: Optional[Callable[[str], None]] = None,
        skills_for: Optional[Callable[[str], list]] = None,
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
        self._anyone_for = anyone_for
        self._owner_identity = owner_identity
        self._meet_identity = meet_identity
        self._owner_names = owner_names or []
        self._pending_suggestion = pending_suggestion
        self._suggestion_answered = suggestion_answered
        self._skills_for = skills_for
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
        sender_ambiguous: bool = False,
        sender_name_unique: "bool | None" = None,
    ) -> str:
        """Consider one ``source:'chat'`` segment. Returns a verdict string (for logs and tests);
        never raises, never blocks, and never runs the turn on the caller's thread.

        Verdicts: ``not-addressed`` · ``no-owner`` · ``ambiguous-name`` · ``not-owner`` · ``busy`` ·
        ``rate-limited`` · ``accepted``.
        """
        try:
            question = addressed_question(text, bot_name=self._bot_name, prefix=self._prefix, always=self._always)
            if not question:
                return "not-addressed"
            # The deployment default, widened per meeting from the UI.
            anyone = self._anyone or self._meeting_allows_anyone(meeting_key)
            # FAIL CLOSED. Without the owner we cannot attribute the turn, and the alternative —
            # a placeholder subject — answers out of a workspace that belongs to nobody.
            subject = str(owner).strip() if owner not in (None, "") else ""
            if not subject:
                self._log(f"meet-chat: no ownerUserId on {platform}/{native} — refusing to answer "
                          f"(a placeholder subject would answer from the wrong workspace)")
                return "no-owner"
            # ── the identity ladder ────────────────────────────────────────────────────────
            # GOOGLE FIRST, when the deployment has the owner's grant. It is the only source that
            # knows which ACCOUNT a participant is, rather than what they have called themselves,
            # and its verdict settles the question in both directions: `matched` means an account
            # was identified, and a non-owner account is refused outright rather than falling
            # through to a name comparison the impersonator would pass.
            # Asked EVEN IN `anyone` mode. Opening the room decides who may ASK; it says nothing
            # about who this person IS, and the archive still turns on identity. Skipping the lookup
            # here meant enabling "anyone can ask" silently disabled workspace access for the owner
            # too — the exact combination the owner tried first.
            meet = self._meet_verdict(subject, native, sender)
            meet_status = meet.get("status")
            if meet_status == "matched":
                if not meet.get("is_owner") and not anyone:
                    logger.warning("meet-chat: REFUSED %r - Google says that is account %s, not the "
                                   "meeting owner", sender, meet.get("user_id"))
                    return "not-owner"
                # Only the OWNER's own verified account unlocks the owner's archive. A different
                # account, admitted because the room is open, is identified but not entitled.
                identity_verified = bool(meet.get("is_owner"))
                # Logged on SUCCESS too. Only mismatches were logged, so a working resolve left no
                # trace at all — and "did Google identify me?" could not be answered from the logs,
                # which is exactly the question asked after every test run.
                logger.info("meet-identity: %r is account %s (owner=%s)",
                            sender, meet.get("user_id"), meet.get("is_owner"))
            elif meet_status == "ambiguous" and not anyone:
                # Google can SEE two accounts on this name. That is the strongest possible evidence
                # that the message cannot be attributed — say so out loud.
                logger.warning("meet-chat: REFUSED %r - Google reports two accounts in this meeting "
                               "using that display name", sender)
                try:
                    self._post_reply(str(owner), platform, native,
                                     AMBIGUOUS_NAME_REPLY.format(name=sender))
                except Exception:  # noqa: BLE001
                    logger.exception("meet-chat: could not post the ambiguous-name notice")
                return "ambiguous-name"
            elif meet_status == "anonymous" and not anyone:
                logger.warning("meet-chat: REFUSED %r - an unauthenticated guest, so that name has "
                               "no account behind it", sender)
                return "not-owner"
            else:
                identity_verified = False   # unconfigured / unavailable / unknown / no-grant

            # AMBIGUOUS NAME, as the PAGE saw it. Only consulted when Google could not answer —
            # otherwise the roster above is both more authoritative and more complete.
            if not identity_verified and sender_ambiguous and not sender_email and not anyone:
                logger.warning("meet-chat: REFUSED %r - two participants share that display name", sender)
                try:
                    self._post_reply(str(owner), platform, native,
                                     AMBIGUOUS_NAME_REPLY.format(name=sender))
                except Exception:  # noqa: BLE001 — explaining is best effort; the refusal stands
                    logger.exception("meet-chat: could not post the ambiguous-name notice")
                return "ambiguous-name"
            # WHO MAY ASK. Skipped when Google already said this IS the owner.
            if not anyone and not identity_verified \
                    and not self._sender_is_owner(subject, sender, sender_email):
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
            # A guest is here because the OWNER opened the room. The turn has to be told that:
            # it runs as the owner, in the owner's thread, and left to infer who it serves it
            # concludes "the owner" and politely refuses the very person the gate just admitted.
            asker_is_owner = identity_verified or not anyone or self._sender_is_owner(
                subject, sender, sender_email)
            self._pool.submit(self._answer, meeting_key, platform, native, subject, sender, question,
                              sender_email, sender_name_unique, identity_verified, asker_is_owner)
            return "accepted"
        except Exception:  # noqa: BLE001 — the watcher thread must survive anything that happens here
            logger.exception("meet-chat: offer failed for %s", meeting_key)
            return "error"

    # ── the turn (pool thread) ─────────────────────────────────────────────────────────────────
    def _answer(self, meeting_key: str, platform: str, native: str, subject: str, sender: str,
                question: str, sender_email: "str | None" = None,
                sender_name_unique: "bool | None" = None,
                identity_verified: bool = False, asker_is_owner: bool = True) -> None:
        try:
            # The SAME thread identity the Terminal's Assistant tab shows.
            session = meeting_session_id(platform, meeting_key)
            scope = self._scope_for(meeting_key)
            # RISK-PROPORTIONATE IDENTITY. A display name alone is not an identity — anyone in the
            # room can set theirs to the owner's — so the archive is not opened on a bare name. But
            # requiring an EMAIL made the workspace grant unreachable in practice: Meet exposes no
            # address for most accounts, so the toggle could be switched on and never do anything.
            # That is a worse failure than the one it prevented, and it shipped.
            #
            # What actually settles it is whether the name identifies ONE person in this room:
            #   verified email        — decisive.
            #   name unique in roster — nobody else here answers to it, so within this room it
            #                           identifies them. A rename to the owner's name makes it
            #                           NON-unique, which is refused outright above.
            #   no roster at all      — unknown, not "unique". Narrow, and say why.
            # A Google-verified account is the strongest identity there is, so it opens the archive
            # on its own — that is the whole reason for building the Meet identity path.
            if scope == SCOPE_WORKSPACE and not identity_verified \
                    and not sender_email and not sender_name_unique:
                logger.warning(
                    "meet-chat: %r asked in a WORKSPACE-scoped meeting with no verified email and no "
                    "roster confirming their name is unique here - answering from the transcript "
                    "only. Stored records are not opened on an unverifiable name.", sender)
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
                "The meeting owner has given you access to their workspace for this meeting. USE "
                "IT: read their notes and past meeting records to answer, and search the web when "
                "that helps. Do not say you cannot open past meetings — you can, and you were asked "
                "to. You cannot CHANGE anything (no write or shell tools), so do not offer to edit "
                "or create files.\n"
                "Your reply is visible to everyone in the meeting. That is a reason to answer the "
                "question asked and not to volunteer unrelated private material — it is NOT a reason "
                "to refuse the owner. If something looks genuinely sensitive for a room, say so "
                "briefly and answer what you can."
            )
            # WHO THIS PERSON IS TO YOU. The turn runs as the owner, in the owner's thread, reading
            # the owner's workspace — so with nothing said, the model concludes it serves the owner
            # and answers anyone else with a polite refusal. That is the assistant overriding a
            # decision the owner already made in the UI: the gate above is what decides who may ask,
            # and by the time a question reaches here it has been decided.
            standing = "" if asker_is_owner else (
                f"{who} is not the meeting owner. The owner has opened this assistant to everyone "
                "in this meeting, so this is a person you serve — answer their question directly "
                "and do not tell them you only take instructions from the owner. Their access is "
                "narrower, not lesser: you answer them from this meeting and the web, never from "
                "the owner's stored records.\n\n"
            )
            prompt = (
                f"{who} asked in the meeting chat: {question}\n\n"
                f"{standing}"
                f"{self._pending_clause(meeting_key)}"
                f"{scoped} Be brief — a few sentences at most, plain text, no markdown formatting. "
                "If you do not have the answer, say so plainly."
            )
            # Whatever they said — yes, no, or something else entirely — the proposal has now been
            # put in front of someone and answered. Closed BEFORE the turn, so a slow or failed
            # turn cannot leave it open to be re-asked on the next message.
            if self._pending_suggestion is not None and self._suggestion_answered is not None:
                try:
                    self._suggestion_answered(meeting_key)
                except Exception:  # noqa: BLE001
                    logger.exception("meet-chat: could not close the proposal for %s", meeting_key)
            # WHICH PRODUCTS THIS TURN MAY ACT ON. Only for someone the gate identified as the
            # owner: `anyone` decides who may ASK, and letting it also decide who may commit to the
            # owner's repo would make a switch about conversation into a switch about their GitHub
            # account. A guest is answered; a guest does not get the tools.
            skills = self._skills_now(meeting_key) if asker_is_owner else []
            reply = self._run_turn(subject, session, focus, prompt, question, scope, skills)
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

    def _pending_clause(self, meeting_key: str) -> str:
        """The proposal this meeting is waiting on, phrased for the prompt — or "" when there is none.

        The copilot's suggestion is posted into the room by the RELAY, not by an agent turn, so the
        assistant has no memory of having offered anything. Without this, "@vexa yes" arrives as a
        word with no referent and the assistant asks what is meant — in a meeting, that reads as the
        bot having forgotten its own question ten seconds later.

        Deliberately not an approval PARSER. Whether "yes", "go on then" or "no, drop it" is
        agreement is a judgement about language, which is what the model is for; what it cannot do
        is know what was proposed. Only the gate above decides WHO may agree."""
        if self._pending_suggestion is None:
            return ""
        try:
            pending = (self._pending_suggestion(meeting_key) or "").strip()
        except Exception:  # noqa: BLE001
            logger.exception("meet-chat: pending-proposal lookup failed for %s", meeting_key)
            return ""
        if not pending:
            return ""
        return (
            f"CONTEXT: you recently offered in this chat: \"{pending}\" and nobody has answered yet. "
            "If what they just said is AGREEMENT to that, carry it out now — call the matching "
            "product-actions tool with a description built from what was proposed, and say what came "
            "back in one line. If it is a refusal, acknowledge it in a few words and do nothing "
            "else. If it is neither, ignore this paragraph and answer their question.\n\n"
        )

    def _meeting_allows_anyone(self, meeting_key: str) -> bool:
        """Has this meeting's owner opened the assistant to everyone in the room? Fails closed."""
        if self._anyone_for is None:
            return False
        try:
            return bool(self._anyone_for(meeting_key))
        except Exception:  # noqa: BLE001
            logger.exception("meet-chat: anyone-grant lookup failed for %s", meeting_key)
            return False

    def _meet_verdict(self, subject: str, native: str, sender: str) -> dict:
        """Google's verdict on who this sender is. Any fault is 'unavailable' — never a match."""
        if self._meet_identity is None:
            return {"status": "unconfigured", "is_owner": False}
        try:
            return self._meet_identity(subject, native, sender) or {"status": "unavailable", "is_owner": False}
        except Exception:  # noqa: BLE001
            logger.exception("meet-chat: Meet identity lookup failed for %s/%s", subject, native)
            return {"status": "unavailable", "is_owner": False}

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

    def _skills_now(self, meeting_key: str) -> list:
        """The products enabled for this meeting. Any fault ⇒ none: a turn that cannot confirm what
        it may act on must not act."""
        if self._skills_for is None:
            return []
        try:
            return list(self._skills_for(meeting_key) or [])
        except Exception:  # noqa: BLE001
            logger.exception("meet-chat: skill lookup failed for %s", meeting_key)
            return []

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
