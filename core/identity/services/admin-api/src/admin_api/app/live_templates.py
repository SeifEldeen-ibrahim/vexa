"""Meeting-agenda templates: the named checklists a user keeps for a KIND of meeting.

Stored inside the identity-owned user document (``users.data["live_templates"]``), beside the
webhook and calendar namespaces, because a template belongs to the PERSON rather than to any one
meeting. That is the whole point of the feature: a weekly standup's agenda should outlive the
standup, follow the user to a new laptop, and survive reinstalling the extension.

Nothing here is a credential, so — unlike ``calendars`` — there is no masked representation: what
the user typed is what they read back.

PURE except for the HTTPExceptions it raises on bad input, which is how the sibling ``calendars``
module reports the same thing.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status

#: The namespace inside ``users.data``. Named for the lane, so it cannot collide with the
#: webhook / calendar / transcription keys that already live there.
DATA_KEY = "live_templates"

MAX_TEMPLATES = 40
MAX_NAME_CHARS = 80
MAX_ITEMS = 40
MAX_ITEM_CHARS = 300

_WS = re.compile(r"\s+")
#: A leading bullet or "1." numbering, pasted in from a document. Deliberately narrow: a bare
#: digit run is NOT a bullet, or "2026 budget review" would lose its year.
_BULLET = re.compile(r"^(?:[-*•·]|\d{1,2}[.)])\s+")


def _tidy(raw: Any, limit: int) -> str:
    text = _WS.sub(" ", str(raw if raw is not None else "")).strip()
    text = _BULLET.sub("", text).strip()
    return text[:limit]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(name: str) -> str:
    """A stable id derived from the name, so saving the same template twice updates it rather
    than piling up near-duplicates the user then has to clean out."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48]
    return f"t-{base}" if base else "t-untitled"


def normalize_template(raw: Any, *, existing: Optional[dict] = None) -> dict:
    """One template, cleaned and bounded. Raises 422 on input a user cannot have meant."""
    if not isinstance(raw, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="a template must be an object")

    name = _tidy(raw.get("name"), MAX_NAME_CHARS)
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="a template needs a name")

    raw_items = raw.get("items")
    if isinstance(raw_items, str):
        raw_items = raw_items.splitlines()
    if not isinstance(raw_items, list):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="items must be a list of lines")

    items: list[str] = []
    seen: set[str] = set()
    for line in raw_items:
        text = _tidy(line, MAX_ITEM_CHARS)
        if not text:
            continue
        key = text.lower()
        if key in seen:  # the same line twice is a typo, not two agenda points
            continue
        seen.add(key)
        items.append(text)
        if len(items) >= MAX_ITEMS:
            break
    if not items:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="a template needs at least one agenda line")

    template_id = _tidy(raw.get("id"), 64) or _slug(name)
    return {
        "id": template_id,
        "name": name,
        "items": items,
        # Keep the original creation time when updating in place: "created" is about the template,
        # not about this edit.
        "created_at": (existing or {}).get("created_at") or _now_iso(),
        "updated_at": _now_iso(),
    }


def templates_from_data(data: dict) -> list[dict]:
    """Read the user's templates out of the user document, dropping anything malformed rather
    than failing: a reader must never be blocked by one bad row written by an older client."""
    raw = (data or {}).get(DATA_KEY)
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = _tidy(item.get("name"), MAX_NAME_CHARS)
        items = [t for t in (_tidy(i, MAX_ITEM_CHARS) for i in (item.get("items") or [])) if t]
        template_id = _tidy(item.get("id"), 64)
        if not name or not items or not template_id:
            continue
        out.append({
            "id": template_id,
            "name": name,
            "items": items[:MAX_ITEMS],
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        })
    return out[:MAX_TEMPLATES]


def upsert_template(templates: list[dict], raw: Any) -> list[dict]:
    """Add a template, or replace the one with the same id. Newest first, so the list the user
    reads is ordered by what they touched last."""
    if not isinstance(raw, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="a template must be an object")
    # Work out the id the SAME way normalize_template will, because a template the user just
    # typed carries no id at all — only a name. Looking it up by a missing id would treat an
    # edit as a brand-new template and reset its created_at.
    target_id = _tidy(raw.get("id"), 64) or _slug(_tidy(raw.get("name"), MAX_NAME_CHARS))
    existing = next((t for t in templates if t["id"] == target_id), None)
    incoming = normalize_template(raw, existing=existing)
    rest = [t for t in templates if t["id"] != incoming["id"]]
    if len(rest) + 1 > MAX_TEMPLATES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"that would be more than {MAX_TEMPLATES} templates — delete one first",
        )
    return [incoming, *rest]


def remove_template(templates: list[dict], template_id: Any) -> list[dict]:
    wanted = _tidy(template_id, 64)
    return [t for t in templates if t["id"] != wanted]


def store_templates(data: dict, templates: list[dict]) -> dict:
    """Merge the templates back into the user document, touching no other namespace."""
    merged = dict(data or {})
    merged[DATA_KEY] = templates
    return merged
