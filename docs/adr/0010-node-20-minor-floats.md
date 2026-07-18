# ADR 0010 — Node runtime tracks a single LTS line; the minor floats, kept consistent across all four sources

- **Status:** Accepted (amended 2026-07-18: Node 20 → Node 22 line)
- **Date:** 2026-07-06 (original) · 2026-07-18 (amended)
- **Deciders:** operator (mdopp)
- **Related:** [ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md), #2166, #2329

> **Revision note (2026-07-18, #2329).** The runtime moved from the Node 20
> line to the **Node 22 (LTS)** line. Node 22 is the current maintained LTS,
> and the bump **unblocks dependency-cruiser 18** (#2290), which requires
> `^22 || ^24 || >=26`. The *principle* of this ADR is unchanged — track one
> LTS major, let the minor float, keep the major consistent across all four
> sources. Only the tracked major changed (20 → 22). This is a deliberate
> runtime/infra change, **not** an API break: it ships as a `fix(runtime):`
> patch, not a major bump. Moving the line means bumping all four sources
> together; `tests/backend/node_version_consistency.test.ts` is the checklist.

## Context

The Node version is declared in **four** places and they must not disagree,
or a native module (`node-pty`, `better-sqlite3`) compiled under one Node ABI
can be loaded under a different one — the classic "compiled against a different
Node.js version" crash that only shows up at runtime on the box:

| Source | Value |
|---|---|
| `package.json` `engines.node` | `22.x` |
| `.nvmrc` | `22` |
| `.github/workflows/*.yml` `node-version` | `22` |
| `Dockerfile` / `Dockerfile.dev` base | `node:22-slim` |

All four track **Node 22** (the box's current LTS line). None pins an exact minor.

The #2166 architecture review asked: pin an exact minor (e.g. `22.11.0`) for
reproducibility, or make the float a deliberate, documented choice?

## Decision

**Track a single Node LTS line (currently Node 22) and let the minor float — do
not pin an exact minor.** Keep the *major* identical across all four sources.

Rationale:

- The `deps` stage of the Docker image **compiles the native modules against
  `node:22-slim`'s current minor**, and the runner uses that same image's Node.
  The image is internally consistent by construction: the ABI the modules are
  built against is the ABI they run against. Skew would only appear if a
  *different* Node built the modules than runs them — which within one image
  never happens.
- CI installs Node 22 via `actions/setup-node` and rebuilds from source, so
  CI's native modules match CI's Node. CI does not ship its `node_modules` to
  the box; the image's `prod-deps` stage rebuilds them under `node:22-slim`.
- Pinning an exact minor would introduce a **maintenance treadmill** (bump four
  files in lockstep every Node patch) and a **skew risk of its own**: if the
  pinned `engines`/`.nvmrc` minor drifts from what `node:22-slim` currently
  ships, the pin *creates* the very mismatch it was meant to prevent. Floating
  on the same major is strictly safer here than a hand-maintained minor pin.

The invariant we actually care about is **major-version agreement across the
four sources**, not a frozen minor. That invariant is enforced by a test
(`tests/backend/node_version_consistency.test.ts`, #2166): if someone bumps CI
to `24` but leaves the Dockerfile on `22-slim` (or vice-versa), CI goes red.

## Consequences

- To move Node lines (20 → 22, or later 22 → 24), bump **all four** sources
  together; the consistency test is the checklist. The 20 → 22 move (#2329) is
  the first exercise of this playbook.
- A reproducibility-critical build can still pin a minor by narrowing the
  Docker base tag (`node:22.11.0-slim`) and the test's expected major stays
  satisfied — but that is an opt-in, not the default.
- No native-module ABI skew is possible within a single built image, because
  the same base image both compiles and runs the modules.
- Moving to Node 22 unblocks dependency-cruiser 18 (#2290); TypeScript 7
  (#2291) stays independently blocked (Next.js incompatibility, not Node-bound).
</content>
</invoke>
