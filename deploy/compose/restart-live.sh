#!/usr/bin/env bash
# Rebuild and restart the `live` service without cutting somebody's meeting in half.
#
# WHY THIS EXISTS. The hazard is not that the check is hard, it is that a check which PRINTS is
# not a check. On 2026-10-12 a deploy ran `curl .../live/health && docker compose up -d live`:
# the curl faithfully printed `live_sessions: 1` and the `&&` restarted the service anyway,
# 38 seconds into a colleague's call. Twice in one morning, same mistake.
#
# And the check has to come AFTER the build, not before it: the image takes minutes to build, and
# a call that starts during it is a call the old check never saw.
#
# A restart is survivable since e185d826 — the call is handed over, the row stays `active`, and
# the extension's next reconnect resumes it, so the cost is ~20s of audio rather than the rest of
# the meeting. That is a reason to be less afraid of deploying, NOT a reason to skip the check:
# those 20 seconds are somebody's meeting, and the audio spoken into them is gone for good.
set -euo pipefail
cd "$(dirname "$0")"

HEALTH="${NEXUS_LIVE_HEALTH_URL:-https://nexus.biami.io/live/health}"
FORCE="${1:-}"

live_sessions() {
  curl -fsS --max-time 10 "$HEALTH" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("live_sessions", "?"))'
}

refuse_if_busy() {
  local n; n="$(live_sessions)"
  if [ "$n" = "?" ]; then
    echo "REFUSING: could not read live_sessions from $HEALTH" >&2; exit 2
  fi
  if [ "$n" != "0" ]; then
    if [ "$FORCE" = "--force" ]; then
      echo "WARNING: $n call(s) live — restarting anyway because --force was given." >&2
      echo "         They will be handed over and resumed, losing ~20s of audio each." >&2
      return 0
    fi
    echo "REFUSING: $n call(s) live on $HEALTH." >&2
    echo "          Wait for them to end, or pass --force and accept ~20s of lost audio each." >&2
    exit 2
  fi
  echo "ok: no calls live"
}

echo "== checking before the build"
refuse_if_busy

echo "== building"
docker compose -p vexa-v012 -f docker-compose.yml build live

# The one that actually matters: the build just took minutes, so ask again.
echo "== checking again, immediately before the restart"
refuse_if_busy

echo "== restarting"
docker compose -p vexa-v012 -f docker-compose.yml up -d --no-deps --no-build live

for _ in $(seq 1 20); do
  sleep 2
  if curl -fsS --max-time 5 "$HEALTH" >/dev/null 2>&1; then echo "== up:"; curl -fsS "$HEALTH"; echo; exit 0; fi
done
echo "WARNING: $HEALTH did not come back within 40s — check the container." >&2
exit 1
