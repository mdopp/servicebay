# Use node:20-slim for better compatibility
FROM node:20-slim AS base

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
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

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
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
# Install prod deps (builds native modules). tsx/typescript are no longer
# needed at runtime because the custom server is pre-bundled to CJS.
RUN npm ci --omit=dev

# Production image, copy all the files and run next
# Use clean slim image for runner
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1
ENV PATH="/app/node_modules/.bin:$PATH"

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

RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 nextjs

# Runtime dependencies (libc) are standard in debian

COPY --from=builder /app/public ./public

# Copy the full Next build output. We deliberately do NOT use `output: 'standalone'`
# because we run our own custom server (server.ts) that wires Socket.IO, MCP, and
# PTY sessions around `next()`. Standalone rearranges `.next/` in a way that
# breaks `app.prepare()` from a custom-server entry point under Next 16.
COPY --from=builder /app/.next ./.next

# Copy templates and stacks
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/stacks ./stacks

# Markdown content rendered at runtime by /api/help (per-page contextual
# help, plus the CHANGELOG entry for the sidebar "What's new" modal). The
# route reads `process.cwd()/src/content/help/<id>.md`, so the files must
# exist at that exact path inside the runner image. Without this copy,
# every help fetch returns "Help content not found".
COPY --from=builder /app/src/content ./src/content
COPY --from=builder /app/CHANGELOG.md ./CHANGELOG.md

# Copy the pre-bundled custom server (CJS, runs under plain node — no tsx).
# server.ts and src/ are NOT shipped to the runtime; everything imported by
# server.ts is folded into dist-server/server.cjs by scripts/build-server.mjs.
COPY --from=builder /app/dist-server ./dist-server

# Python agent + shell scripts streamed over SSH to each managed node.
# Read at runtime by packages/backend/src/lib/agent/handler.ts with paths
# resolved via `process.cwd() + 'src/lib/agent/v4/...'`, so the container-
# internal destination stays as `/app/src/lib/agent/v4/` even though the
# source moved into the backend workspace in #767. Scripts dir is part of
# the same fix that adds `nginx_inspector.sh` (extracted from inline JS in
# #750 — never made it into the Docker image until now, which is why
# `SSH agent startup failed: ENOENT … nginx_inspector.sh` shows up at
# agent boot).
COPY --from=builder /app/packages/backend/src/lib/agent/v4/agent.py ./src/lib/agent/v4/agent.py
COPY --from=builder /app/packages/backend/src/lib/agent/v4/quadlet_parser.py ./src/lib/agent/v4/quadlet_parser.py
COPY --from=builder /app/packages/backend/src/lib/agent/v4/scripts ./src/lib/agent/v4/scripts

# Copy production node_modules (with built native modules)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# We run as root inside the container to ensure access to mapped volumes (ssh keys)
# When using UserNS=keep-id in Podman (standard for Quadlets), 'root' tracks to the host user.
# RUN chown -R nextjs:nodejs /app
# USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"
# Container mode defaults - agent will SSH to host
ENV HOST_SSH="host.containers.internal"
ENV SSH_KEY_PATH="/root/.ssh/id_rsa"

CMD ["node", "dist-server/server.cjs"]
