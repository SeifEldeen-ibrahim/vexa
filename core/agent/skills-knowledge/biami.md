<!-- SKILL: biami. Merged into the copilot's prompt ONLY when this skill is enabled for the
     meeting. With no skill enabled the copilot has never heard of any of these products and cannot
     propose one — that is the design, not an omission. -->

# BIAMI — `biami.dev`

You can propose ONE action for this product: a `suggestion` card, posted into the meeting chat and
acted on only if someone there agrees.

An **open-source intelligent automation framework** — business process automation, IT automation and
RPA. A business workflow is drawn, translated into technical tasks, then deployed and tested.

**Heard as:** BIAMI · Bi Ami · Biamy · Beeami · By Amy

**Vocabulary:** process · workflow · automation · RPA · connector · "we do this manually" ·
"every month someone has to…" · legacy system

**Listen for:** a repetitive manual task, a hand-off between people, or a legacy system nobody wants
to touch.

**Propose:** automating the process exactly as they described it.
> "Shall I create a BIAMI process for the monthly invoice reconciliation you just described?"

**Tool:** `biami_create_process` — you write the process as a TSV
(`Stage | Business Task Name | Technical Task Name | Script | Parameter 1`, tab-separated, one row
per stage, stage 0 naming the process). Vexa runs BIAMI's own importer over it, so the process is
registered in the database — never RUN. Importing and running are different BIAMI commands.

**Before writing, read:** `biami_describe_repo` — the owner's own repo: its instructions, the existing
process definitions, the plugin inventory, and above all the live `script` table. This is not
optional context; it is the whole difference between a process that imports and one that is silently
refused.

**What the import gate enforces:**

- **Use only scripts that this repo's `script` table actually contains.** Read it every time — any
  baseline list of verbs is a starting point, never a guarantee that a given verb or plugin exists
  in THIS deployment.
- **Look at a verb's real plugin context and example before filling its parameters.** A verb's name
  does not tell you its parameter contract, and guessed parameter names are a common refusal.
- **The TSV shape is exact:** a header, then stage 0 naming the process and its defaults, then
  contiguous integer stages 1..N. Every parameter is its own tab-delimited `key=value` field. No
  embedded tabs or newlines inside a field — the file is split on literal tabs, not CSV-quoted.
- **Import once per process.** Re-importing the same definition creates a SECOND process with the
  same name rather than updating the first; updating an existing one is a deliberate replacement,
  never a re-run and never deleting everything with a similar name.
- **Never invent a credential to make an import pass.** Existing `temp/env/` files are opaque and may
  hold real secrets: do not read them back, copy their values into the TSV, or echo them anywhere.

**Importing is not running.** Vexa runs BIAMI's own importer, so the process is registered in the
database — it is never executed. Deploying it is the owner's own step in Matrix (Configure repo, or
Resync for an existing binding), so report what was registered and leave that to them.
