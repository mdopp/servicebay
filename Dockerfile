# Use node:22-slim for better compatibility
FROM node:22-slim AS base

# Install build tools (python3, make, g++) required for native modules like node-pty
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies only when needed
FROM base AS deps
# Base image already has python3 make g++
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/backup-manifest/package.json ./packages/backup-manifest/package.json
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/disk-import-worker/package.json ./packages/disk-import-worker/package.json
COPY packages/backup-worker/package.json ./packages/backup-worker/package.json
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Carry over any workspace-scoped node_modules that npm did NOT hoist to root.
# Without them the Turbopack build fails with "Module not found" when a frontend
# API route imports a backend module that depends on such a package
# (email.ts → nodemailer, approve/route.ts → email.ts, #2148 regression).
#
# npm's hoisting decision is a MOVING TARGET, so this must not name a concrete
# workspace path. It deoptimized nodemailer into packages/backend/node_modules
# when #2148 landed, then re-hoisted it to the root when the ^9.0.3 → ^9.0.5
# bump in 547090c3 re-resolved the tree — leaving the deps stage with no
# packages/backend/node_modules at all, and the hard
# `COPY --from=deps /app/packages/backend/node_modules` failing the whole build
# with "not found" (#2528).
#
# Instead copy the deps stage's packages/ tree wholesale — that directory always
# exists, the manifest COPYs above create it — and merge back whatever
# node_modules it happens to contain (no-clobber, so the source tree wins).
COPY --from=deps /app/packages ./packages-deps
COPY . .
RUN set -e; for d in packages-deps/*/node_modules; do \
      [ -d "$d" ] || continue; \
      w="$(basename "$(dirname "$d")")"; \
      mkdir -p "packages/$w/node_modules"; \
      cp -rn "$d/." "packages/$w/node_modules/"; \
    done; rm -rf packages-deps

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED 1

RUN npm run build

# Production dependencies stage
# This stage builds native modules (like node-pty) and installs runtime tools
FROM base AS prod-deps
WORKDIR /app
# Base image already has python3 make g++
COPY package.json package-lock.json* ./
# Workspace package manifests — `npm ci` against a workspace root needs
# each member's package.json present so it can resolve their deps too.
# Without these copies, runtime modules listed in packages/*/package.json
# (ssh2, better-sqlite3, node-pty, etc. after #767) silently drop out of
# the runner image and the custom server crashes on first import.
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/backup-manifest/package.json ./packages/backup-manifest/package.json
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/disk-import-worker/package.json ./packages/disk-import-worker/package.json
COPY packages/backup-worker/package.json ./packages/backup-worker/package.json
# Install prod deps (builds native modules). tsx/typescript are no longer
# needed at runtime because the custom server is pre-bundled to CJS.
RUN npm ci --omit=dev

# Production image, copy all the files and run next
# Use clean slim image for runner
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1
ENV PATH="/app/node_modules/.bin:$PATH"
# An explicit, writable HOME. podman derives one from /etc/passwd, but several
# call sites read process.env.HOME directly and fall back to /root when it is
# unset, or point a child at it: ssh.ts creates $HOME/.ssh for ssh-copy-id's
# mktemp and spawns the PTY with `cwd: process.env.HOME`; git and ssh write
# config/known_hosts there. /root is unreadable to the runtime user.
ENV HOME=/home/nextjs

# Install SSH client, Python, and git.
# - SSH/Python: Agent V4 runs commands on the host over SSH.
# - git: external registry sync (#443) clones template repositories into
#   the on-disk cache. Without git, `Registry sync skipped: git not
#   available` silently falls back to built-in templates only.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-client \
    python3 \
    python3-paramiko \
    procps \
    iproute2 \
    git \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# The unprivileged runtime user (#2789, the image half of #2749). uid 1001 /
# gid 1001 — and `--gid nodejs` is load-bearing, not tidiness: without it
# useradd gives nextjs its OWN primary group, and since gid 1001 is already
# taken by nodejs it silently picks an arbitrary free system gid. The boot
# reconciler packages/backend/src/lib/quadletUserNs.ts derives the box's
# `UserNS=keep-id:uid=<uid>,gid=<gid>` from `id` run inside THIS image, so that
# arbitrary gid would be what every box's quadlet ends up mapping.
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --home-dir /home/nextjs --create-home nextjs

# Own /app BEFORE anything is copied into it, and give every COPY below
# `--chown=nextjs:nodejs`. That is the "chown /app" half of #2749, deliberately
# not spelled as a trailing `RUN chown -R nextjs:nodejs /app`: a recursive chown
# after the copies rewrites the metadata of every file under node_modules/ and
# .next/, and the layer that produces carries a second copy of ~1 GB of file
# data into the published image for no behavioural difference. Here /app is
# still empty, so the same ownership costs nothing.
#
# /app/data is pre-created because the logger opens `process.cwd()/data`
# (packages/backend/src/lib/logger.ts) as one of its first acts; on the box that
# path is a bind of ${DATA_ROOT}/servicebay, but a missing mkdir must not be the
# thing that takes the process down when it isn't.
RUN mkdir -p /app/data /app/packages/frontend /app/src/lib/agent/v4 && \
    chown -R nextjs:nodejs /app /home/nextjs

# Runtime dependencies (libc) are standard in debian

# There is no `packages/frontend/public` to copy (#2729). The only file it ever
# held was the generated MSW `mockServiceWorker.js`; deleting the mock layer
# emptied the directory, and git does not track empty directories, so the COPY
# failed the build with "failed to calculate checksum ... not found".
#
# Do not re-add it with a .gitkeep: nothing serves out of it. The frontend's
# icons are App Router metadata files under `src/app/` (icon.svg,
# portal/icon.svg, portal/manifest.webmanifest/route.ts), which Next compiles
# into `.next/` and serves from there, and no source references a `/<file>`
# static asset path. If a real static asset is ever added, create the directory
# with that asset in it and restore ONE line — `COPY --from=builder
# /app/packages/frontend/public ./packages/frontend/public`. The `./public`
# target was always dead: server.ts starts Next with
# `dir: <cwd>/packages/frontend`, so Next resolves `public` relative to that,
# never to `/app/public`.

# Copy the full Next build output. We deliberately do NOT use `output: 'standalone'`
# because we run our own custom server (server.ts) that wires Socket.IO, MCP, and
# PTY sessions around `next()`. Standalone rearranges `.next/` in a way that
# breaks `app.prepare()` from a custom-server entry point under Next 16.
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next ./packages/frontend/.next

# Copy templates and stacks
COPY --from=builder --chown=nextjs:nodejs /app/templates ./templates
COPY --from=builder --chown=nextjs:nodejs /app/stacks ./stacks
# The task-assist catalog (#2146) is deliberately NOT copied here (#2701).
#
# Baking it in made a catalog entry an image artifact: a `docs(assists):` commit
# cuts no release, so merged entries sat on `main` and never reached a running
# box. The catalog is now DELIVERED AT RUNTIME — a shallow sparse checkout of
# this repo's `assists/` tree under DATA_DIR, refreshed at boot and hourly by
# packages/backend/src/lib/assists/delivery.ts.
#
# Do not re-add a COPY of assists/ here. Two sources is the failure the decision
# exists to prevent: the image copy would age and answer alongside the disk one,
# and an assist that answers WRONGLY is worse than one that is missing. If
# delivery fails, every read reports the failure (empty and loud) instead of
# falling back to a baked-in tree.

# (The ADRs used to be copied in from docs/adr/ for get_service_standards.
# #2607 MOVED them into assists/ above — one copy, in the only place an MCP
# agent can actually read: docs/ is not reachable from a session, assists/ is.
# docs/adr/ now holds signposts for old links and is deliberately NOT shipped.)

# Markdown content rendered at runtime by /api/help (per-page contextual
# help, plus the CHANGELOG entry for the sidebar "What's new" modal). The
# route reads `process.cwd()/src/content/help/<id>.md`, so the files must
# exist at that exact path inside the runner image. Without this copy,
# every help fetch returns "Help content not found".
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/src/content ./src/content
COPY --from=builder --chown=nextjs:nodejs /app/CHANGELOG.md ./CHANGELOG.md

# Copy the pre-bundled custom server (CJS, runs under plain node — no tsx).
# server.ts and src/ are NOT shipped to the runtime; everything imported by
# server.ts is folded into dist-server/server.cjs by scripts/build-server.mjs.
COPY --from=builder --chown=nextjs:nodejs /app/dist-server ./dist-server

# Python agent + shell scripts streamed over SSH to each managed node.
# Read at runtime by packages/backend/src/lib/agent/handler.ts with paths
# resolved via `process.cwd() + 'src/lib/agent/v4/...'`, so the container-
# internal destination stays as `/app/src/lib/agent/v4/` even though the
# source moved into the backend workspace in #767. Scripts dir is part of
# the same fix that adds `nginx_inspector.sh` (extracted from inline JS in
# #750 — never made it into the Docker image until now, which is why
# `SSH agent startup failed: ENOENT … nginx_inspector.sh` shows up at
# agent boot).
COPY --from=builder --chown=nextjs:nodejs /app/packages/backend/src/lib/agent/v4/agent.py ./src/lib/agent/v4/agent.py
COPY --from=builder --chown=nextjs:nodejs /app/packages/backend/src/lib/agent/v4/quadlet_parser.py ./src/lib/agent/v4/quadlet_parser.py
COPY --from=builder --chown=nextjs:nodejs /app/packages/backend/src/lib/agent/v4/scripts ./src/lib/agent/v4/scripts

# Copy production node_modules (with built native modules)
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
# npm sometimes deoptimizes hoisting and leaves runtime deps under
# packages/*/node_modules instead of the root (e.g. nodemailer + semver after
# the ^9.0.3 bump in 6a37174e). The pre-bundled server (dist-server/server.cjs)
# require()s these externals and node resolves them from /app/node_modules at
# runtime — it never looks in packages/backend/node_modules. The builder-stage
# fix (98cd90ba) only unblocked the Turbopack build; the runner still shipped
# without them, so the container crash-looped on boot with "Cannot find module
# 'nodemailer'". Merge any workspace-scoped deps into root (no-clobber so
# hoisted copies always win) regardless of npm's hoisting decision.
COPY --from=prod-deps --chown=nextjs:nodejs /app/packages ./packages-proddeps
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

# Runtime user: root again, deliberately — 2026-09-05, #2805 (rollback of the
# #2789 image half; the reasoning below is the #2722 one, restored).
#
# 5.28.0 shipped `USER nextjs` and broke the box. Not because the image was
# wrong, but because the mapping that makes a non-root image survivable is
# written by a reconciler that the delivery path does not run: the host's
# `podman-auto-update.timer` pulls `:latest` and restarts the unit with no
# pre-swap hook, so the unprivileged container came up on a quadlet with no
# `UserNS=` at all. Under rootless podman the container's uid 0 maps to the HOST
# user that runs the quadlet (`core`, uid 1000 on the box); every other
# container uid lands in that user's subuid range and owns nothing on the host.
# Three things the app then cannot do — all three observed on the box, not
# assumed:
#
#   1. The Podman control plane. The quadlet binds the host's rootless socket
#      /run/user/1000/podman/podman.sock -> /run/podman/podman.sock and points
#      CONTAINER_HOST at it. That socket is core-owned, mode 0660, so a subuid
#      gets EACCES and ServiceBay can no longer list or deploy a single service.
#   2. DATA_DIR. /app/data is a bind of ${DATA_ROOT}/servicebay (core-owned,
#      SELinux :Z). Boot writes into it — see packages/backend/src/lib/dirs.ts
#      plus the mkdir/write paths in secrets.ts and nodes.ts. Losing it is what
#      took the tokens, the config and the service registry down in #2805.
#   3. The host SSH identity. nodes.json points Agent V4 at
#      /app/data/ssh/id_rsa (ssh://core@127.0.0.1). ssh refuses a private key it
#      does not own, so the agent — and with it every host-side command — dies.
#
# Root is therefore the self-healing state: the same auto-update timer that
# broke the box repairs it, because packages/backend/src/lib/quadletUserNs.ts
# (#2788) removes a stray `UserNS=` again as soon as the image it inspects
# declares root. Rollback-safe by design, in that one direction only.
#
# Same mapping, same reason as packages/{backup-worker,disk-import-worker}/Containerfile.
#
# Re-land condition (#2808): the host half now EXISTS —
# /usr/local/bin/servicebay-userns-selfheal.sh, wired as a plain (no leading
# `-`) ExecStartPre on servicebay.container, derives `UserNS=` from
# `podman image inspect --format '{{.Config.User}}'` of the pulled image and
# rewrites the quadlet before podman starts the container, so no delivery route
# (auto-update timer included) can start it on a mapping-less quadlet. It ships
# in tools/sb/internal/build/assets/fedora-coreos.bu next to
# servicebay-relabel-selfheal.sh, and packages/backend/src/lib/quadletUserNsHostHook.ts
# pushes the identical script to boxes installed before #2808.
#
# What is still owed before the flip is ORDERING, not code. Delivery to existing
# boxes happens from the RUNNING app, so the release carrying the host half must
# be strictly OLDER than the release that flips this line — the same #2788 →
# #2789 ordering. Flip both in one release and a box on the previous version has
# no script when the timer pulls the new image: that is #2805, verbatim. So:
# ship this release, confirm on the box that servicebay.container carries the
# ExecStartPre and that a podman-auto-update run reconciles the mapping, THEN
# flip to `USER nextjs` in a later release.
#
# Everything else the image half needs is deliberately LEFT IN PLACE and is
# harmless under root — the nextjs/nodejs ids with their load-bearing
# `--gid nodejs`, `ENV HOME=/home/nextjs`, and `--chown=nextjs:nodejs` on every
# runner COPY — so the re-land really is a one-line flip.
#
# Guard: tests/backend/dockerfile_runtime_user.test.ts.
USER root

# Kept BELOW the switch where #2789 put it. It runs as root again now, which is
# fine — the runtime user is root too, so the root-owned files this drops into
# node_modules are readable by the process. When the unprivileged user re-lands
# (#2805 follow-up) this position matters again: `cp` as root under
# `USER nextjs` would leave root-owned files in a nextjs-owned tree, and
# repairing that with a `chown -R node_modules` duplicates ~1 GB into a new
# layer.
RUN for d in packages-proddeps/*/node_modules; do [ -d "$d" ] && cp -rn "$d/." node_modules/; done; rm -rf packages-proddeps

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"
# Container mode defaults - agent will SSH to host
ENV HOST_SSH="host.containers.internal"
# Fallback identity for the agent's containerized branch
# (packages/backend/src/lib/agent/v4/agent.py). It read /root/.ssh/id_rsa, a
# path the unprivileged runtime user cannot open and which never held a key in
# this image anyway; the real one is DATA_DIR/ssh/id_rsa (dirs.ts SSH_DIR),
# which is where nodes.json points and which keep-id makes readable.
ENV SSH_KEY_PATH="/app/data/ssh/id_rsa"

CMD ["node", "dist-server/server.cjs"]
