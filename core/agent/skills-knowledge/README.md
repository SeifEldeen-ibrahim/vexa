# agents/skills — what a meeting is allowed to be about

**Concern.** One file per product capability the copilot may recognise. Each is merged into the
copilot's prompt **only when that skill is enabled for the meeting**, so a meeting with none enabled
has a copilot that has never heard of these products and cannot propose one. That is a stronger
guarantee than a prompt rule telling a model to stay quiet, and it is why the default is nothing
rather than everything.

**Surface.** Prose, merged verbatim. `_propose.md` carries the rules every proposal obeys and is
merged once whenever at least one skill is on; `<skill>.md` carries one product — what it is, the
words that signal it (including the mangled forms speech-to-text actually produces), what a good
proposal sounds like, and the tool that follows agreement.

Editing a file changes what the copilot listens for, with no redeploy. Deleting one turns that
product off everywhere.

**Deps.** `core/agent/shared/skills.py` is the registry: it decides which files exist, resolves ids
to paths (an id is never interpolated into a path), and pairs each skill with its tool. A file here
with no registry row is never read; a registry row with no file is a failing test.

**Not to be confused with** `workspace-seeds/default/skills/`, two directories up, which is Claude
Code's own Agent Skills mechanism. Different concept, same word.
