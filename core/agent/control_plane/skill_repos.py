"""skill_repos.py — which of the user's OWN repos backs each repo-backed skill.

A repo-backed skill (Partic, BIAMI) acts by writing a document into a git repo the user already
owns: the product reads from that repo, so authoring is a commit and there is nothing for this
deployment to execute. Which repo is a per-user choice made once in Settings, so this is the pin.

Stored beside the git token store (``.secrets/<subject>.skillrepos.json``) rather than inside a
workspace, for the same two reasons: a dot-dir is skipped by every workspace scan, and it is not a
git tree, so a pin can never land in a commit.

WHAT IS HELD HERE IS NOT A SECRET — a slug, a repo URL, a ref. The credential that reaches those
repos is the single per-user token in ``git_credentials``. Keeping them apart means a pin can be
read and shown in the UI without the token ever being near that path.

A product repo is NOT a Vexa workspace, and the difference is the whole reason this clones for
itself instead of calling ``activate_workspace``. That function folds a repo INTO the workspace
model: a repo that is not workspace-shaped gets wrapped in a fresh template, nested under ``kg/``,
and has **its own .git dropped**. Which is right for a workspace and fatal here — the wrapper has no
remote and the nested copy is no longer a repo, so there is nothing to pull from and nothing to push
to. Observed on both of the first two repos anyone pinned.

It also keeps the clone OUT of every workspace, which is the isolation that matters: a repo inside a
workspace is readable by any turn that mounts it, and a workspace-scoped assistant has a Read tool.
The control plane reads these on the meeting's behalf and hands over only what is enabled.

CROSS-USER ISOLATION: every read and write is keyed by ``subject`` and lands under that subject's own
directory. Two users pinning the same repo URL get two independent clones and never see each other's.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Optional

from shared import skills

log = logging.getLogger(__name__)

_SECRETS_DIRNAME = ".secrets"
#: Where product repos are cloned — dot-prefixed, so every workspace scan skips it and it can never
#: be mistaken for a subject or mounted as one.
_REPOS_DIRNAME = ".skillrepos"
_SUBJECT_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
#: A workspace slug as workspace_attach mints them — kept strict because it becomes a path segment.
#: It must START alphanumeric: dots are legal INSIDE a slug, and a character class that allows them
#: anywhere accepts ".." — which is a path segment that leaves the store entirely. Caught by its own
#: test, which is why the rule is a leading-character rule rather than a longer deny-list.
_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _pins_path(root: str | Path, subject: str) -> Optional[Path]:
    if not subject or not _SUBJECT_RE.match(subject):
        return None
    return Path(root) / _SECRETS_DIRNAME / f"{subject}.skillrepos.json"


def read_pins(root: str | Path, subject: str) -> dict:
    """``{skill_id: {"slug", "repo", "ref"}}`` for this subject. Unset/unreadable ⇒ ``{}``.

    On the dispatch hot path, so a missing file is simply "nothing pinned", never an error. Unknown
    skill ids are dropped on the way out: a build that no longer ships a skill must not hand its pin
    to anything."""
    p = _pins_path(root, subject)
    if p is None:
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict = {}
    for sid in skills.known(list(data)):
        entry = data.get(sid)
        if isinstance(entry, dict) and entry.get("slug"):
            out[sid] = {"slug": str(entry["slug"]), "repo": str(entry.get("repo") or ""),
                        "ref": str(entry.get("ref") or "main")}
    return out


def pin(root: str | Path, subject: str, skill_id: str, *, slug: str, repo: str = "",
        ref: str = "main") -> dict:
    """Pin one skill to one of the subject's workspaces. Returns the full pin set afterwards."""
    skill = skills.get(skill_id)
    if skill is None:
        raise ValueError(f"unknown skill {skill_id!r}")
    if not skill.repo_backed:
        raise ValueError(f"{skill.id} is not repo-backed")
    if not slug or not _SLUG_RE.match(slug):
        raise ValueError("invalid slug")
    p = _pins_path(root, subject)
    if p is None:
        raise ValueError("invalid subject")
    pins = read_pins(root, subject)
    pins[skill.id] = {"slug": slug, "repo": repo or "", "ref": ref or "main"}
    _write(p, pins)
    return pins


def unpin(root: str | Path, subject: str, skill_id: str) -> dict:
    """Remove one pin. Unknown or unpinned is a no-op — unpinning twice is not an error."""
    p = _pins_path(root, subject)
    if p is None:
        raise ValueError("invalid subject")
    pins = read_pins(root, subject)
    if pins.pop((skill_id or "").strip().lower(), None) is None:
        return pins          # nothing pinned — do not create a store to record an absence
    _write(p, pins)
    return pins


def slugs_for(root: str | Path, subject: str, skill_ids) -> list:
    """The workspace slugs backing these enabled skills, in registry order, de-duplicated.

    This is the mount ALLOWLIST for a turn: a user with Partic and BIAMI pinned who enabled only
    Partic for this meeting gets the Partic repo and nothing else. A skill with no pin contributes
    nothing rather than falling back to some other repo — the assistant then says it is not linked,
    which is a fixable answer, where acting on the wrong repo is not."""
    pins = read_pins(root, subject)
    out: list = []
    for sid in skills.known(skill_ids):
        entry = pins.get(sid)
        if entry and entry["slug"] not in out:
            out.append(entry["slug"])
    return out


def missing_pins(root: str | Path, subject: str, skill_ids) -> list:
    """Enabled repo-backed skills with nothing pinned — what the UI warns about and what the
    assistant reports as "not linked" instead of failing."""
    pins = read_pins(root, subject)
    return [sid for sid in skills.known(skill_ids)
            if skills.get(sid).repo_backed and sid not in pins]


def _write(path: Path, pins: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(pins, indent=1, sort_keys=True), encoding="utf-8")
    try:
        path.chmod(0o600)
        path.parent.chmod(0o700)
    except OSError:
        log.debug("could not chmod skill-repo pins", exc_info=True)


def repo_dir(root: str | Path, subject: str, slug: str) -> Optional[Path]:
    """Where this subject's clone of a product repo lives. None for an unsafe subject or slug."""
    if not subject or not _SUBJECT_RE.match(subject):
        return None
    if not slug or not _SLUG_RE.match(slug):
        return None
    return Path(root) / _REPOS_DIRNAME / subject / slug


def repo_for(root: str | Path, subject: str, skill_id: str) -> Optional[Path]:
    """The clone backing this skill for this subject, or None when nothing is pinned or present."""
    pin = read_pins(root, subject).get((skill_id or "").strip().lower())
    if not pin:
        return None
    d = repo_dir(root, subject, pin["slug"])
    return d if d and (d / ".git").is_dir() else None


def slug_for_repo(repo_url: str) -> str:
    """A stable directory name for a repo URL: its own name plus a short digest of the full URL.

    The name alone would collide across owners — two `biamiDev` repos from different orgs are not
    the same repo — and the digest alone would be unreadable in a path someone has to debug."""
    import hashlib

    tail = (repo_url or "").rstrip("/").rsplit("/", 1)[-1]
    if tail.endswith(".git"):
        tail = tail[:-4]
    base = re.sub(r"[^A-Za-z0-9]+", "-", tail).strip("-").lower() or "repo"
    digest = hashlib.sha256((repo_url or "").encode()).hexdigest()[:8]
    return f"{base}-{digest}"
