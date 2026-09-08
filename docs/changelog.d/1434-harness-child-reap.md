- **A turn nobody is reading any more takes its CLI child with it (upstream #1434).** When a caller
  stopped consuming a harness turn mid-stream — the refused-resume path abandons one every time a
  stale session id is rejected — the agent worker stopped reading the Claude Code CLI without
  stopping it. Two defects met there: no hop of the event chain closed what it wrapped, so the
  teardown was left to refcount finalization (a CPython implementation detail, not a guarantee), and
  the teardown it eventually reached was a bare `proc.wait()` that blocks on a process nobody is
  reading rather than killing it. Every hop now closes its inner stream explicitly, and the
  subprocess gets a bounded grace (`VEXA_HARNESS_REAP_GRACE_SEC`, default 5s) before it is killed.
