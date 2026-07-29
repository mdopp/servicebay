---
title: Rolling a new image onto an already-running service (:latest update flow)
whenToUse: CI pushed a new image for an installed service and you need the box to actually run it — a plain restart didn't pick up the new build, and install_template re-pulled but didn't restart. Also covers a stuck/stale image that keeps coming back on the old layers.
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

## The flow — one action does all of it
`manage_service(action="force-update", name="<service>")` re-checks the
registry, re-pulls every image the service declares, and force-removes its
containers so the unit *cannot* come back up on the cached image. It returns a
per-image report with `before` / `registry` / `after` digests, so you can see
whether anything actually moved instead of assuming it did. The operator
equivalent is **Force update** on the service's Actions tab. Neither depends on
`podman-auto-update.timer`, which stays masked until an update window is
configured.

The action stays at the `lifecycle` token tier (so routine automation and the
companion app keep it), but every force-update is treated as a **destructive
call**: it takes a `pre-mutation:manage_service:force-update` auto snapshot,
emails the operator, and logs the pre-update digest as a `Rollback anchor —
pre-update image digests: <image>@<digest>` line (also in the returned `logs`).
That digest is what you pin if the new image turns out to be worse than the old
one — nothing else records it once the containers are recreated.

- `changed: true` → a new image landed and the containers were recreated on it.
- `stale: true` → the registry serves a newer digest but the local image did not
  change. Retry with `fresh: true` (UI: the **Fresh pull** button that appears)
  — that deletes the local image before pulling. An image another service is
  also running is kept rather than deleted out from under it.

Then **box-verify** the feature end-to-end (health 200, unauth → 302, feature
works). Green CI is not "the box runs it", and neither is a green pull.

## Doing it by hand (older boxes / no ServiceBay control plane)
1. **Pull the new image** on the box (over MCP: `container_exec` / `exec_command`
   a `podman pull <image>:<tag>`, or re-run `install_template` which re-pulls).
2. **Recreate the container** — `podman rm -f <container>` *then* start the unit.
   A plain restart reuses the existing container and keeps the old image.
3. **Verify the running digest** matches what CI published (`podman inspect
   --format '{{.Image}}'` on the container, or compare digests) — don't assume
   the restart picked it up.

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
