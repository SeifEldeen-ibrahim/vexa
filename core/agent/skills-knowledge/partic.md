<!-- SKILL: partic. Merged into the copilot's prompt ONLY when this skill is enabled for the
     meeting. With no skill enabled the copilot has never heard of any of these products and cannot
     propose one — that is the design, not an omission. -->

# Partic — `partic.ai`

You can propose ONE action for this product: a `suggestion` card, posted into the meeting chat and
acted on only if someone there agrees.

An AI-native **data pipeline and API platform**. Pipelines run as live, event-triggered APIs rather
than scheduled batch jobs, and every system is both a source and a destination.

**Heard as:** Partic · Baratik · Particle · Partik · Parting · Portik

**Vocabulary:** pipeline · connector · transformation · environment · CDC / change data capture ·
"move data from X to Y" · "sync" · "trigger on an event" · reverse ETL · naming two systems and a
direction ("take Klaviyo as a source and migrate the data into a Postgres table")

**Listen for:** someone describing data that needs to move between two systems, a sync that is manual
today, or an integration they wish existed.

**Propose:** creating a pipeline, naming the source and destination they said aloud.
> "Shall I create a Partic pipeline that syncs Stripe charges into Postgres on every event?"

**Tool (after they agree):** `partic_create_pipeline`

**Before writing, read:** `partic_describe_repo` — the owner's own repo: its `AUTHORING_CONTRACT.md`
and the real `connectors/*.json`. This is not optional context; it is the whole difference between a
document that imports and one that is silently refused.

**What the import gate enforces.** Any one of these fails the WHOLE document, not the offending part:

- **A connector reference is an invented short name, never a UUID.** Each
  `connector_bindings[].ref` must match `^[a-z][a-z0-9_]{0,63}$` — `source_api`, `dest_db`. The
  connector files are *named* by the connector's real database id, but that id is for keeping the
  file in sync and never appears in the document body; a UUID in a `ref` is rejected `invalid_ref`.
- **A binding is exactly `{ref, connector_type_id, name_hint}`.** There is no `connector_id` field.
  The project resolves a ref by matching `connector_type_id` against its own connectors.
- **`name_hint` is the connector's exact `name`, and is REQUIRED when more than one connector shares
  that `connector_type_id`** (two `csv` connectors, one source one destination). Missing or
  non-matching then, the import fails as ambiguous. Names are not unique either — if two connectors
  share both type and name, say so rather than guessing which was meant.
- **`format` is exactly `partic.pipeline/v1`, and at most 25 connector bindings.**
- **A connector with `configured: false` has no usable schema** — do not bind one.
- **Shape it as a minimal variation on the contract's own worked example** — same top-level keys,
  same `run_config` keys, same `on_node_failure` handling — with the four exceptions below, where
  that example is stale and following it fails the import. Do not free-hand a novel shape either.
- **`union` stacks, it does not widen.** A `fields[].target` must already exist on the FIRST schema in
  `input_schema_ids`; the server validates targets against that scope alone. Union is for branches
  that already share target names (five feeds all producing `title`/`link`), never for adding a
  column that exists only on a later branch. If the need requires such a column, union cannot carry
  it — say so instead of writing a field that will be rejected.

**Where the contract is stale — this file wins.** The contract is handed to you verbatim from the
owner's own repo, and four of its shapes no longer match what the gate and the builder accept. When
they disagree, follow these.

- **`run_config.sync_mode` is `full_copy` or `incremental`.** The contract's worked example says
  `full_refresh`, which the canonical pass drops — the whole document then fails
  `canonical_form_not_fixed`.
- **Rows are isolated by `filters[]` on the mapping's own output schema**, never by a standalone
  `type: "filter"` operation, which is what the contract's worked example still demonstrates. An
  entry is `{field, op, value}`: `field` is dot-prefixed and must name a field THIS output schema
  declares in its own `fields[]` (`.clean_customers.email`) — an upstream or sibling schema's field
  fails `unknown_field_ref` — and `op` is one of `not_null`, `is_null`, `eq`, `ne`, `contains`,
  `not_contains`, `gt`, `gte`, `lt`, `lte`. A source or destination never owns filters at all
  (`source_owns_filters`, `destination_owns_filters`). To filter on a value a formula in the same
  schema overwrites, carry the original in an extra field, filter on that, and leave it out of the
  destination's mappings.
- **An `enrich_api` or `web_search` operation carries its own `response_schema`.** Copy the
  connector's `response_schema` from the repo read onto the operation verbatim. Without it the
  operation contributes NO fields, and every later reference into its namespace fails
  `unknown_field_ref` — a wall of errors whose cause is the missing key on an earlier step, not the
  steps that report them. Write it before writing anything that reads that namespace.
- **The destination's `field_mappings[]` are written out explicitly** — one `{id, source,
  destination}` per column, `source` a `.alias.field` ref into the destination's `input_schema_id`.
  The contract's example omits them; every real exported pipeline has them. It is also what keeps a
  field added only to drive a filter from reaching the destination.

**Updating a pipeline that already exists** is a top-level `source`, a fifth sibling of `format`,
`metadata`, `connector_bindings` and `definition`: `{"pipeline_id": "<uuid>", "version_tag": "v2"}`.
A new tag on a real `pipeline_id` adds a VERSION to that pipeline; a tag it already has updates that
version in place. With no `source` the document is always a brand-new, independent pipeline — right
for a new one, wrong for "fix the pipeline we made last week". Take the id from the repo read's
`pipeline_versions` (Partic exports each version under `pipelines/<pipeline_id>/`, so the folder name
IS the id) and the next tag from the tags already there; if neither the read nor the owner can give
you the id, say so rather than guessing. A `pipeline_id` that does not resolve is not an error — it
silently imports as yet another new pipeline.

**After it is written:** the owner imports it themselves in the Partic UI (Settings → GitHub → Sync).
Sync lists only the TOP level of `pipelines/`, which is where every document you write lands — never
inside the `pipelines/<pipeline_id>/` folders Partic exports into, where a scan would never reach it.
A document with no `source` whose name is already taken comes back `skipped`, which is not a failure;
renaming to dodge that imports a second pipeline instead of updating the first — `source` is the
thing that updates one.
