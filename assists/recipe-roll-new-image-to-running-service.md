---
title: Rolling a new image onto an already-running service (:latest update flow)
whenToUse: CI pushed a new image for an installed service and you need the box to actually run it — a plain restart didn't pick up the new build, and install_template re-pulled but didn't restart.
kind: recipe
tags: [image, rollout, update, latest, podman, pull, restart, deploy, versioning]
---

# Getting the box to run a freshly-pushed image

## The trap
For a service that is **already installed**, none of the obvious moves apply the
new build on their own:

- `install_template` re-pulls the image but does **not** restart the running
  unit — the old container keeps running the old layers.
- a plain service restart does **not** pull a newer `:latest` — Podman reuses the
  locally-cached image.

So a CI push to `:latest` sits unused until you explicitly pull *and* restart.

## The flow — pull, then restart
1. **Pull the new image** on the box (over MCP: `container_exec` / `exec_command`
   a `podman pull <image>:<tag>`, or re-run `install_template` which re-pulls).
2. **Restart the service** so the running pod recreates onto the newly-pulled
   image (`restart_service`).
3. **Verify the running digest** matches what CI published (`podman inspect
   --format '{{.Image}}'` on the container, or compare digests) — don't assume
   the restart picked it up.
4. **Box-verify** the feature end-to-end afterwards (health 200, unauth → 302,
   feature works). Green CI is not "the box runs it."

## Versioning expectation for external service images (ADR 0003 tension)
ServiceBay's own releases go through release-please + tags (ADR 0003). A
third-party service repo publishing `:latest` on `main` has **no version story**
— you can't tell which build is deployed, and rollback is impossible.

- **Prefer immutable, pinned tags** for a service image (a semver tag or the git
  SHA), and reference the pinned tag in the template. Then a redeploy is
  deterministic and rollback is "point the template at the previous tag."
- If you keep `:latest`, treat it as a *moving pointer for dev*, and still stamp
  each build with an inspectable version (label / `/healthz` version field) so
  the box can report which build it's running.

Related: `create-service`, `new-service-architecture` (image should be
independently buildable + fast-booting), and the `testing-and-ci-gate` standard
(only publish `:latest` on a green, threshold-passing test job).
