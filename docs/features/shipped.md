# Shipped like a product

[← back to FEATURES](../FEATURES.md)

ServiceBay runs on a real Fedora CoreOS box in a family's home. A broken release
isn't a rollback — it's the family cloud going dark. So the pipeline is built so a
broken build **never becomes `:latest`**: it's gated at the PR, at the release
image, and against a real box before the release PR can merge.

## Gates at the PR (CI)

Every PR runs, in parallel (`.github/workflows/ci.yml`):

- **`typecheck`** — `tsc --noEmit` over all workspaces. Kept as its own job (and
  in the local per-unit gate) because `vitest` does not type-check — a type error
  would otherwise pass tests and only fail after push (#2172).
- **`lint` / `test`** — ESLint (incl. custom `sb/*` rules) + the full Vitest suite.
- **`invariants` / `depcruise` / `semgrep`** — the CI-enforced architecture rubric
  (file size, module boundaries, security patterns) —
  [ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md).
- **`lockfile`** — a strict `npm ci --dry-run` (#2131). The PR's own installs use
  lenient resolution, but the release Docker build runs strict `npm ci`, which
  hard-fails on any `package-lock.json` drift *after* a green PR. This job
  reproduces that strict resolution at PR time so drift is caught before it can
  strand the release image.

## Gate at the release image (smoke test)

The release workflow (`.github/workflows/release.yml`, #2155) does **not** push
`:latest` blindly:

1. Build the real release image into the local Docker daemon (`load`, no push).
2. Boot it and exercise `/health` end-to-end (`scripts/test-container-e2e.sh`).
   This catches the failure class PR CI can't see — a Turbopack bundle break, a
   `npm ci --omit=dev` dropping a runtime dep — because PR CI runs `npm test`, not
   the image build.
3. Only when the smoke test passes does the push step apply the real registry tags
   (every layer already cached from the load build — no second build).

## Gate against a real box (box-verify on `:dev`)

For any change touching a boot-critical path (install engine, config, agent, MCP,
system backup, the portal / dashboards), the autonomous pipeline verifies the
change against a **real Fedora CoreOS box on the `:dev` channel** before the
`:latest` release PR is allowed to merge:

- The box is flipped to `:dev`, the change is deployed with a **real**
  `sb stacks install` (not a hand-patch), verified, then flipped back to
  `:latest`.
- The release PR is blocked while box-verify is `owed` / `verifying` / `red`, and
  merges only when it's `green`.

This is why a change that compiles and passes tests can still be held: "the code
is correct" and "the box actually redeploys with it" are different claims, and the
`:dev` box is the gate for the second.

## Why it exists

Two incidents in project memory shaped this: a lockfile desync that passed a green
PR but broke the release image build (so the box couldn't update), and a
path-mandated change that was correct in tests but broke a real redeploy. Each gate
above targets one of those failure modes — PR CI for logic, the lockfile job +
smoke test for the image, box-verify for the redeploy.

## Related

- [ARCHITECTURE.md → Self-enforcing rubric](../ARCHITECTURE.md#self-enforcing-rubric)
  — the four tools behind the invariant gates.
- [ARCHITECTURE_INVARIANTS.md](../ARCHITECTURE_INVARIANTS.md) — what the build
  refuses to merge, and how to change a threshold deliberately.
- [INSTALLATION.md](../INSTALLATION.md) — the FCoS build pipeline the release image
  feeds.
