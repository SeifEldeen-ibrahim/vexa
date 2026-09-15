- **A Partic pipeline the assistant writes now survives the import gate — and can update an existing
  pipeline instead of always creating another.** The Partic skill knowledge carries the four places
  the owner's own `AUTHORING_CONTRACT.md` has gone stale (`run_config.sync_mode` is
  `full_copy`/`incremental`, never `full_refresh`; rows are filtered by `filters[]` on the output
  schema, never a standalone `filter` operation; an `enrich_api`/`web_search` step repeats its own
  `response_schema`; the destination's `field_mappings[]` are written out), each of which used to
  fail the whole document out of band, where nobody in the meeting could see it. A document may now
  carry a top-level `source` (`{pipeline_id, version_tag}`) to add a version to a pipeline that
  already exists, and `partic_describe_repo` reports the exported `pipeline_versions` and each
  connector's `response_schema` so the assistant has the ids and field names it must repeat.
