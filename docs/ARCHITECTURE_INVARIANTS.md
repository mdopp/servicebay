# Architecture Invariants

The rubric that defines "ServiceBay's architecture is still good."

Each invariant below is **mechanically enforced** by one of three tools running in CI. A passing build means the rubric holds. A failure means a specific line crossed a defined boundary — not a subjective "feels off."

Decisions that **can't** be mechanically enforced — operator-facing UX choices, incident-driven safety cascades, the user's deliberate config quirks — live in [UX_DECISIONS.md](UX_DECISIONS.md). Read both before changing anything that looks weird.

The durable **architecture decisions (ADRs)** — why SSO is mandatory, why installs are non-destructive, which pods may keep `hostNetwork`, how service tokens are scoped — live in the **assist catalog** as [`assists/adr-*.md`](../assists/) (`get_assist("adr-0007-…")`, `list_assists`), not under `docs/adr/`, which now holds signposts only. Index: [adr/README.md](adr/README.md). This file says what a script enforces; the ADRs say what was decided and why.

This document is the *intent* layer; the configs are the *enforcement* layer:

| Tool | Config | Catches |
|---|---|---|
| `scripts/check-invariants.ts` | constants at the top of each check | Aggregate metrics — file size, adoption ratios, budgets; plus the two *meta* gates below |
| `scripts/check-diff-coverage.ts` | `.diff-coverage.json` | New-code test coverage — added/modified lines vs a ratchetable floor |
| `.dependency-cruiser.cjs` | depcruise | Module boundary rules — forbidden import edges, circular deps |
| `.semgrep.yml` | semgrep | Security & coupling patterns — line-level pattern matching |
| `eslint.config.mjs` (custom `sb/*` rules) | eslint | IDE-time feedback for the highest-traffic patterns |

Run the full suite locally:

```bash
npm run check:arch      # invariants + backup-coverage + depcruise
npm run lint            # ESLint, includes sb/* rules
# Semgrep — run via docker or podman (no host install needed). Pin the same
# tag CI's `semgrep` job pins, so a local run and CI can't disagree:
podman run --rm -v "$PWD:/src:Z" docker.io/returntocorp/semgrep:1.172.0 \
    semgrep --config /src/.semgrep.yml --metrics=off /src
```

CI: see the `invariants`, `depcruise`, and `semgrep` jobs in `.github/workflows/ci.yml`.

### Three meta-invariants: a gate that scans nothing, a gate that runs nowhere, and a gate that never asked

All three report **green** and are indistinguishable from a real pass. All three
have bitten this repo. The first two are enforced by
`scripts/check-invariants.ts`; the third is enforced inside the gate that had it
(`scripts/check-backup-coverage.ts`, see the bullet after these two):

- **`gate-path-resolves`** — every path/glob a gate config names must match at
  least one tracked file. Covers each glob under a `paths:` block in
  `.semgrep.yml` and the depcruise roots on the `check:deps` command line;
  `SECURITY_PATHS` and `DURABLE_STATE_MODULES` carry the same assertion inside
  their own checks. Glob semantics follow gitignore / Semgrepignore v2 — the
  interpretation semgrep is migrating to — so a path that works *only* under
  semgrep's legacy unanchored matching fails here today rather than silently
  emptying the rule on the next image pull. (#2379 left `src/…` roots in
  `check-invariants.ts`; #2428 found the same rot in three `.semgrep.yml`
  rules.) The semgrep image in CI is **pinned** for the same reason — a
  floating tag means upstream can change scanning behaviour with no commit here.
- **`ci-runs-every-check-script`** — every `check:*` script in `package.json`
  must be reachable from `.github/workflows/`, and every `npm run <script>` a
  workflow invokes must exist in `package.json`. An aggregator (`check:arch`)
  counts as covered when each script it chains is covered, so CI may run the
  members as parallel jobs. (#2429: CI reimplemented `check:arch` piecemeal and
  dropped `check:backup-coverage` — the only gate between "a template ships a
  new persistent volume" and "the box loses that data on a disk-loss
  reinstall".)
- **`backup-coverage enumerates, it does not grep`** — the third shape: the gate
  ran, over the right files, and still reported green **about a question it
  never asked**. `check:backup-coverage` used to scan `hostPath:` blocks, so a
  template keeping real config in a `PersistentVolumeClaim` was not "uncovered"
  — it never entered the check (#2596: Syncthing's device identity + folder
  shares). It now parses each `template.yml` and enumerates every
  `spec.volumes[]` entry, classifying each by kind: an unknown kind is an
  **error**, not a skip; a template that will not parse is an **error**, not
  zero volumes; and the kinds that hold no state are listed with reasons in
  `EPHEMERAL_VOLUME_KINDS`. Same ratchet direction as #2465 (a bare `{{VAR}}`
  hostPath now fails closed instead of being dropped for being off-pattern):
  when the gate cannot tell, it fails.

---

## How to change a threshold

Thresholds are **deliberate decisions**, not aspirational defaults. Two paths:

1. **Ratchet down** (tighten): preferred. Drop a file from an exemption list, lower a max, raise a ratio floor. Land in the same PR as the fix that makes it possible.
2. **Loosen**: requires a one-line justification in the config comment naming *what changed in reality* (not "we wanted more slack"). If you find yourself loosening repeatedly, the threshold is wrong — re-examine.

`scripts/check-invariants.ts` calls out the ratchet target for each metric inline. The depcruise config marks every exemption with a TODO and links to the underlying issue.

---

## The invariants

### Thresholds — generated, not typed (#2427)

The block below is **written by the script from its own constants**; editing it
by hand fails `check:invariants`. Regenerate after changing a constant:

```bash
npm run check:invariants -- --write-docs
```

The **measured** values at HEAD are deliberately *not* stored in this file —
`npm run check:invariants` prints them at the top of every run. A measurement
checked into a doc is stale the next time anyone merges, which is exactly how
this page came to assert a wrong largest-file name, a wrong file count, and a
`DigitalTwinStore` threshold of 35/40 when the enforced constant was 0.

<!-- BEGIN GENERATED: thresholds — do not edit by hand -->

| Invariant | Constant in `scripts/check-invariants.ts` | Threshold |
|---|---|---:|
| Max file LOC (each source root) | `MAX_FILE_LOC` | 1,700 |
| `as any` in security paths | `SECURITY_AS_ANY_BUDGET` | 0 |
| `as any` in `packages/backend/src` outside security paths | `BACKEND_AS_ANY_BUDGET` | 24 |
| `: any` annotations in `packages/backend/src` (security paths included) | `BACKEND_COLON_ANY_BUDGET` | 79 |
| `executor.exec` template-literal call sites | `EXEC_TEMPLATE_LITERAL_MAX` | 0 |
| `executor.execArgv` call sites (deprecated alias for `execSafe`) | `EXEC_ARGV_MAX` | 0 |
| `withApiHandler` adoption across `route.ts` files | `MIN_WITH_API_HANDLER_RATIO` | 100% |
| `DigitalTwinStore.getInstance()` call sites | `TWIN_GETINSTANCE_MAX` | 0 |
| Bare `fs.writeFile`/`writeFileSync` in durable-state modules | `DURABLE_STATE_BARE_WRITE_BUDGET` | 0 |
| Durable stores adopted onto `defineStore` (floor, forward-only) | `VERSIONED_STORE_MIN` | 2 |
| Bare `setInterval` in `packages/backend/src` outside `packages/backend/src/lib/runtime` | `BACKEND_BARE_SETINTERVAL_BUDGET` | 0 |

Source roots walked: `packages/frontend/src`, `packages/backend/src`.

Security paths (`SECURITY_PATHS`): `packages/backend/src/lib/auth`, `packages/backend/src/lib/mcp`, `packages/backend/src/lib/agent/executor.ts`, `packages/frontend/src/proxy.ts`.

Durable-state modules (`DURABLE_STATE_MODULES`): `packages/backend/src/lib/config.ts`, `packages/backend/src/lib/health/store.ts`, `packages/backend/src/lib/health/bootState.ts`, `packages/backend/src/lib/network/store.ts`.

Versioned stores (`VERSIONED_STORE_MODULES`): `packages/backend/src/lib/health/bootState.ts`, `packages/backend/src/lib/network/store.ts`.

_Generated from the constants — run `npm run check:invariants -- --write-docs` after changing one. For the **measured** values at HEAD run `npm run check:invariants`: they are deliberately not stored here, because a hand-maintained measurement table is stale the next time anyone merges (#2427)._

<!-- END GENERATED: thresholds -->

### Structural

| Invariant | Enforced by |
|---|---|
| Max file LOC (each source root) | `check-invariants.ts:MAX_FILE_LOC` |
| Files > 2,000 LOC | (untracked — reported by the run, no threshold) |
| Functions > 150 LOC | (untracked) |

**File-size ceiling.** Two roots, **one** pin, and it only ever goes **down**: each god-module cut lowers `MAX_FILE_LOC` to the next-largest survivor, so the file that was just split cannot grow back and the next-biggest file inherits the pressure. The backend root was **not walked at all** until #2379, which enforced it behind a temporary, looser `MAX_BACKEND_FILE_LOC` (2,400) pinned to `lib/mcp/server.ts` at 2,391; #2384 split that file into `lib/mcp/tools/*` (one module per tool group) and the separate backend pin was deleted, so both roots share `MAX_FILE_LOC` again. #2743 cut the two 2k frontend god modules — `dashboards/NetworkDashboard.tsx` 2,149 → 1,421 (graph node/edge renderers and the legend now live in `dashboards/_lib/NetworkGraph*.tsx`) and `app/(dashboard)/backup/page.tsx` 1,851 → 62 (one component per backup backend under `backup/_lib/`) — and lowered the pin from 2,200 to **1,700**.

Ratchet target is still **1,500**. Exactly two files block it, and each needs its own cut rather than an exemption: `components/OnboardingWizard.tsx` (1,668 — a second per-step split) and `packages/backend/src/lib/registry.ts` (1,505). Lower the constant to the next-largest survivor as each lands.

### Type safety

| Invariant | Enforced by |
|---|---|
| `as any` in security paths | `check-invariants.ts:SECURITY_AS_ANY_BUDGET` |
| `as any` in `packages/backend/src` outside security paths | `check-invariants.ts:BACKEND_AS_ANY_BUDGET` |
| `: any` annotations in `packages/backend/src` | `check-invariants.ts:BACKEND_COLON_ANY_BUDGET` (#2723) |

**Both spellings are gated (#2723).** `as any` is the cast, `: any` the
annotation; both erase the type, so budgeting one and not the other just moves
the erasure to the cheaper spelling — which is where it had accumulated. The
`: any` ratchet covers **all** of `packages/backend/src` (non-test), security
paths included, because there is no separate security budget for it.

**Security paths** are listed in the generated block above (`SECURITY_PATHS`). Non-test only. Ratchet target reached — the budget is 0, so any new cast in these paths fails CI. The list must stay repo-relative: it carried pre-workspace-split `src/...` paths until #2379, which made the check resolve zero files and pass vacuously. Since #2428 a listed path that does not resolve is itself a violation, so that cannot recur silently.

### Coupling

| Invariant | Enforced by |
|---|---|
| `DigitalTwinStore.getInstance()` call sites | `check-invariants.ts:TWIN_GETINSTANCE_MAX` |
| `lib → app` imports | `.dependency-cruiser.cjs:lib-no-import-app` (#600) |
| `lib → components` imports | `.dependency-cruiser.cjs:lib-no-import-components` |
| `lib → dashboards` imports | `.dependency-cruiser.cjs:lib-no-import-dashboards` |
| Circular dependency cycles | `.dependency-cruiser.cjs:no-circular` (#601 — final cycle broken by extracting `verifyNodeConnection` out of `nodes.ts`) |
| Forks of the Mustache renderer | `.dependency-cruiser.cjs:one-renderer` (#599) |
| NPM's admin API spoken to outside `lib/npm/` | `.dependency-cruiser.cjs:npm-api-only-from-lib-npm` + `scripts/invariants/npmApiLiterals.ts` (#2731) |
| Bypasses of `ServiceManager` facade | `.dependency-cruiser.cjs:service-manager-single-mutation-path` |

**Twin singleton fan-in.** Ratcheted to 0 — every read goes through `packages/backend/src/lib/store/repository.ts`; the store itself, the repository, and the backend `server.ts` bootstrap are the only allowed call sites.

**Circular deps.** Every new cycle fails CI immediately.

**One NPM client (#2731).** Nginx Proxy Manager's admin API (`/api/nginx/proxy-hosts`, `/certificates`, `/access-lists`) is spoken to from `packages/backend/src/lib/npm/` only: `http.ts` is the transport (bearer, JSON, abort budget, never throws on an HTTP status), `proxyHosts.ts` / `certs.ts` / `accessLists.ts` the typed client, `client.ts` the discovery + login (#2730). The proxy-hosts orchestration (create-or-reconcile, cert acquisition, conf-file patching, persistence, health-check sync) is the kernel in `lib/reverseProxy/proxyHostProvisioning.ts`; the HTTP route and the MCP `create_proxy_route` / `remove_proxy_route` / `get_proxy_routes` tools are thin callers of it. Two gates, because one is blind: the depcruise rule keeps `lib/npm/http.ts` import-private (only `lib/npm/` may import it), and the grep invariant fails any `/api/nginx` literal in non-test source outside `lib/npm/` — a caller that re-derives the URL with a bare `fetch` never shows up in the import graph. Before #2731 that client existed eleven times (route, migration orchestrator, two health probes, four diagnose probes, MCP tools), each with its own timeout and error text. `/api/tokens` and `/api/users` are deliberately outside this rule: they are NPM's auth surface, owned by `lib/npm/client.ts`, the auth probe and the bootstrap rekey.

**Which packages depcruise walks.** `check:deps` cruises **every** workspace package's `src`: `packages/{api-client,backend,backup-manifest,backup-worker,disk-import-worker,frontend}/src`. There is no carve-out. `packages/disk-import-worker` was the last one outside, on a real `no-circular` violation (`cli/main.ts` ⇄ `server/index.ts`: serve mode lazily `import('../server/index')`ed the CLI, and `server/index.ts` imported the two content hashers back out of it). #2747 broke it by moving `fingerprintFileContent` down into `engine/hashFile.ts` next to `hashFileContent`, so both entrypoints take the hashers from the engine layer they already depend on and the edge points one way. A new package goes on that command line when it is created — never an exemption to make one pass.

### Code-style / consistency

| Invariant | Enforced by |
|---|---|
| `executor.exec(\`…${x}…\`)` call sites | `check-invariants.ts:EXEC_TEMPLATE_LITERAL_MAX` + `sb/no-exec-template-literal` |
| `withApiHandler` adoption (route.ts files) | `check-invariants.ts:MIN_WITH_API_HANDLER_RATIO` + `sb/api-route-needs-handler` |

**executor.exec template literals.** Ratcheted to 0 in #602. ESLint rule `sb/no-exec-template-literal` is `error` everywhere — every previous offender was converted to `execArgv`. `EXEC_TEMPLATE_LITERAL_MAX = 0` in `check-invariants.ts` blocks any regression. The aggregate check walks **both** source roots; it walked the frontend only (where no `executor.exec` call site has ever lived) until #2428, so the count `.semgrep.yml` calls "the single source of truth" was measured over none of the code it guards.

**withApiHandler adoption.** `@/lib/api/handler` provides shared Zod validation + error envelope + ApiError short-circuiting. The #603 burn-down completed the migration — every `route.ts` file uses `withApiHandler` / `withApiHandlerParams`. The floor is locked at 100%; every new route must use the wrapper. Enforced as a hard error by the `sb/api-route-needs-handler` ESLint rule (per verb export) and the `check-invariants.ts` ratio (per file). Intentionally-public routes (login, OIDC, family-portal submission) wrap with `{ skipAuth: true }` to opt out of the requireSession gate while keeping the shared envelope.

### Test coverage (new code only)

| Invariant | Current | Threshold | Enforced by |
|---|---:|---:|---|
| New-line coverage (added/modified lines vs base) | — | 70% | `check-diff-coverage.ts` + `.diff-coverage.json:minLineCoverage` |

**Diff coverage, not a global threshold (#1548).** A repo-wide coverage floor would fail on years of pre-coverage legacy debt, so the gate measures only the lines this branch *adds or modifies*: `scripts/check-diff-coverage.ts` intersects `git diff --unified=0 <base>` with the v8 coverage report (`coverage/coverage-final.json`, from `npm run test:coverage`) and fails when the share of new executable lines that are covered falls below `minLineCoverage`. Untouched legacy code is never measured. Runs in the **full/seal gate** (the CI `test` job), not the autoloop's per-issue fast gate (which stays `vitest --changed`, no coverage overhead). The floor starts at 70% and is ratcheted up over time like every other invariant — edit `.diff-coverage.json` with a justification. `minChangedLines` exempts trivially small diffs from the 0%/100% noise floor.

**Service test gate — 70% diff-coverage floor, ≥85% total target, build-gates-on-tests (#2345).** A ServiceBay *service* (shipped as a template, built in its own repo) is held to the same test discipline the platform holds itself to: the box must never run code that did not pass tests at threshold. A new/changed service must ship a real test suite (Python: `pytest` — unit + TestClient API tests + the SSO-guard check + bad-input-is-4xx-not-500), measure coverage over the app package with **thread/async coverage on** (`concurrency=["thread"]`, or background-job code reads false-low), hold the platform's **70% diff-coverage floor** and target **≥85% total**, and — critically — its **CI must gate image publish on a green test job** (the build/publish job `needs:` the test job; a build-only CI is non-compliant). This is a service-repo standard (enforced in that repo's CI, not in this repo's `check:arch`); it is canonical here so `get_service_standards` and box-verify can hold a service to it. Full checklist: `assists/testing-and-ci-gate.md`.

### Durable state (crash safety)

| Invariant | Enforced by |
|---|---|
| Bare `fs.writeFile`/`writeFileSync` in durable-state modules | `check-invariants.ts:DURABLE_STATE_BARE_WRITE_BUDGET` |
| Adopted stores keep declaring `defineStore` (forward-only list) | `check-invariants.ts:VERSIONED_STORE_MODULES` / `VERSIONED_STORE_MIN` |

**Durable-state writes are atomic (#2414).** `config.json` and `checks.json` under `DATA_DIR` are the operator's data, not caches: losing `config.json` re-onboards the box (domain, auth and service config gone, wizard opens on a configured box), losing `checks.json` drops every configured health check. A bare `fs.writeFile`/`writeFileSync` truncates the target *before* the new bytes land, so a power cut / OOM-kill / container stop mid-write destroys the file permanently. `packages/backend/src/lib/util/atomicWrite.ts` is the only sanctioned writer — `atomicWriteFile` (async) and `atomicWriteFileSync` (sync twin, for the stores whose public API is sync) both do tmp → fsync → rename, so a crash leaves the *original* intact.

The modules held to this are listed in `DURABLE_STATE_MODULES` (`check-invariants.ts`) and enumerated in the generated block above. The list is repo-relative and **forward-only** — add a module when it starts owning durable `DATA_DIR` state; never delete one to make a bare write pass. Unlike the older path-based checks, a listed path that does **not** resolve is itself a violation, so a move/rename can't silently disable the gate the way the pre-#2379 `SECURITY_PATHS` did. `atomicWrite.ts` is deliberately not on the list — it *is* the primitive. Crash behaviour is proved by fault injection in `tests/backend/durable_write_crash_safety.test.ts` (each survival case is paired with a control that performs the pre-fix truncate-then-partial-write and must destroy the file).

Explicitly out of scope: `health/store.ts` result files are a cache, cheap to rebuild — `writeResults` rides the atomic helper anyway because it shares the module. (`health/bootState.ts` was in this exemption until #2739 adopted it onto `defineStore`, which put its heartbeat write on `atomicWriteFileSync`.)

**Durable stores are versioned; migrations are forward-only (#2739).** Writing durably is half the problem; the other half is *changing the shape* of what is written. `packages/backend/src/lib/store/defineStore.ts` is the mechanism: a store declares `{ name, schema, version, migrations }`, a file at an older version is pulled forward through every registered migration on load, and a file at a **newer** version is refused loudly — on read *and* on write — rather than being silently overwritten by a downgraded build. A file with no envelope is version 0, so adopting an existing store means registering the `migrations[1]` that names its pre-adoption on-disk shape; no flag day, and the next write re-stamps the file. The predecessor pattern — a `CURRENT_SCHEMA_VERSION` field nothing ever branched on — was deleted in #2725 and must not come back. Rationale and the full rule: ADR 0016 (`assists/adr-0016-durable-stores-are-versioned-and-forward-only.md`).

Adoption is store-by-store, so the gate is a growth ratchet rather than a budget: `VERSIONED_STORE_MODULES` (enumerated in the generated block above) may only get longer, every listed module must still call `defineStore` and must also appear in `DURABLE_STATE_MODULES`, and a listed path that no longer resolves is a violation. Un-adopting a store means lowering `VERSIONED_STORE_MIN` — a visible, deliberate edit. `defineStore.ts` itself is deliberately absent from the list for the same reason `atomicWrite.ts` is: it *is* the mechanism. The envelope is proved not to weaken #2414 by a third fault-injection case in `tests/backend/durable_write_crash_safety.test.ts`.

### Background work (runtime kernel, #2738)

| Invariant | Enforced by |
|---|---|
| Bare `setInterval` in `packages/backend/src` outside `lib/runtime/` | `scripts/invariants/backgroundTasks.ts:BACKEND_BARE_SETINTERVAL_BUDGET` |

**Every recurring backend job is a registered background task.** Before #2738 the
backend had **13** bare `setInterval` calls across seven modules and `server.ts`.
None was cleared on SIGTERM, so a restart could leave a tick mid-flight writing
to a store the process was already tearing down; and the only thing declaring
boot order for ~30 subsystems was where a call happened to sit in an 800-line
linear boot script.

`packages/backend/src/lib/runtime/` is the kernel. `timers.ts` owns the single
`setInterval` call site and hands back a named, idempotently-cancellable
`ManagedInterval` whose callback is wrapped so a throwing tick logs instead of
killing the process. `lifecycle.ts` owns the registry: `registerBackgroundTask`
/ `registerIntervalTask` declare `{ name, start, stop }`, `startBackgroundTasks`
starts them in registration order (a task registered later — e.g. from the
`server.listen` callback — starts immediately and still joins the shutdown
order), and `runGracefulShutdown` on SIGTERM/SIGINT stops every task in
**reverse registration order**, then drains the sockets, then exits. Reverse
order makes teardown the mirror of boot: a task can rely on everything
registered before it still being alive while it stops. Each stop is logged, so
`journalctl --user -u servicebay` shows an ordered teardown instead of silence.
The ordering, the late-registration path and the force-exit timer are proved on
fake timers in `packages/backend/src/lib/runtime/lifecycle.test.ts`.

`server.ts` therefore holds the **task list**, not timers. The budget is **0**
and downward-only: a new recurring job registers a task. Tests are exempt (they
drive their own clock) and the kernel directory is exempt because it *is* the
mechanism — the same carve-out `lib/util/atomicWrite.ts` gets from the
bare-write budget. `RUNTIME_KERNEL_DIR` is asserted to resolve to a non-empty
file set, so moving the kernel cannot silently disable its own gate (#2379).

### Security boundaries (pattern enforcement)

Enforced by `.semgrep.yml`. ERROR severity = build-blocking; WARNING = reported only.

| Pattern | Severity | Where |
|---|---|---|
| `executor.exec` with template-literal interpolation | ERROR | all non-test |
| Direct `tar -x...` outside `safeTarExtract` (#580, #590) | ERROR | all except `packages/backend/src/lib/systemBackup.ts` (where `safeTarExtract` lives) |
| `child_process.exec/execSync` with non-literal | WARNING | `packages/*/src/` |
| `eval`, `new Function`, string-form `setTimeout`/`setInterval` | ERROR | everywhere |
| `fetch(config.issuer …)` / `fetch(config.host …)` without SSRF guard | WARNING | all |

### Architecture-doc invariants (already documented in `ARCHITECTURE.md` audit)

These are enforced as depcruise rules:

- **One mutation path per operation** — every deploy/delete/start/stop/restart/update goes through `ServiceManager`. Direct imports of `serviceLifecycle`/`serviceListing` from outside `packages/backend/src/lib/services` are forbidden.
- **One renderer** — all Mustache rendering goes through `packages/backend/src/lib/template/render.ts` (post-#599). No exemptions remain: the `one-renderer` depcruise rule's `pathNot` list is `render.ts` alone, and the only other file in the repo importing `mustache` is `tests/backend/template_consistency.test.ts`. (This page claimed `install/runner.ts` and `stackInstall/*` were still exempt until #2427 — they had not been for some time.)
- **One Digital Twin store** — singleton via `DigitalTwinStore.getInstance()`. Fan-in cap enforced by `check-invariants.ts`.
- **One NPM client** — every `/api/nginx/*` call goes through `packages/backend/src/lib/npm/` (post-#2731). `npm-api-only-from-lib-npm` keeps the transport import-private; `scripts/invariants/npmApiLiterals.ts` catches the string-literal bypass depcruise cannot see.

### One assist-catalog source (#2701, ADR 0014)

The assist catalog is **delivered at runtime** — pulled from the repo onto the
box's disk by `packages/backend/src/lib/assists/delivery.ts` — and is
deliberately **not** copied into the container image. Two copies would age apart,
and an assist that reads differently in the image than on disk is worse than a
missing one: it answers, and answers wrongly.

`check-invariants.ts:checkAssistCatalogSingleSource` fails the gate on either way
back to two sources:

- a `COPY … assists` line in the `Dockerfile`, or
- a `process.cwd()/assists` fallback in `packages/backend/src/lib/assists/catalog.ts`.

The other half of the contract is behavioural and lives in `delivery.ts`: a
delivery that has never succeeded, or whose last success is older than
`ASSIST_CATALOG_MAX_AGE_HOURS`, makes every catalog read throw
`AssistCatalogUnavailableError`. The failure mode is **empty and loud**, never
stale and quiet.

### Frontend ↔ Backend boundary (#753)

Enforced **structurally** via the workspace layout as of Phase 3.3 (#764). The three numeric ratchets (`fe-template-lib-imports`, `fe-backend-imports`, `fe-install-helpers`) that watched specific FE→BE leakage points have retired — the workspace boundary makes a forbidden import physically unresolvable, so a count check is redundant.

Layout:

| Package | Path | Owns | Allowed imports |
|---|---|---|---|
| `@servicebay/api-client` | `packages/api-client/` | typed seam: shared types + zod schemas + `typedFetch` helper | `zod` only |
| `@servicebay/frontend` | `packages/frontend/` | UI + Next.js App Router (`src/app/**/route.ts`, `src/app/**/page.tsx`, `src/proxy.ts`, custom `server.ts`) | `@servicebay/api-client` + UI libs + (still) backend via `@/lib/*` — see "leaky alias" caveat below |
| `@servicebay/backend` | `packages/backend/` | server-side: agent, install, diagnose, network, store, … | `@servicebay/api-client` + runtime deps |

Post-Phase-3.3 there is no root-level source tree — `src/` at the repo root is empty. The Next.js custom server (`server.ts`) lives inside `packages/frontend/` and is mounted via the workspace's own build scripts.

What enforces what:

- **Workspace deps** (`package.json#dependencies`): `packages/frontend/package.json` does not list `@servicebay/backend` directly. A `@servicebay/backend/*` import from frontend would fail to resolve at build time.
- **tsconfig paths — leaky alias caveat**: `packages/frontend/tsconfig.json` still defines `@/lib/*` → `../backend/src/lib/*` because the App Router handlers under `src/app/api/**/route.ts` need server-side modules. Several hundred imports flow through this alias (`git grep -c "from '@/lib/" packages/frontend/src | …` for the count of the day — it is not pinned here, see #2427). depcruise can't see through path aliases, so the FE → BE direction is structurally enforced but spirit-leaky. Tightening this is tracked in #977.
- **`sb/no-fe-backend-import` ESLint rule**: editor-time signal + defense-in-depth. Catches `@/lib/*` and `@servicebay/backend/*` imports under `packages/frontend/**`.
- **`depcruise`**: `lib-no-import-app`, `lib-no-import-components`, `lib-no-import-dashboards` rules forbid backend → frontend imports.

Frontend reaches the backend exclusively through:

- `@servicebay/api-client` — typed seam (default for new code).
- Direct `fetch('/api/...')` — grandfathered for ~80 legacy call sites; new code uses `typedFetch`.

**No Server Actions under `packages/frontend/src/app/actions/`** — enforced by the
depcruise rule `no-app-actions`, not by this paragraph (#2745). The directory held
nodes / ssh / onboarding CRUD as the *only* implementation of those surfaces, with
`getNodes` defined identically in two of its modules. Because Server Actions are
routed on page paths, the `/api/*`-only gate in `proxy.ts` never covered them and
each action had to remember `assertAdminSession()` itself (#1203). They are now
`withApiHandler` routes under `/api/system/{nodes,ssh,onboarding,os-updates}` behind
zod-contracted api-client methods, which pick up the session gate structurally and
the 401 → `/login` redirect via `apiFetch`. A new server-side surface is a route
handler plus an api-client method — never a new action module.

---

### UI-primitive and design-token reuse (#2353)

The frontend ships a hand-rolled design system — the primitives under
`packages/frontend/src/components/ui/`
(`Button`/`Card`/`Field`/`DataTable`/`Badge`/`StatusDot`/`SectionHeading`/`PageScroll`,
imported from `@/components/ui`) and the semantic token layer in
`packages/frontend/src/app/globals.css` (`@theme inline`: `accent`, `surface`,
`border`, `text`, the `status-*` ramp, `on-accent`, radius/spacing scales,
Tailwind v4). Two ESLint rules keep new UI on those rails instead of
re-authoring raw elements + hard-coded colours (which caused drift + duplicates):

- **`sb/no-raw-ui-primitive`**: forbids raw JSX `<button>` (→ `Button`),
  `<table>` (→ `DataTable`), and `<input>`/`<select>`/`<textarea>` (→ `Field`)
  in frontend surfaces. The message names the primitive to use.
- **`sb/no-raw-color-literal`**: forbids raw colour literals — hex
  (`#rrggbb`), `rgb()/hsl()`, and raw Tailwind numeric colour utilities
  (`text-/bg-/border-/ring-/from-/to-{palette}-{n}` like `text-blue-500`) — in
  favour of the semantic `@theme` token utilities.

Both are **scoped to `packages/frontend/src/**` and EXEMPT
`packages/frontend/src/components/ui/**`** (the primitives legitimately wrap the
raw elements and map raw colours to tokens internally) plus `*.test.*`.

**Severity is `warn` during rollout.** A one-shot fix was infeasible: the
colour rule alone fires ~3,100 times across ~85 files, and rewriting each to a
token while keeping every component visually identical is far past one unit's
safe blast radius. `warn` keeps the 0-error lint gate green while surfacing
every new + legacy violation in the editor and CI. **Ratchet plan:** burn the
count down file-by-file via lint-sweep units, then flip each rule to `error`
once its class reaches 0 — forward-only, never loosen. The `TODO(#2353)` in
`eslint.config.mjs` tracks the two flips (colour-literal, ui-primitive).

#### The ratchet is enforced, and here is how the flip happens (#2430)

A `warn` plus a prose promise is not a rollout — it is a TODO. Measured over 36
commits the two counts moved by exactly **zero** while violations were *moved*
between files (a component extracted; the same eight primitives reappearing
verbatim in the new file), so the plan above is now backed by a gate:

- **`npm run check:lint-ratchet`** (`scripts/check-lint-ratchet.ts`) counts every
  rule in its `RATCHETED_RULES` list from ESLint's own `--format json` report
  over `packages/frontend/src` and compares them to
  `.eslint-ratchet-baseline.json`. **A count may only go
  down.** Chained from `check:arch` (so the autoloop's per-unit fast gate runs
  it) and run in CI's `invariants` job as `-- --check`.
- **`--check` is CI mode:** never writes. An increase fails the PR; a *decrease*
  passes and prints that the committed baseline has slack. A local run (no
  flag) rewrites the baseline downward — that is the only way a number in that
  file ever changes. **Never raise a baseline number by hand**; it is the one
  thing the file exists to prevent. A sweep therefore commits its code change
  *and* the tightened baseline together.
- **The flip to `error`,** per rule, when its baseline reaches **0**: set that
  rule to `"error"` in `eslint.config.mjs` (the `packages/frontend/src` block),
  drop it from `RATCHETED_RULES` in `scripts/check-lint-ratchet.ts` and from
  `.eslint-ratchet-baseline.json` (ESLint's own 0-error gate owns it from then
  on), and delete its half of the `TODO(#2353)` ROLLOUT comment. The script
  prints this instruction whenever a count hits 0. The rules flip
  **independently** — `no-raw-ui-primitive` is the far smaller class and will
  clear first; it must not wait on the colour migration. (For the counts at
  HEAD run the script — they are deliberately not typed here, #2427.)
- **The burn-down itself** is ordinary lint-sweep work (worst files first; the
  gate prints the current top ten on a failure). The ratchet's job is only to
  guarantee the direction — it does not schedule the sweeps.

Rules currently under the ratchet — the counts live in
`.eslint-ratchet-baseline.json`, not here (#2427):

| Rule | Scope | Exempt | Flip target |
|---|---|---|---|
| `sb/no-raw-color-literal` | `packages/frontend/src/**` | `components/ui/**`, `*.test.*` | `error` at 0 (#2353) |
| `sb/no-raw-ui-primitive` | `packages/frontend/src/**` | `components/ui/**`, `*.test.*` | `error` at 0 (#2353) |
| `sb/no-raw-api-fetch` | `packages/frontend/src/**` | `app/api/**`, `app/napi/**`, `*.test.*` | `error` at 0 (#2736) |

### A single typed API seam (#2736)

`apiFetch` in `packages/api-client/src/apiFetch.ts` is **the** client-side
401 → `/login` handler. There used to be three: a global `window.fetch`
monkey-patch installed as an import-time side effect of
`packages/frontend/src/providers/DigitalTwinProvider.tsx`, this wrapper (with
zero callers), and a duplicated `ANONYMOUS_PATHS` set inside
`packages/frontend/src/hooks/useSocket.ts`.

The monkey-patch is the one that mattered, and it is **gone**. A global patch
covers every raw `fetch('/api/...')` silently, so session-expiry handling was
inherited by accident — which made migrating call sites look like busywork
while their number kept growing. One explicit seam beats an invisible one:

- The REST 401 path is `apiFetch` (opt-in, per call).
- The socket `unauthorized` path in `useSocket.ts` imports
  `isAnonymousPathname` from the same module instead of keeping a second copy
  of the path set "in sync" by comment.
- **Do not reintroduce a global fetch patch.** If a call site needs 401
  handling, it calls `apiFetch`; that is the whole contract.

Consequence, stated plainly: a raw `fetch('/api/...')` in the frontend no
longer redirects on session expiry. That is the pressure — `sb/no-raw-api-fetch`
counts those call sites and the ratchet above forbids the count from rising, so
lint-sweep units burn them down file by file exactly like the #2353 rules. The
Next route handlers under `app/api/**` and `app/napi/**` are exempt: they are
the *server* side of this seam and have no browser session to bounce.

### Duplicate detection (#2354)

A companion to the reuse rules above — *you can only extract what you can see*:

- **Component catalog — removed (#2729).** `/dev/components` was a living
  gallery of every `@/components/ui` primitive, gated dev-only behind a
  `notFound()`. Nothing linked to it and nobody opened it, so it rotted while
  still costing a page, a test and a maintenance rule ("add your primitive's
  gallery entry"). The barrel `packages/frontend/src/components/ui/index.ts` is
  now the only discovery surface — read it to see what exists before writing a
  new primitive. Do not reintroduce a second rendering surface for one reader.

- **Frontend duplicate-JSX report — `npm run check:frontend-dup`**
  (`scripts/check-frontend-dup.ts`). A self-hosted copy-paste detector for
  `packages/frontend/src` (the "same Card rendered 5× inline" smell), flagging
  repeated normalized-line windows as extraction candidates. **A tsx/node-only
  script, not jscpd** — same house pattern as `check-diff-coverage.ts`, no new
  dependency for what ~120 LOC of line-shingle hashing does. **Report-only:**
  it prints clusters and exits 0 (mirrors the #2353 lint WARN staging + the
  semgrep/audit report-only tiering) so mature-tree duplication doesn't hard-
  fail the build. Runs non-blocking in CI's `invariants` job. **Ratchet plan:**
  dedupe the flagged surfaces into `@/components/ui` primitives, then flip the
  gate blocking with `npm run check:frontend-dup -- --strict` (or lower
  `MIN_LINES`) — forward-only. It is deliberately **not** part of `check:arch`
  so the per-issue fast gate stays green.

---

## What this rubric does *not* enforce

These are still LLM-review territory. If you're booking another architect-review pass, scope it to these:

- "Does this abstraction match the problem or fight it?"
- "Is the security boundary logically correct?" (semgrep can flag suspicious *syntax*; only judgment can flag suspicious *logic*).
- "Is the data model right?"
- "Does this module exist for the right reason, or is it a leftover?"
- Anything that depends on understanding domain intent.

Everything else — file size, coupling, type holes, shell-injection patterns, layering, adoption of shared abstractions — is mechanically detectable, and the CI suite catches it without needing an LLM.

---

## Adding a new invariant

1. Add the check to the right tool:
   - **Aggregate / metric** → `scripts/check-invariants.ts`, calibrate the threshold to current state.
   - **Module boundary** → `.dependency-cruiser.cjs`, severity `error`.
   - **Pattern in code** → `.semgrep.yml` (CI-only) or `eslint.config.mjs` `sb/*` rules (IDE + CI).
2. Verify it passes today with the current calibration: `npm run check:arch && npm run lint`.
3. Add a row to the relevant table above with the current value, threshold, and ratchet target.
4. If the invariant is part of the architecture intent (not just a code-style nit), cross-reference it from `docs/ARCHITECTURE.md`.
