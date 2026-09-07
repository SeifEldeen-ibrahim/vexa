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

**Before writing, read:** `partic_describe_repo` — the owner's own repo: its authoring contract, the connectors
or verbs that really exist there, and what has already been built. The import gate rejects anything
that does not already match, and an invented name is the usual reason, so this is not optional
context — it is what makes the difference between a document that imports and one that is silently
refused where nobody in the meeting can see it.
