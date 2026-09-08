"""partic_document — check a `partic.pipeline/v1` document BEFORE it is committed.

Partic's own authoring contract says its import gate "never repairs your document — it only
rejects", with a coded reason. Those rejections happen out of band, after our push, where nobody in
the meeting will ever see them: the room would be told the pipeline was written and then nothing
would appear. So the checks Partic states are run here, against the document the model just wrote,
while the turn can still say what is wrong.

WHAT THIS DELIBERATELY DOES NOT DO is guess. Two whole rejection classes are not derivable from the
document — Partic's own canonicalisation of aliases and field names, and rules like "a union target
must exist in the first input schema" (found in the repo's history as a fix commit, absent from the
contract). Approximating those would reject documents Partic accepts, which is worse than the round
trip. Everything checked here is a rule the contract states literally.

Cross-checking against `connectors/*.json` is the one addition, and it earns its place: the most
likely model error is inventing a connector that does not exist in this project, and the repo
carries the real list.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

FORMAT = "partic.pipeline/v1"

#: The envelope's keys, exactly. The contract: "any other top-level key is rejected".
ENVELOPE_KEYS = {"connector_bindings", "definition", "format", "metadata"}

#: A connector ref is a name the author INVENTS. A UUID cannot match, which is the contract's
#: first rule and its `invalid_ref` code.
REF_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

#: The nine operation types. `unnest` is rejected BY NAME — importing one would not produce the
#: pipeline the document describes.
OPERATION_TYPES = {"enrich_api", "extract", "field_map", "filter", "formula", "join", "object",
                   "union", "web_search"}
PASSTHROUGH_TYPES = {"field_map", "formula", "object"}
PASSTHROUGH_KEYS = {"id", "type", "input_schema_id"}
LEGACY_TYPES = {"unnest"}

RUN_CONFIG_KEYS = {"batch_size", "max_parallelism", "on_node_failure", "sync_mode"}

#: Size caps, from the contract.
CAPS = {"connector_bindings": 25, "sources": 25, "destinations": 25, "mappings": 50,
        "operations_per_mapping": 50, "operations_total": 500}


def _is_uuidish(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                             r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", str(value or "")))


def load_connectors(repo: Path) -> list:
    """The project's real connectors, from `connectors/*.json` in the pinned repo.

    Partic writes these INTO the repo, so they are current by construction. An unreadable or absent
    directory yields an empty list and the connector cross-check is skipped — a missing file must
    not reject a document that Partic would accept."""
    out: list = []
    d = Path(repo) / "connectors"
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.json")):
        try:
            data = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("connector_type_id"):
            out.append({"id": str(data.get("id") or ""), "name": str(data.get("name") or ""),
                        "connector_type_id": str(data["connector_type_id"])})
    return out


def validate(document: dict, connectors: "list | None" = None) -> list:
    """Reasons this document would be rejected, as human sentences. Empty ⇒ nothing we can see.

    "Nothing we can see" is the honest claim, and the caller must phrase it that way: Partic still
    has rules of its own, and a clean result here means the document is worth pushing rather than
    that it will import."""
    errors: list = []
    if not isinstance(document, dict):
        return ["the document is not a JSON object"]

    extra = set(document) - ENVELOPE_KEYS
    if extra:
        errors.append(f"unknown top-level keys: {', '.join(sorted(extra))} "
                      f"(only {', '.join(sorted(ENVELOPE_KEYS))} are allowed)")
    missing = ENVELOPE_KEYS - set(document)
    if missing:
        errors.append(f"missing top-level keys: {', '.join(sorted(missing))}")
    if document.get("format") != FORMAT:
        errors.append(f'format must be exactly "{FORMAT}"')

    bindings = document.get("connector_bindings")
    if not isinstance(bindings, list):
        errors.append("connector_bindings must be a list")
        bindings = []
    if len(bindings) > CAPS["connector_bindings"]:
        errors.append(f"at most {CAPS['connector_bindings']} connector_bindings")

    declared_refs: set = set()
    known_types = {c["connector_type_id"] for c in (connectors or [])}
    for b in bindings:
        if not isinstance(b, dict):
            errors.append("each connector binding must be an object")
            continue
        ref = str(b.get("ref") or "")
        if _is_uuidish(ref):
            errors.append(f"connector_bindings ref {ref!r} is a UUID — refs are short invented "
                          "names like 'widgets_api' (invalid_ref)")
        elif not REF_RE.match(ref):
            errors.append(f"connector_bindings ref {ref!r} must match ^[a-z][a-z0-9_]{{0,63}}$")
        else:
            declared_refs.add(ref)
        ctype = str(b.get("connector_type_id") or "")
        if known_types and ctype and ctype not in known_types:
            errors.append(f"connector_type_id {ctype!r} is not a connector type in this project "
                          f"(have: {', '.join(sorted(known_types))})")

    definition = document.get("definition")
    if not isinstance(definition, dict):
        errors.append("definition must be an object")
        return errors

    run_config = definition.get("run_config")
    if isinstance(run_config, dict):
        bad = set(run_config) - RUN_CONFIG_KEYS
        if bad:
            errors.append(f"run_config has unknown keys: {', '.join(sorted(bad))} "
                          "(run_config_unknown_key)")
        if run_config.get("on_node_failure") != "halt":
            errors.append('run_config.on_node_failure must be "halt" (invalid_on_node_failure)')
    if "runConfig" in definition:
        errors.append("definition uses runConfig — the key is run_config")

    # Ids: present and unique across every element the contract names. "ids are never generated
    # for you" — so a missing one is a rejection, not something the import fills in.
    seen_ids: set = set()

    def _check_id(obj: dict, what: str) -> None:
        i = str(obj.get("id") or "")
        if not i:
            errors.append(f"a {what} has no id (missing_id)")
        elif i in seen_ids:
            errors.append(f"duplicate id {i!r} (duplicate_id)")
        else:
            seen_ids.add(i)

    def _check_ref(value, where: str) -> None:
        v = str(value or "")
        if _is_uuidish(v):
            errors.append(f"{where} holds a UUID — use a declared ref (invalid_ref)")
        elif v and declared_refs and v not in declared_refs:
            errors.append(f"{where} names ref {v!r}, which is not in connector_bindings")

    for key in ("sources", "destinations", "mappings"):
        items = definition.get(key)
        if items is None:
            continue
        if not isinstance(items, list):
            errors.append(f"definition.{key} must be a list")
            continue
        if len(items) > CAPS.get(key, 10_000):
            errors.append(f"at most {CAPS[key]} {key}")
        for item in items:
            if not isinstance(item, dict):
                errors.append(f"each entry of {key} must be an object")
                continue
            _check_id(item, key[:-1])
            if key in ("sources", "destinations"):
                _check_ref(item.get("connector_id"), f"{key[:-1]} {item.get('id')!r} connector_id")

    total_ops = 0
    for mapping in definition.get("mappings") or []:
        if not isinstance(mapping, dict):
            continue
        ops = mapping.get("operations")
        if not isinstance(ops, list):
            continue
        if len(ops) > CAPS["operations_per_mapping"]:
            errors.append(f"mapping {mapping.get('id')!r} has more than "
                          f"{CAPS['operations_per_mapping']} operations")
        total_ops += len(ops)
        for op in ops:
            if not isinstance(op, dict):
                errors.append("each operation must be an object")
                continue
            _check_id(op, "operation")
            if "kind" in op:
                errors.append(f"operation {op.get('id')!r} uses `kind` — the key is `type` "
                              "(legacy_operation_kind)")
            t = str(op.get("type") or "")
            if t in LEGACY_TYPES:
                errors.append(f"operation type {t!r} is rejected by name")
            elif t not in OPERATION_TYPES:
                errors.append(f"unknown operation type {t!r} "
                              f"(one of: {', '.join(sorted(OPERATION_TYPES))})")
            if t in PASSTHROUGH_TYPES:
                extra_keys = set(op) - PASSTHROUGH_KEYS
                if extra_keys:
                    errors.append(f"{t} operation {op.get('id')!r} carries {', '.join(sorted(extra_keys))} "
                                  f"— it accepts only {', '.join(sorted(PASSTHROUGH_KEYS))}")
            if t in ("enrich_api", "web_search"):
                _check_ref(op.get("connector_id"), f"{t} operation {op.get('id')!r} connector_id")
    if total_ops > CAPS["operations_total"]:
        errors.append(f"at most {CAPS['operations_total']} operations across the document")

    # `source_fields` is always recomputed by Partic, so supplying it is a rejection.
    def _walk(node) -> None:
        if isinstance(node, dict):
            for bad in ("source_fields", "sourceFields"):
                if bad in node:
                    errors.append(f"a schema field supplies {bad} — it is always recomputed and "
                                  "must be absent (source_fields_supplied)")
            for v in node.values():
                _walk(v)
        elif isinstance(node, list):
            for v in node:
                _walk(v)

    _walk(definition)
    return errors
