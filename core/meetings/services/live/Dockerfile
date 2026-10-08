# syntax=docker/dockerfile:1.7
# ==============================================================================
# @vexa/live — the Nexus IN-PERSON capture host.
#
# Accepts capture.v1 microphone audio from the Nexus Chrome extension over an
# authenticated WebSocket, cuts it into turns (pyannote segmentation, CPU, in
# process), transcribes each turn through the deployment's hosted Whisper, and
# publishes the segments onto the SAME `transcription_segments` spine the meeting
# bots use — so an in-person call lands in history, in the live terminal view and
# in the post-meeting notes with no other service changed. It also runs the
# agenda-coverage evaluator that ticks the call's checklist.
#
# Two stages, both on node:22-bookworm-slim:
#   • builder — corepack pnpm, install the workspace slice, build @vexa/live and
#               its deps, and bake the segmentation model into /opt/hf-cache.
#   • runtime — carry the built tree (incl. the pnpm symlink farm) and run it.
#
# Build context = the repo root (pnpm-workspace.yaml is there):
#   docker build -t vexaai/v012-live:dev -f core/meetings/services/live/Dockerfile .
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: builder
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    # onnxruntime-node fetches a prebuilt runtime in its postinstall; skip the
    # optional CUDA variant (this lane segments on CPU).
    CI=1

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate && pnpm --version

WORKDIR /build

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
# Only core/ is needed: @vexa/live's workspace deps (capture-codec, mixed-pipeline,
# transcribe-whisper) all live under core/meetings/modules/*. The other workspace
# globs are green-on-empty here, and COPYing an absent dir fails the build.
COPY core ./core

# --frozen-lockfile=false: tolerate minor lockfile drift in this carved build, as
# the bot image does. allowBuilds in pnpm-workspace.yaml lets onnxruntime-node and
# friends run their native postinstall.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile=false --filter "@vexa/live..."

# `...` pulls the dependency packages and builds them in topological order.
RUN pnpm --filter "@vexa/live..." run build

RUN test -f /build/core/meetings/services/live/dist/main.js \
    && echo "[builder] @vexa/live dist/main.js present"

# Prove the lane's own logic in the image that will run it — the agenda rules, the
# coverage cadence, the wire format, the API and the end-to-end session. Cheap
# (no network, no services) and it makes a broken image fail at build time.
RUN pnpm --filter "@vexa/live" run test

# Bake the turn-segmentation model (onnx-community/pyannote-segmentation-3.0) into
# an image-resident HF cache so a call never waits on a HuggingFace download. The
# script degrades gracefully (loud warning, exit 0) if HF is unreachable; the model
# is public and would then be fetched on first use.
ENV VEXA_HF_CACHE=/opt/hf-cache
RUN cd /build && node core/meetings/services/bot/warm-hf-cache.mjs

# ------------------------------------------------------------------------------
# Stage 2: runtime
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXUS_LIVE_PORT=8120 \
    VEXA_HF_CACHE=/opt/hf-cache

WORKDIR /app

# The whole built workspace, including the pnpm node_modules symlink farm. Same
# base image ⇒ the symlinks and the .pnpm store stay valid, so there is no install
# in the runtime stage.
COPY --from=builder /build /app
COPY --from=builder /opt/hf-cache /opt/hf-cache
# MIT requires the notice travel with the weights.
COPY licenses/onnx-community-pyannote-segmentation-3.0.LICENSE.txt /opt/hf-cache/LICENSE.pyannote-segmentation-3.0

# Unprivileged: this process holds the deployment's internal secret and talks to
# redis and meeting-api. It needs nothing on disk but its own tree.
USER node

EXPOSE 8120

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEXUS_LIVE_PORT||8120)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "core/meetings/services/live/dist/main.js"]
