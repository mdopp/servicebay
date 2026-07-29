# Architecture Invariants

The rubric that defines "ServiceBay's architecture is still good."

Each invariant below is **mechanically enforced** by one of three tools running in CI. A passing build means the rubric holds. A failure means a specific line crossed a defined boundary — not a subjective "feels off."

Decisions that **can't** be mechanically enforced — operator-facing UX choices, incident-driven safety cascades, the user's deliberate config quirks — live in [UX_DECISIONS.md](UX_DECISIONS.md). Read both before changing anything that looks weird.

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

### Two meta-invariants: a gate that scans nothing, and a gate that runs nowhere

Both failure modes report **green** and are indistinguishable from a real pass.
Both have bitten this repo, so both are now themselves enforced by
`scripts/check-invariants.ts`:

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
| Max file LOC (each source root) | `MAX_FILE_LOC` | 2,200 |
| `as any` in security paths | `SECURITY_AS_ANY_BUDGET` | 0 |
| `as any` in `packages/backend/src` outside security paths | `BACKEND_AS_ANY_BUDGET` | 24 |
| `executor.exec` template-literal call sites | `EXEC_TEMPLATE_LITERAL_MAX` | 0 |
| `withApiHandler` adoption across `route.ts` files | `MIN_WITH_API_HANDLER_RATIO` | 100% |
| `DigitalTwinStore.getInstance()` call sites | `TWIN_GETINSTANCE_MAX` | 0 |
| Bare `fs.writeFile`/`writeFileSync` in durable-state modules | `DURABLE_STATE_BARE_WRITE_BUDGET` | 0 |

Source roots walked: `packages/frontend/src`, `packages/backend/src`.

Security paths (`SECURITY_PATHS`): `packages/backend/src/lib/auth`, `packages/backend/src/lib/mcp`, `packages/backend/src/lib/agent/executor.ts`, `packages/frontend/src/proxy.ts`.

Durable-state modules (`DURABLE_STATE_MODULES`): `packages/backend/src/lib/config.ts`, `packages/backend/src/lib/config/transformer.ts`, `packages/backend/src/lib/health/store.ts`.

_Generated from the constants — run `npm run check:invariants -- --write-docs` after changing one. For the **measured** values at HEAD run `npm run check:invariants`: they are deliberately not stored here, because a hand-maintained measurement table is stale the next time anyone merges (#2427)._

<!-- END GENERATED: thresholds -->

### Structural

| Invariant | Enforced by |
|---|---|
| Max file LOC (each source root) | `check-invariants.ts:MAX_FILE_LOC` |
| Files > 2,000 LOC | (untracked — reported by the run, no threshold) |
| Functions > 150 LOC | (untracked) |

**File-size ceiling.** Two roots, **one** pin. The backend root was **not walked at all** until #2379, which enforced it behind a temporary, looser `MAX_BACKEND_FILE_LOC` (2,400) pinned to `lib/mcp/server.ts` at 2,391; #2384 split that file into `lib/mcp/tools/*` (one module per tool group) and the separate backend pin was deleted, so both roots share `MAX_FILE_LOC` again. Ratchet target: one shared 1,500 cap once the largest dashboard and the largest backend service module are split per the audit follow-ups.

### Type safety

| Invariant | Enforced by |
|---|---|
| `as any` in security paths | `check-invariants.ts:SECURITY_AS_ANY_BUDGET` |
| `as any` in `packages/backend/src` outside security paths | `check-invariants.ts:BACKEND_AS_ANY_BUDGET` |

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
| Bypasses of `ServiceManager` facade | `.dependency-cruiser.cjs:service-manager-single-mutation-path` |

**Twin singleton fan-in.** Ratcheted to 0 — every read goes through `packages/backend/src/lib/store/repository.ts`; the store itself, the repository, and the backend `server.ts` bootstrap are the only allowed call sites.

**Circular deps.** Every new cycle fails CI immediately.

**Which packages depcruise walks.** `check:deps` cruises `packages/api-client/src`, `packages/backend/src`, `packages/backup-worker/src` and `packages/frontend/src`. `packages/disk-import-worker/src` is **not** covered yet: adding it surfaces a real `no-circular` violation (`cli/main.ts` ⇄ `server/index.ts`, via the deliberate lazy `import('../server/index')` in serve mode), and breaking that cycle is its own change, not a config edit. Extend the root list in `package.json` once it is broken — never add an exemption to make the package pass.

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

**Durable-state writes are atomic (#2414).** `config.json` and `checks.json` under `DATA_DIR` are the operator's data, not caches: losing `config.json` re-onboards the box (domain, auth and service config gone, wizard opens on a configured box), losing `checks.json` drops every configured health check. A bare `fs.writeFile`/`writeFileSync` truncates the target *before* the new bytes land, so a power cut / OOM-kill / container stop mid-write destroys the file permanently. `packages/backend/src/lib/util/atomicWrite.ts` is the only sanctioned writer — `atomicWriteFile` (async) and `atomicWriteFileSync` (sync twin, for the stores whose public API is sync) both do tmp → fsync → rename, so a crash leaves the *original* intact.

The modules held to this are listed in `DURABLE_STATE_MODULES` (`check-invariants.ts`) and enumerated in the generated block above. The list is repo-relative and **forward-only** — add a module when it starts owning durable `DATA_DIR` state; never delete one to make a bare write pass. Unlike the older path-based checks, a listed path that does **not** resolve is itself a violation, so a move/rename can't silently disable the gate the way the pre-#2379 `SECURITY_PATHS` did. `atomicWrite.ts` is deliberately not on the list — it *is* the primitive. Crash behaviour is proved by fault injection in `tests/backend/durable_write_crash_safety.test.ts` (each survival case is paired with a control that performs the pre-fix truncate-then-partial-write and must destroy the file).

Explicitly out of scope: `health/store.ts` result files and `health/bootState.ts` are caches, cheap to rebuild — `writeResults` rides the atomic helper anyway because it shares the module, `bootState.ts` does not.

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
- `@/app/actions/*` — server actions, already typed (legacy; new server-action surfaces go through the api-client client + a route handler instead).
- Direct `fetch('/api/...')` — grandfathered for ~80 legacy call sites; new code uses `typedFetch`.

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

### Component discovery + duplicate detection (#2354)

Two companions to the reuse rules above — *you can only reuse what you can
find, and only extract what you can see*:

- **Component catalog — `/dev/components`** (`packages/frontend/src/app/(dashboard)/dev/components/page.tsx`).
  A living gallery that renders every `@/components/ui` primitive in its key
  states, driven off the barrel. Lightweight in-app route (no Storybook — the
  CLAUDE.md ethos of not adding a heavy dependency), gated **dev-only**: the
  whole `(dashboard)` group already sits behind the single-admin session, and
  the page additionally `notFound()`s under a production build. When you add a
  primitive to `@/components/ui`, add its gallery entry here — the catalog test
  (`tests/frontend/ComponentCatalog.test.tsx`) asserts one section per primitive.

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
