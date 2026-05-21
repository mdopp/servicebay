# Architecture Invariants

The rubric that defines "ServiceBay's architecture is still good."

Each invariant below is **mechanically enforced** by one of three tools running in CI. A passing build means the rubric holds. A failure means a specific line crossed a defined boundary — not a subjective "feels off."

Decisions that **can't** be mechanically enforced — operator-facing UX choices, incident-driven safety cascades, the user's deliberate config quirks — live in [UX_DECISIONS.md](UX_DECISIONS.md). Read both before changing anything that looks weird.

This document is the *intent* layer; the configs are the *enforcement* layer:

| Tool | Config | Catches |
|---|---|---|
| `scripts/check-invariants.ts` | (this file's thresholds) | Aggregate metrics — file size, adoption ratios, budgets |
| `.dependency-cruiser.cjs` | depcruise | Module boundary rules — forbidden import edges, circular deps |
| `.semgrep.yml` | semgrep | Security & coupling patterns — line-level pattern matching |
| `eslint.config.mjs` (custom `sb/*` rules) | eslint | IDE-time feedback for the highest-traffic patterns |

Run the full suite locally:

```bash
npm run check:arch      # invariants + depcruise
npm run lint            # ESLint, includes sb/* rules
# Semgrep — run via docker or podman (no host install needed):
podman run --rm -v "$PWD:/src:Z" docker.io/returntocorp/semgrep \
    semgrep --config /src/.semgrep.yml --metrics=off /src
```

CI: see `.github/workflows/architecture.yml`.

---

## How to change a threshold

Thresholds are **deliberate decisions**, not aspirational defaults. Two paths:

1. **Ratchet down** (tighten): preferred. Drop a file from an exemption list, lower a max, raise a ratio floor. Land in the same PR as the fix that makes it possible.
2. **Loosen**: requires a one-line justification in the config comment naming *what changed in reality* (not "we wanted more slack"). If you find yourself loosening repeatedly, the threshold is wrong — re-examine.

`scripts/check-invariants.ts` calls out the ratchet target for each metric inline. The depcruise config marks every exemption with a TODO and links to the underlying issue.

---

## The invariants

### Structural

| Invariant | Current | Threshold | Enforced by |
|---|---:|---:|---|
| Max file LOC | 2,523 | 2,600 | `check-invariants.ts:MAX_FILE_LOC` |
| Files > 2,000 LOC | 4 | (untracked) | future |
| Functions > 150 LOC | 1+ | (untracked) | future |

**File-size ceiling.** The largest current file is `OnboardingWizard.tsx` at 2,523 LOC. Cap pinned at 2,600 (small slack). Ratchet target: 1,500 once the four 2k-LOC files (`OnboardingWizard`, `NetworkDashboard`, `ServicesDashboard`, `NetworkService`) are split per the audit follow-ups.

### Type safety

| Invariant | Current | Threshold | Enforced by |
|---|---:|---:|---|
| `as any` in security paths | 3 | 3 | `check-invariants.ts:SECURITY_AS_ANY_BUDGET` |

**Security paths**: `src/lib/auth/**`, `src/lib/mcp/**`, `src/lib/agent/executor.ts`, `src/proxy.ts`. Non-test only. The three current casts are error-augmentation in `executor.ts`. Ratchet target: 0.

### Coupling

| Invariant | Current | Threshold | Enforced by |
|---|---:|---:|---|
| `DigitalTwinStore.getInstance()` call sites | 35 | 40 | `check-invariants.ts:TWIN_GETINSTANCE_MAX` |
| `lib → app` imports | 0 | 0 | `.dependency-cruiser.cjs:lib-no-import-app` (#600) |
| `lib → components` imports | 0 | 0 | `.dependency-cruiser.cjs:lib-no-import-components` |
| `lib → dashboards` imports | 0 | 0 | `.dependency-cruiser.cjs:lib-no-import-dashboards` |
| Circular dependency cycles | 0 | 0 | `.dependency-cruiser.cjs:no-circular` (#601 — final cycle broken by extracting `verifyNodeConnection` out of `nodes.ts`) |
| Forks of the Mustache renderer | 0 | 0 | `.dependency-cruiser.cjs:one-renderer` (#599) |
| Bypasses of `ServiceManager` facade | 0 | 0 | `.dependency-cruiser.cjs:service-manager-single-mutation-path` |

**Twin singleton fan-in.** 35 modules call `DigitalTwinStore.getInstance()` directly. Architecture audit flags this as a coupling smell. Ratchet target: 5 (server.ts + reader module + tests) once a reader API is introduced.

**Circular deps.** Six known cycles are exempted with TODO markers in the depcruise config. Each new cycle fails CI immediately.

### Code-style / consistency

| Invariant | Current | Threshold | Enforced by |
|---|---:|---:|---|
| `executor.exec(\`…${x}…\`)` call sites | 26 | 26 | `check-invariants.ts:EXEC_TEMPLATE_LITERAL_MAX` + `sb/no-exec-template-literal` |
| `withApiHandler` adoption (route.ts files) | 64 of 108 | ≥ 55% | `check-invariants.ts:MIN_WITH_API_HANDLER_RATIO` + `sb/api-route-needs-handler` |

**executor.exec template literals.** Ratcheted to 0 in #602. ESLint rule `sb/no-exec-template-literal` is `error` everywhere — every previous offender was converted to `execArgv`. `EXEC_TEMPLATE_LITERAL_MAX = 0` in `check-invariants.ts` blocks any regression.

**withApiHandler adoption.** `@/lib/api/handler` provides shared Zod validation + error envelope + ApiError short-circuiting. Currently 64 of 108 routes use it. The ratio must monotonically increase; new routes must use it (ESLint warning + semgrep INFO). Ratchet target: ≥ 90% adoption.

### Security boundaries (pattern enforcement)

Enforced by `.semgrep.yml`. ERROR severity = build-blocking; WARNING = reported only.

| Pattern | Severity | Where |
|---|---|---|
| `executor.exec` with template-literal interpolation | ERROR | all non-test |
| Direct `tar -x...` outside `safeTarExtract` (#580, #590) | ERROR | all except backup module |
| `child_process.exec/execSync` with non-literal | WARNING | all src/ + server.ts |
| `eval`, `new Function`, string-form `setTimeout`/`setInterval` | ERROR | everywhere |
| `fetch(config.issuer …)` / `fetch(config.host …)` without SSRF guard | WARNING | all |

### Architecture-doc invariants (already documented in `ARCHITECTURE.md` audit)

These are enforced as depcruise rules:

- **One mutation path per operation** — every deploy/delete/start/stop/restart/update goes through `ServiceManager`. Direct imports of `serviceLifecycle`/`serviceListing` from outside `src/lib/services` are forbidden.
- **One renderer** — all Mustache rendering goes through `src/lib/template/render.ts` (post-#599). `install/runner.ts` and the `stackInstall/` family still import `mustache` directly and are exempt for the moment; the next ratchet step migrates them to the shared helper too.
- **One Digital Twin store** — singleton via `DigitalTwinStore.getInstance()`. Fan-in cap enforced by `check-invariants.ts`.

### Frontend ↔ Backend boundary (#753)

Enforced **structurally** via the workspace layout as of Phase 3.3 (#764). The three numeric ratchets (`fe-template-lib-imports`, `fe-backend-imports`, `fe-install-helpers`) that watched specific FE→BE leakage points have retired — the workspace boundary makes a forbidden import physically unresolvable, so a count check is redundant.

Layout:

| Package | Path | Owns | Allowed imports |
|---|---|---|---|
| `@servicebay/api-client` | `packages/api-client/` | typed seam: shared types + zod schemas + `typedFetch` helper | `zod` only |
| `@servicebay/frontend` | `packages/frontend/` | UI: components, hooks, dashboards, providers | `@servicebay/api-client` + UI libs |
| `@servicebay/backend` | `packages/backend/` | server-side: agent, install, diagnose, network, store, … | `@servicebay/api-client` + runtime deps |
| (root) | `src/app/`, `server.ts`, `src/proxy.ts` | Next.js framework root: route handlers, server actions, custom server | all three packages |

What enforces what:

- **Workspace deps** (`package.json#dependencies`): `packages/frontend/package.json` does not list `@servicebay/backend`. A `@servicebay/backend/*` import from frontend would fail to resolve at build time.
- **tsconfig paths**: `packages/frontend/tsconfig.json` defines a restricted `paths` block — it omits `@/lib/*`, so the legacy path also fails to resolve.
- **`sb/no-fe-backend-import` ESLint rule**: editor-time signal + defense-in-depth. Catches `@/lib/*` and `@servicebay/backend/*` imports under `packages/frontend/**`.
- **`depcruise`**: `lib-no-import-app`, `lib-no-import-components`, `lib-no-import-dashboards` rules forbid backend → frontend imports.

Frontend reaches the backend exclusively through:

- `@servicebay/api-client` — typed seam (default for new code).
- `@/app/actions/*` — server actions, already typed (legacy; new server-action surfaces go through the api-client client + a route handler instead).
- Direct `fetch('/api/...')` — grandfathered for ~80 legacy call sites; new code uses `typedFetch`.

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
