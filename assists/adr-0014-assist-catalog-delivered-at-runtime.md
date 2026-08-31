---
title: ADR 0014 — The assist catalog is delivered at runtime, not baked into the image
whenToUse: You are about to add or change an assist and want to know when it reaches a running box; you are wondering why assists/ is not in the Dockerfile; you are adding a second place assists could be read from; or get_assist/list_assists is refusing to answer and you need to know whether that is an outage or an empty catalog.
kind: adr
tags: [assists, catalog, delivery, release, docs-commit, image, one-source, mcp]
---

# ADR 0014 — The assist catalog is delivered at runtime, not baked into the image

## Status

Accepted (2026-08-31, #2701). Operator decision, 30.08.2026.

## Context

The catalog lived in the repo's `assists/` directory and was copied into the
container image (`COPY --from=builder /app/assists ./assists`). That made a
catalog entry an **image artifact rather than a document**, and the two halves of
the system then disagreed with each other while each looked internally
consistent:

- The right commit type for a catalog contribution is `docs(assists):`.
- `docs:` produces no version bump under release-please, so it produces no image.
- No image means the entry never reaches a running box.

The observed damage: nine entries merged on `main` were unreachable through
`get_assist` on the box for as long as no unrelated `feat`/`fix` happened to cut
a release. A neighbouring session reported the miss from the outside before
anyone here noticed. Worse, delivery had been "proved" locally against the
catalog loader — an in-process check that the loader resolves an id says nothing
about whether the entry is on the box, and it is precisely the check that did not
see this failure.

Two ways out were on the table: make the commit type follow the delivery (a
catalog commit cuts a release), or make the delivery follow the commit type (the
catalog is read at runtime). The operator chose the second.

## Decision

**The catalog is read at runtime. `assists/` is not copied into the image.**

1. `packages/backend/src/lib/assists/delivery.ts` pulls the repo's `assists/`
   tree onto the disk — a shallow, sparse `git` checkout of
   `ASSIST_CATALOG_REPO_URL` (default `mdopp/servicebay`) at
   `ASSIST_CATALOG_REF` (default `main`), under
   `DATA_DIR/assist-catalog/checkout`. It runs at server boot and hourly.
2. `resolveCatalogDir()` is the single gate every catalog read passes.
   `catalog.ts` has **no** `process.cwd()/assists` fallback any more.
3. `ASSIST_CATALOG_DIR` **replaces** that directory (used by `npm run dev`, which
   points it at the checkout's own `assists/`, and by tests). It never layers
   over it — an explicit override still leaves exactly one source.
4. `docs(assists):` is now the correct commit type. A catalog contribution takes
   effect on a running box within the sync interval, with no release.

### The condition this hangs on: exactly ONE source

A catalog that stayed in the image *and* was layered over from disk would be two
sources, one of which ages. **An assist that reads differently in the image than
on disk is worse than a missing one: it answers, and it answers wrongly.** So the
`COPY` is gone, and the Dockerfile carries a comment saying not to re-add it.

`DATA_DIR/local-assists/` survives, but it is **not a delivery path**. It holds
only what an admin approved through the assist editor (#2221), plus the additive
namespaced `landed/` dir (#2326 s4), which can never shadow a repo id. A
bare-id Local entry still overrides the repo entry — that is what an override is
for — but it can no longer do so quietly:

- it is served as `source: "Local (overrides repo)"` by `list_assists`, and
- it is listed by `list_assist_drift` with `relation: "override"`, alongside the
  landed-but-unpromoted backlog, with a hint naming the repo file to fold it into.

### A failed delivery is EMPTY and LOUD, never stale and quiet

`resolveCatalogDir()` throws `AssistCatalogUnavailableError` when

- delivery has never succeeded on this box, or
- the last successful delivery is older than `ASSIST_CATALOG_MAX_AGE_HOURS`
  (default 24 — i.e. 24 consecutive hourly failures).

A checkout that lands with zero `*.md` files counts as a **failed delivery**, not
an empty catalog. `list_assists`, `get_assist` and `list_assist_drift` return
that error text plus the delivery status (last attempt, last success, commit,
entry count, last error) instead of an empty list or a "no assist found with id
…". `get_service_standards` carries the same failure into
`adrCatalog.unavailable` rather than reporting `count: 0`.

So the reader of a broken box sees a catalog that says it is broken. What they
never see is last month's text answering as if it were current.

## Consequences

- **Good:** a catalog contribution is a `docs:` commit and needs no release; the
  commit type and the delivery path finally say the same thing.
- **Good:** there is one place to look when an assist reads wrong, and one place
  where an override shows up on a list somebody reads.
- **Cost:** a runtime path that must work. A box with no route to GitHub loses
  the catalog after the freshness window — deliberately, loudly.
- **Cost:** delivery cannot be proved in-process. **The proof is on the box**:
  `get_assist(<a newly merged id>)` answering on a running box, with no release
  in between. A green local test proves the loader, not the delivery — that is
  the exact substitution that produced #2701.
- The freshness window and the sync cadence are tunable per box
  (`ASSIST_CATALOG_MAX_AGE_HOURS`, `ASSIST_CATALOG_SYNC_INTERVAL_MS`) — these are
  thresholds, and per `footgun-importing-a-working-agreement-from-another-repo`
  thresholds are calibrated per house, not copied.

## Related

- `checklist-a-probe-that-cannot-fail-is-not-a-check` — never render a broken
  read as an empty result; this ADR is that rule applied to the catalog itself.
- `guide-contracts-between-agent-sessions` — why two texts answering to one id is
  the failure this decision exists to prevent.
- ADR 0003 (`adr-0003-releases-via-release-please-only`) — the release path this
  decision deliberately steps out of, rather than bending.
