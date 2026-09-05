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

ADDRESSING IS NOT AUTHORIZATION. The ``@vexa`` prefix decides whether a line is meant for the bot.
It is a spam and cost filter — anyone in the room can type it — not a permission check.
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
      ``run_turn(subject, session, focus, prompt) -> str``  — one agent turn, returns the reply text.
      ``post_reply(platform, native, text) -> bool``        — deliver one message into the meeting.
    """

    def __init__(
        self,
        *,
        run_turn: Callable[[str, str, dict, str], str],
        post_reply: Callable[[str, str, str], bool],
        bot_name: str = "Vexa",
        prefix: str = "@vexa",
        always: bool = False,
        max_workers: int = 2,
        min_interval_s: float = 5.0,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._run_turn = run_turn
        self._post_reply = post_reply
        self._bot_name = bot_name
        self._prefix = prefix
        self._always = always
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

        Verdicts: ``not-addressed`` · ``no-owner`` · ``busy`` · ``rate-limited`` · ``accepted``.
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
            # The SAME thread identity the Terminal's Assistant tab shows, keyed on the ROW id so two
            # owners of one native code never share a conversation.
            session = f"meet:{platform}/{meeting_key}"
            focus = {
                "kind": "meeting",
                "platform": platform,
                "native_id": native,
                "meeting_id": meeting_key,
                "status": "active",
            }
            # Name the asker: several people share this chat, so "who wants this" is part of the ask.
            prompt = (
                f"{sender} asked in the meeting chat: {question}\n\n"
                "Answer them in the meeting chat. Be brief — a few sentences at most, plain text, no "
                "markdown formatting. If the transcript does not contain the answer, say so plainly."
            )
            reply = self._run_turn(subject, session, focus, prompt)
            body = strip_markdown(reply or "")
            if not body:
                self._log(f"meet-chat: empty reply for {platform}/{native} — posting nothing")
                return
            for chunk in chunk_reply(body):
                if not self._post_reply(platform, native, chunk):
                    self._log(f"meet-chat: reply delivery failed for {platform}/{native}")
                    break
            self._log(f"meet-chat: answered {sender} in {platform}/{native} ({len(body)} chars)")
        except Exception:  # noqa: BLE001 — a failed turn must not take the pool thread down
            logger.exception("meet-chat: turn failed for %s", meeting_key)
        finally:
            with self._lock:
                self._inflight.discard(meeting_key)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
