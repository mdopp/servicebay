# ADR 0010 — Node runtime tracks the Node 20 line; the minor floats, kept consistent across all four sources

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** operator (mdopp)
- **Related:** [ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md), #2166

## Context

The Node version is declared in **four** places and they must not disagree,
or a native module (`node-pty`, `better-sqlite3`) compiled under one Node ABI
can be loaded under a different one — the classic "compiled against a different
Node.js version" crash that only shows up at runtime on the box:

| Source | Value |
|---|---|
| `package.json` `engines.node` | `20.x` |
| `.nvmrc` | `20` |
| `.github/workflows/*.yml` `node-version` | `20` |
| `Dockerfile` / `Dockerfile.dev` base | `node:20-slim` |

All four track **Node 20** (the box's LTS line). None pins an exact minor.

The #2166 architecture review asked: pin an exact minor (e.g. `20.18.1`) for
reproducibility, or make the float a deliberate, documented choice?

## Decision

**Track the Node 20 line and let the minor float — do not pin an exact minor.**
Keep the *major* identical across all four sources.

Rationale:

- The `deps` stage of the Docker image **compiles the native modules against
  `node:20-slim`'s current minor**, and the runner uses that same image's Node.
  The image is internally consistent by construction: the ABI the modules are
  built against is the ABI they run against. Skew would only appear if a
  *different* Node built the modules than runs them — which within one image
  never happens.
- CI installs Node 20 via `actions/setup-node` and rebuilds from source, so
  CI's native modules match CI's Node. CI does not ship its `node_modules` to
  the box; the image's `prod-deps` stage rebuilds them under `node:20-slim`.
- Pinning an exact minor would introduce a **maintenance treadmill** (bump four
  files in lockstep every Node patch) and a **skew risk of its own**: if the
  pinned `engines`/`.nvmrc` minor drifts from what `node:20-slim` currently
  ships, the pin *creates* the very mismatch it was meant to prevent. Floating
  on the same major is strictly safer here than a hand-maintained minor pin.

The invariant we actually care about is **major-version agreement across the
four sources**, not a frozen minor. That invariant is now enforced by a test
(`tests/backend/node_version_consistency.test.ts`, #2166): if someone bumps CI
to `22` but leaves the Dockerfile on `20-slim` (or vice-versa), CI goes red.

## Consequences

- To move Node lines (20 → 22), bump **all four** sources together; the
  consistency test is the checklist.
- A reproducibility-critical build can still pin a minor by narrowing the
  Docker base tag (`node:20.18.1-slim`) and the test's expected major stays
  satisfied — but that is an opt-in, not the default.
- No native-module ABI skew is possible within a single built image, because
  the same base image both compiles and runs the modules.
