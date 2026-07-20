---
title: Architecture recommendations for a new ServiceBay service (ADR-style)
whenToUse: You're about to design a new service and want recommended defaults — language, structure, libraries, tests, data storage, secrets — plus the platform decisions a new service must respect.
kind: adr
tags: [architecture, adr, new-service, language, libraries, tests, storage, secrets, recommendations]
---

# Architecture recommendations for a new service

Recommended defaults, not mandates — deviate when you have a reason, and say why.
These sit on top of the platform ADRs in `docs/adr/` (respect those; see bottom).

An architecture recommendation must say **how** a need is solved — and the first
decision is **where it lives**. Only then do language/structure/etc. follow.

## Where should it live? (decide the shape first)

A new need is usually solved as one of these — pick deliberately:

- **A capability in Solaris** — when it's about *this household*: identity,
  memory, conversation, per-resident privacy, or a home-control behavior driven
  through the assistant. Lives in `mdopp/solarisbay` (the Solaris Engine / tools).
  Example: "remember the family's book list and answer questions about it."
- **A service in ServiceBay** — when it's a *generic, installable capability* any
  box could want, standing on its own (a web app, an API, a data store, a device
  bridge). Ships as a template. Example: "a photo library", "an office-light
  dashboard".
- **Reuse what's there** — when the runtime already provides it. Before building
  an agent/LLM/tool or device feature, check whether **HA, Authelia, Ollama, NPM,
  or the Solaris Engine** already provides it, and consume/extend that instead of
  rebuilding.
- **Both** — a ServiceBay service exposes the capability (e.g. an MCP surface or
  API), and Solaris consumes it as a tool. Prefer this over duplicating logic:
  generic mechanism in ServiceBay, household-specific behavior in Solaris.

Rule of thumb (the ServiceBay ↔ Solaris boundary): **generic → ServiceBay (or an
upstream project); household-specific → Solaris.** If you'd want it on someone
else's box unchanged, it's a service; if it only makes sense for *this* family,
it's a Solaris capability. State this choice explicitly in the design.

## Language & runtime
- **Any language works** — a service is just a container. Pick the smallest,
  fastest-to-start stack that fits the job.
- Sensible defaults by shape:
  - Small web/API/proxy service → **Python (FastAPI+uvicorn)** or **Node/TS
    (Fastify)** or **Go** (single static binary, tiniest image).
  - AI / data / HA-adjacent → **Python** (matches Solaris; rich HA/ML libs).
  - Control-plane-adjacent tooling → **Node/TS** (matches ServiceBay).
- Keep the image lean (slim/alpine/distroless base, multi-stage build) and
  startup fast — the health gate and reconcile loop reward quick boots.

## Basic structure (two pieces)
1. **App repo** — code + `Dockerfile` + CI that builds & pushes an image the box
   can pull. Keep it independently buildable/testable.
2. **Template** — a `templates/<name>/` (or registry / local-drop) that deploys
   that image and declares ports, mounts, subdomain, SSO, health. See the
   `create-service` recipe and `docs/TEMPLATE_AUTHORING.md`.

The app should be: **stateless-restartable** (all state on a mounted volume),
**config-by-env**, and **health-observable**.

## User-facing UI
- If the service has a frontend, **adopt the ServiceBay design language** so it
  reads as native even on its own subdomain: copy the real design tokens
  (palette + accent, radii, typography, spacing) and implement the UX baseline —
  a styled large-tap-target file picker (not the native `<input type=file>`),
  **real streaming progress** for long ops (not a bare spinner; reconnect by
  server job id, not localStorage), responsive/mobile layout, and visible focus
  states. See `service-ui-design-standard`.

## Recommended libraries
- Lean over heavy: a minimal web framework + a good HTTP client, not a kitchen
  sink. (Python: `fastapi`+`uvicorn`+`httpx`. Node: `fastify`+`undici`. Go: std
  `net/http`.)
- Reuse the platform instead of reimplementing: **Authelia** for auth (don't roll
  your own login), **NPM** for TLS/proxy, **Home Assistant** for device control,
  **Ollama** for local LLM. Talk to them, don't rebuild them.

## Recommended tests
- **Unit tests** for real logic (parsing, control flow, error handling) — fast,
  no network.
- **A health endpoint** (`/healthz` → 200) wired to `servicebay.healthcheck`;
  it's both a test seam and the install gate.
- **Box-verify** the deployed service end-to-end (deploy → healthcheck →
  functional check → SSO returns 302 unauthenticated → the feature actually
  works). See `create-service`. Don't trust green CI alone for box behavior.
- If the app enforces the forward-auth `Remote-User` header, test that a request
  missing it is rejected (no SSO bypass).
- **Testing/coverage/CI is a standard, not a nicety** — a real suite, thread-aware
  coverage, and a CI that **gates image publish on green tests** (a build-only CI
  is non-compliant). New service targets ≥85% total on the 70% diff-coverage
  floor. See `testing-and-ci-gate`.
- **Long-running work (anything over ~10s)** must be a server-owned durable job:
  reconnect via the server (not localStorage), survive a restart, be observable +
  cancelable. See `long-running-process`.

## Data storage
- Persist under a **mounted hostPath volume** at `{{DATA_DIR}}/<name>/…`
  (= `/mnt/data/stacks/<name>/…`). Nothing important in the container's ephemeral
  fs — it's wiped on every pod recreate.
- **Small structured state → SQLite in WAL mode** (WAL avoids "database is
  locked" under concurrent reads/writes; a repeatedly-hit lesson on this box).
- Larger/bulk data → its own dir on the volume; keep it out of the config tree so
  backup tiering works (config/state → NAS, bulk → secondary drive; ADR 0002).
- Under rootless Podman + SELinux, prefer `type: Directory` with a pre-created
  dir over `DirectoryOrCreate` when mounting shared/foreign-owned trees, and
  disable relabel per-container when mounting another service's files.
- **Don't re-derive data another service already owns** — read the owning
  service's index/API (Jellyfin/Immich/Radicale), be one-writer-per-store, and
  state the data-authority map in the design. See `data-authority`.
- **Writing another service's files** hits the container→host uid map (root often
  maps to host uid 1000; another userns maps to a subuid), foreign ownership, and
  the owning app's lock files — prefer its API, and if you must write its fs, make
  ownership/world-writable explicit. See `footgun-cross-service-uid-writes`.

## Secrets
- **Never bake a secret into the image, template, or repo.** Express credentials
  as `type: "secret"` variables — the wizard generates/injects the value at
  deploy. Read them from env or a mounted file at runtime. See root `CLAUDE.md`
  "Secret hygiene" (a build-time scan enforces this).

## Networking & SSO
- Default to an **isolated netns** with explicit `hostPort`s; use
  `hostNetwork: true` only when the app must reach another on-box service on
  loopback (ADR 0007). A pod with neither is silently unreachable.
- User-facing? Put it on a subdomain with Authelia forward-auth (ADR 0001/0006).
  Reference `{{PUBLIC_DOMAIN}}` in the template or the proxy host is skipped —
  see `footgun-subdomain-needs-public-domain`.

## Platform ADRs a new service must respect
- **0001 / 0006** — authenticate via Authelia (SSO) / LLDAP; apex is default-deny.
- **0002** — make config/state NAS-backupable; keep bulk separate.
- **0003** — release via release-please; parser-clean commit subjects.
- **0004 / 0009** — installs/redeploys are non-destructive; repair is
  reconciliation, not reinstallation. Your `post-deploy.py` must be idempotent.
- **0005** — DNS Pattern A (AdGuard as LAN DNS).
- **0007** — network isolation with named carve-outs.
- **0009-service-tokens** — use scoped service tokens for cross-service trust.

Read the actual ADRs in `docs/adr/` before making a decision that touches one.

## After you build — rollout + reporting gaps back
- **Rolling a new image onto an already-installed service** isn't automatic: a
  restart won't pull a newer `:latest`, and `install_template` re-pulls but won't
  restart. Pull *then* restart, verify the running digest, and prefer pinned tags
  over `:latest` for a real version story. See
  `recipe-roll-new-image-to-running-service`.
- **Report standards gaps back.** If a standard was missing, ambiguous, or wrong
  while you built, that's a standard in itself — file a `standards-gap` issue and
  propose the assist/docs fix. See `report-standards-gaps`.
