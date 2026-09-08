# `PLANS/` — worked delivery plans

One file per piece of work, written **before** the code and kept as the record of what was intended
and why. A plan here is not a design document to admire: it is the thing the implementation is
checked against, and it stays honest by carrying its own evidence status.

Each plan states, at minimum:

- **Where we are (honest)** — code-grounded claims with `file:line` anchors, and an explicit note of
  what was *not* checked. A claim that is an operator's field observation rather than a fact read out
  of the tree says so.
- **The change** — components, in the order they can each be witnessed.
- **Acceptance** — the observations that decide whether the value is real, negative controls
  included. A control that cannot fail proves nothing, so each one names what would make it red.
- **Findings** — defects the work surfaced but deliberately did *not* fix, so they are reported
  rather than silently carried.

Plans are amended as reality contradicts them. A plan that was wrong and got corrected is worth more
than one that was quietly abandoned — the correction is the finding.

See [`AGENTS.md`](../AGENTS.md) for how a plan relates to the issue that authorises the work, and
[the delivery book](../docs/docs/governance/delivery.mdx) for the merge and ship bars it feeds.
