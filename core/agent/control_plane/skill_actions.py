"""skill_actions — writing a product document into the owner's own repo, and pushing it.

WHY THIS IS IN THE CONTROL PLANE and not in the tool that asks for it. The tool runs inside the
worker container, whose input is untrusted by design: anyone in a Google Meet can address the
assistant. Two things follow, and both were found by review rather than by taste:

  * The GitHub token must not go there. The harness passes its whole environment to the CLI and to
    the MCP server it spawns, and an ordinary chat turn has `Bash` — so a token stamped into the
    worker env is a token the model can print. It stays here, where it already lives.
  * A writable mount cannot be the boundary either. `write: false` becomes a kernel `:ro` bind, so
    the tool could not write; and mounting it writable means the harness auto-commits that repo
    after EVERY turn, putting unrelated Vexa commits into the user's product repo forever.

So the tool asks, and this does the work: pull, validate, write, commit, push, with the owner's own
credential, on a clone this process already owns.

ORDER MATTERS. `pull_origin` refuses when the local clone is ahead, so "commit, then push, then pull
on rejection" DEADLOCKS — and leaves the clone permanently wedged, breaking the Terminal's git panel
too. The pull happens FIRST, while the clone is still clean.
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from shared.gitenv import scrubbed_git_env

log = logging.getLogger(__name__)

#: Where each product's documents live in its repo.
PARTIC_DIR = "pipelines"
BIAMI_DIR = "temp"

#: A document name we derive from what the model called the thing. Never a path: the model supplies
#: a NAME, we supply the location, so there is no traversal argument to defend.
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class ActionResult:
    """What happened, in a shape the meeting can be told about.

    ``status`` is a fixed vocabulary — never a passthrough of git's stderr, which carries the remote
    URL and, on a failed auth, the token. ``message`` is written to be read ALOUD in a room the
    owner does not control: it names no repo, no path, no branch and no sha."""

    status: str          # written | not-linked | invalid | conflict | failed
    message: str
    detail: str = ""     # for the log and the Assistant tab, never for the room


def slugify(name: str, *, fallback: str = "untitled") -> str:
    s = _SLUG_STRIP.sub("-", (name or "").strip().lower()).strip("-")
    return (s[:48].strip("-") or fallback)


def _git(repo: Path, *args: str) -> str:
    out = subprocess.run(["git", *args], cwd=str(repo), env=scrubbed_git_env(),
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[:400])
    return (out.stdout or "").strip()


def write_document(repo: Path, relpath: str, content: str, *, message: str,
                   author: "tuple | None" = None) -> str:
    """Write one file and commit it. Returns the commit sha.

    Refuses to overwrite. Two meetings can be running, a name can repeat, and silently rewriting a
    document someone is already using is not a recoverable mistake — the caller disambiguates the
    name instead."""
    target = (Path(repo) / relpath).resolve()
    root = Path(repo).resolve()
    if not str(target).startswith(str(root) + "/"):
        raise ValueError("refusing to write outside the pinned repo")
    if target.exists():
        raise FileExistsError(relpath)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _git(repo, "add", "--", relpath)
    args = ["commit", "-m", message]
    if author:
        args += ["--author", f"{author[0]} <{author[1]}>"]
    _git(repo, *args)
    return _git(repo, "rev-parse", "HEAD")


def rollback(repo: Path, sha: str) -> None:
    """Undo a commit that could not be pushed.

    Leaving it is what wedges the clone: `pull_origin` refuses while the local is ahead, so the next
    attempt can neither push nor pull, and the Terminal's git panel breaks with it."""
    try:
        _git(repo, "reset", "--hard", f"{sha}~1")
    except Exception:  # noqa: BLE001
        log.exception("could not roll back %s in %s", sha, repo)


def partic_document_name(document: dict) -> str:
    meta = document.get("metadata") if isinstance(document, dict) else None
    return slugify((meta or {}).get("name") or "", fallback="pipeline")


def unique_relpath(repo: Path, directory: str, base: str, suffix: str, *, token: str = "") -> str:
    """A path inside ``directory`` that does not exist yet.

    The discriminator is the TURN's own token rather than a counter: two meetings racing would both
    pick "-2", and a counter makes the collision more likely rather than less."""
    first = f"{directory}/{base}{suffix}"
    if not (Path(repo) / first).exists():
        return first
    marked = f"{directory}/{base}-{slugify(token, fallback='x')[:8]}{suffix}"
    if not (Path(repo) / marked).exists():
        return marked
    raise FileExistsError(first)
