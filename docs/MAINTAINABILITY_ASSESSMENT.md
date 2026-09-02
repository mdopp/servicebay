# Maintainability & stability assessment (2026-09-02)

**Question asked:** keep every core function ServiceBay has today — what makes the
project more maintainable and more stable? And specifically: which whole files,
classes and functions can go, and what exists several times but is really one
function?

**Scope decisions taken before this was written:** assessment only — no issues
filed, no code changed. Every feature area stays (network map, gateway, disk
import, terminal, portal included); the disk importer is the only extraction
candidate, and only with a justification. Every deletion candidate below carries
its evidence (caller count, where it was looked for) — a number without a way to
re-measure it is a guess, and this page has already learned that lesson once
(#2427).

**Baseline at HEAD (`ce7c93e4`):** 3,550 commits since 2025-12-29 (≈440/month, one
human plus the autoloop), 509 releases in six months, 7 open issues. Backend
77.8k production LOC in 592 files; frontend 58.7k, of which 17.3k are the 174
`route.ts` handlers under `app/api` + `app/napi`; `api-client` 468 LOC. Twelve
parallel CI jobs, 19 invariants in `scripts/check-invariants.ts`, three ratchets
(diff-coverage, ESLint baseline, `as any` budgets).

Every count on this page is a snapshot. Re-measure before acting on one — the
command sits next to the number.

---

## 1. What is good and must not be "cleaned up"

Listed first so nobody spends a consolidation sweep dismantling it:

- **The invariant rubric and its meta-gates** (`docs/ARCHITECTURE_INVARIANTS.md`):
  a gate that scans nothing, a gate that runs nowhere, a gate that never asked —
  all three have bitten this repo and all three are now mechanically impossible.
- **`withApiHandler` at 100 %** — one error envelope, one Zod validation path, one
  session gate for every route.
- **`toolPolicy.ts` as the single source of MCP scopes**, tested from two sides
  (`server.toolRegistry.test.ts`, `server.toolVisibility.test.ts`). The healthiest
  module in the tree.
- **Atomic durable writes** (`lib/util/atomicWrite.ts`, budget 0 for bare writes,
  proved by fault injection).
- **Template contract generated from `lib/template/contract.ts`** with a sync test —
  code is the source, the doc is derived.
- **Release smoke before push** (`release.yml` builds, boots, probes, then pushes).
- Logger discipline: 583 `logger.*` vs 44 `console.*` in the backend.
- Already-merged duplicates that a fresh reader will suspect again — see §3.5.

---

## 2. The four findings

ServiceBay is not short of gates. It has more gate machinery than most projects
of its size. The instability comes from three structural gaps that no gate sees,
plus one process effect.

### 2.1 The UI ↔ backend seam is untyped

| Measure | Value | Re-measure |
|---|---|---|
| Raw `fetch(` sites naming `/api` in client code (non-test, non-route) | **203 in 79 files** | `grep -rn "fetch(" packages/frontend/src --include='*.ts' --include='*.tsx' \| grep -v "test\.\|/app/api/\|/app/napi/" \| grep "/api" \| wc -l` |
| Files using `typedFetch` | **3** | `grep -rl typedFetch packages/frontend/src \| grep -v test \| wc -l` |
| Routes with a Zod contract in `packages/api-client` | **3 of 174** | read `packages/api-client/src/*.ts` |
| MSW mock handlers vs routes | 26 / 174, used by **no test** | `grep -rl "mocks/handlers" packages tests` |
| 401-redirect implementations | **3**, one live | `providers/DigitalTwinProvider.tsx` (window.fetch monkey-patch), `packages/api-client/src/apiFetch.ts` (zero callers), `hooks/useSocket.ts` (`ANONYMOUS_PATHS` copy) |

`apiFetch.ts` documents itself as "Phase 1 — Phase 2 removes the monkey-patch".
Phase 2 never happened. Because the patch silently wraps every raw `fetch`, the
migration *looks* unnecessary, so the count grows instead of shrinking.

Why this is the biggest stability lever: a response-shape change on either side
is invisible to the other. It compiles, it deploys, it renders `undefined` — the
"success reported, nothing done" failure class this repo keeps meeting. Neither
`tsc` nor the invariants can see across an untyped `res.json()`.

### 2.2 The runtime has no owner

| Measure | Value | Re-measure |
|---|---|---|
| `setInterval` in backend production code | **13 in 7 modules, 5 inline in `server.ts`** | `grep -rn "setInterval(" packages/backend/src --include='*.ts' \| grep -v test` |
| Shared scheduler / lifecycle registry / graceful shutdown | none | read `packages/backend/src/server.ts` |
| Durable JSON stores under `DATA_DIR` | 28 top-level paths | `grep -rho "path.join(DATA_DIR, '[^']*'" packages/backend/src \| sort -u` |
| Store schema validation | one `.passthrough()` shape in `lib/store/schema.ts` | — |
| Config migrations | one (`config.ts:migrateConfig`); `CURRENT_SCHEMA_VERSION` has been `1` since it was introduced | `git log -S CURRENT_SCHEMA_VERSION --oneline` |

`server.ts` (802 LOC) is a linear boot script wiring ~30 subsystems. Timers are
started and never cleared; SIGTERM stops nothing in order. Crash-safety of
*writing* a store is solved (#2414); *evolving* a store's shape is not — the
schema-version ledger exists but nothing has ever branched on it.

### 2.3 God modules at the ceiling

`MAX_FILE_LOC = 2,200`. Measured (`wc -l`):

| File | LOC | Headroom |
|---|---:|---:|
| `packages/backend/src/lib/services/serviceLifecycle.ts` | 2,167 | 1.5 % |
| `packages/backend/src/lib/install/runner.ts` | 2,098 | 4.6 % |
| `packages/backend/src/lib/network/service.ts` | 2,046 (**one export**) | 7 % |
| `packages/frontend/src/dashboards/NetworkDashboard.tsx` | 2,149 | 2.3 % |
| `packages/frontend/src/app/(dashboard)/backup/page.tsx` | 1,851 — nine self-duplicated blocks, three backup backends in one file | |
| `packages/frontend/src/app/api/system/nginx/proxy-hosts/route.ts` | 1,540 — ~700 of it a private NPM client (see §3.3) | |

The next feature in `serviceLifecycle.ts` fails CI on the size gate, and the
reflex will be to raise the constant. The invariants doc names 1,500 as the
ratchet target; the tree is moving the other way.

### 2.4 Process: surface grows faster than it is consolidated

- The autoloop keeps the backlog at 7. There is never a "slack" issue whose only
  purpose is to fold two things into one — consolidation has no entry point into
  the queue (`assists/guide-how-work-enters-and-gets-batched.md`).
- 32.8 % of commits since 2026-06-01 are `fix(...)` (`git log --oneline
  --since=2026-06-01 | grep -ci fix`). Partly policy (`fix(runtime):` for Node
  bumps), but the recurrence class is real: #2717 ← #1298, #2435 ← #2415,
  #981 ← #930 — the same shape fixed twice because the first fix landed without a
  gate.
- Playwright (3 specs, 126 LOC) never runs in CI; the only browser gate is the
  out-of-band box-verify against a real box.
- `pre-push` runs the full test suite plus `next build` — a several-minute hook
  is an invitation to `--no-verify`.

---

## 3. Less code: the deletion and merge list

Totals: **≈ 5,000 LOC** across the four groups. That is ~4 % of the tree — modest as
a percentage, but the merge candidates in §3.3 sit exactly where bugs are made:
ten copies of one function with diverging semantics, five pollers on one job, a
hand-maintained fork with "keep the two in sync" in its header.

All figures include the candidate's own tests where noted. "Evidence" says how the
zero-caller claim was established.

### 3.1 Delete now — zero reachability outside its own tests (≈ 1,500 LOC, low risk)

| Candidate | LOC | Evidence |
|---|---:|---|
| `packages/backend/src/lib/install/stackRunner.ts` + `.test.ts` | 561 | Only non-test mentions are two comments (`install/stackHealth.ts`, `install/runner.test.ts`). Stack installs run through `install/runner.ts`. `grep -rln stackRunner packages scripts docs` |
| `packages/backend/src/lib/stackInstall/nginxScratchValidate.ts` + test | 247 | No importer besides its test and `tsbuildinfo`. |
| `packages/frontend/src/components/GatewayConfig.tsx` + `tests/frontend/GatewayConfig.test.tsx` | 213 | No importer. The live gateway UI is inline in `OnboardingWizard.tsx`. |
| 14 exported symbols with no reference outside their declaration | ~138 (+ ~120 test) | `regenSecrets.ts:regenerateWipedKeysUnlessPreservedConfig` (48), `adguard/rewrites.ts:removeWildcardRewrite` + `wildcardForDomain`, `assists/proposals.ts:getProposal` + `listProposals`, `externalBackup/restore.ts:isFreshDataDir`, `auth/tokenRequests.ts:getTokenRequest`, `secrets.ts:hasDecryptMismatch`, `auth/delegatedAdmin.ts:createInMemoryReplayGuard`, `imageDigest.ts:clearImageUpdatesCache`, `templateTier.ts:isInfrastructureTier`, `health/probes/registry.ts:registeredProbeTypes`, `template/stackContract.ts:tryParseStackManifest`, `externalBackup/serviceManifest.ts:getDataPaths`. `knip` cannot see these because of `"ignoreExportsUsedInFile": true` in the root `package.json` — see H8. |
| Config schema-version ledger: `CURRENT_SCHEMA_VERSION`, `getSchemaVersion`, `stampSchemaVersion`, the `schemaVersion` field, `config/transformer.ts` + tests | ~155 | The version has never been ≠ 1, so `getSchemaVersion()` can only return 1 and nothing branches on it. What `migrateConfig` actually does — `renameExternalLinkTargets` (~22 LOC) and the `credentialVault` drop — stays; 5.12.x boxes (2026-08-13) still exist. |
| Twin `MigrationHistoryEntry` (17 fields) + `recordMigrationEvent` in `lib/store/twin.ts`, `schema.ts` | ~45 | `recordMigrationEvent` has zero callers; `node.history` has zero readers outside `twin.ts`. |
| `packages/backend/src/lib/public-api.ts` + `tests/backend/public_api.test.ts` | 47 | Re-export barrel imported only by its own test; every symbol is imported from source elsewhere. Check intent before deleting — it may be a declared "public surface". |
| MCP tool `add_proxy_route` (`lib/mcp/tools/proxyTools.ts`) + policy/doc rows | ~40 | Strictly weaker than `create_proxy_route` (#2140): writes `config.reverseProxy.hosts` and tells the operator to click Sync, producing exactly the config-vs-NPM drift the diagnose probes flag. Different kernel path, not an alias. |
| `lib/mode.ts:isLocalOnly` (marked deprecated) | 9 | One caller, `app/api/system/mode/route.ts` — inline it. |
| Template migration scripts below an unbridgeable gap: `templates/media/migrations/v1-to-v2.py`, `templates/home-assistant/migrations/v1-to-v2.py`, `v3-to-v4.py` | 129 | `selectMigrationChain` (`lib/stackInstall/migrations.ts`) requires contiguous one-version hops and `install/runner.ts` aborts the deploy on `missing-step`. media (v8) has no `v2→v3`; home-assistant (v8) has no `v2→v3`, `v4→v5`, `v5→v6`. A box recorded at ≤ v2 therefore cannot upgrade at all, and the scripts before the gap are unreachable. The consistency test (#2601) deliberately pins only the *tail* of the chain. **This needs a decision, not a deletion:** either close the gaps with informational no-op hops (~10 LOC each, pattern in `templates/beets/migrations/v2-to-v3.py`) or delete the orphans and document a minimum upgradable schema version per template. Leaving it as-is is the one wrong answer. |

### 3.2 Delete after one question — judgement calls (≈ 1,200 LOC)

| Candidate | LOC | Evidence / the open question |
|---|---:|---|
| Nine HTTP routes with no caller: `system/certs/archive` (120), `system/token-requests` + `[id]` (80), `system/learning-proposals/[id]` + `[id]/approve` (96), `agents/restart` (38), `system/last-crash` (28), `system/keys/bcrypt` (27), `system/install/persist-secret` (24) | 413 | Zero hits for each path in frontend (non-route), backend, api-client, both workers, `docs/`, `assists/`, `scripts/`, `install-sb.sh`, `.github/`. The MCP tools for token requests and learning proposals call `lib/` directly; there is no review UI for proposals. The companion app uses `/napi`, not these. **Question:** does any external `curl`/agent client hit them? `keys/bcrypt` is name-dropped in a stale comment in `templates/adguard/post-deploy.py`. |
| `app/(dashboard)/dev/components/page.tsx` — the component catalog (#2354) | 325 | Deliberately hidden dev tool; no nav entry, no link, ships in the production bundle behind a `notFound()`. Keep or move under a build flag — but decide. |
| MSW dev mocks: `src/mocks/*`, `providers/MockProvider.tsx` (mounted unconditionally in `app/layout.tsx`), the `msw` dependency | 358 | `NEXT_PUBLIC_USE_MOCKS=1` is set in exactly one place: the `dev:frontend` script. No test imports the handlers. 26 of 174 routes mocked, so the "frontend without a box" workflow is already 85 % broken. Delete unless someone uses `dev:frontend`. |
| `scripts/enable-nvidia.sh` | 107 | Referenced from nowhere (package.json, CI, docs, other scripts). Possibly a hand-run operator script for GPU boxes — ask. |

### 3.3 Merge — "it is really one function" (≈ 1,900 LOC, the biggest stability win)

| Concern | Today | One implementation | LOC out | Risk |
|---|---|---|---:|---|
| **NPM admin client** | `findNpmAdminUrl` / `getNpmToken` / `resolveNpm` are defined **in 10 files**: five diagnose probes at 40–46 LOC each (`diagnose/ssoVerify.ts`, `probes/certRequestFailure.ts`, `probes/certExpiry.ts`, `probes/nginxOnlineFailed.ts`, `probes/danglingProxy.ts`), `health/probes/npmAdmin.ts`, `reverseProxy/npmAdminRekey.ts`, `reverseProxy/migrateToPublic.ts`, and `resolveNpm` twice in `app/api/system/nginx/{bootstrap,proxy-hosts}/route.ts`. On top: ~700 LOC of private NPM client (`createProxyHost`, `patchProxyHostAdvancedConfig`, `acquireCertId`, `ensureLanAccessList`, …) inside `proxy-hosts/route.ts`, and raw `/api/nginx/*` fetches in 13 more files. `grep -rl "function findNpmAdminUrl\|function getNpmToken\|function resolveNpm(" packages/*/src \| grep -v test` | `lib/npm/client.ts`: `resolveNpmAdmin(node) → {apiUrl, nodeIp, token}` plus typed `proxyHosts.*`, `certs.*`, `accessLists.*`. Every probe, route and tool calls it. Then a depcruise rule: only `lib/npm/` may fetch `/api/nginx`. | **~500** | **Medium — and that is the point.** The copies have *diverged*: the health copy deliberately ignores `service.active`, the rekey copy requires it; only health matches `name === 'nginx'`. The merge is a bug fix wearing a refactor's clothes; each caller's semantics must be chosen explicitly. |
| **Install-job progress** | Five pollers on the same singleton job: `hooks/useStackInstall.ts` (poll loop), `hooks/useInstallMonitor.ts` (whole file), `app/(dashboard)/setup/page.tsx` (own poll, own log panel, own status/credentials/DNS/self-test panels), `components/OnboardingWizard.tsx`, `components/MobileNav.tsx`. Two renderers: `setup/page.tsx` re-renders what `StackInstallProgress` / `StackInstallSummary` in `components/StackInstallFlow.tsx` already draw. `grep -rln "/api/install/status\|/api/install/progress" packages/frontend/src \| grep -v "test\|/app/api/"` | One `InstallJobProvider` owning a single poll (or the socket) and exposing `{job, logs, phase, credentials, abort, skipCredentials}`; `useStackInstall` keeps only configure/start; `/setup` becomes `<StackInstallProgress/> + <StackInstallSummary/>`. | **~430** | Medium — cadences differ (1.5 s / 2 s / 5 s) and the `/status → /progress` 401 fallback exists in only some copies; one must become canonical. Well covered by tests. |
| **backup-worker manifest fork** | `packages/backup-worker/src/engine/serviceManifest.ts` (378) is a hand-maintained copy of `packages/backend/src/lib/externalBackup/serviceManifest.ts` (694). Same exports (`StripRule`, `SERVICE_BACKUP_MANIFESTS`, `applyStripRules`, `translateHaAddonConfigEntries`, …); the worker's header says "Keep the two in sync". | Pure data + pure helpers, no I/O — move them into a workspace package (`packages/api-client` is the precedent) and import from both sides. The sandbox constraint ("the worker cannot import the backend") does not apply to a dependency-free package. | **~380** | Low — round-trip tests exist on both sides. |
| `ServiceCard` / `ServiceRow` | `components/ServiceCard.tsx` (200) and `ServiceRow.tsx` (204): identical imports, identical props, identical badges; `ServiceCard` already imports `serviceDotState` *from* `ServiceRow`. Top pair in `npm run check:frontend-dup` (18 blocks). | `<ServiceTile layout="card" \| "row">` — they differ only in the outer wrapper's flex/grid classes. | ~255 (incl. tests) | Low |
| Container log / terminal drawer | `components/ContainerList.tsx` owns the drawer and is already shared by `ServiceMonitor`, `ContainersDashboard`, `OperateContainersTab`; `dashboards/ServicesDashboard.tsx` carries its own copy (7 duplicate blocks). | Extract `<ContainerDrawer>` from `ContainerList`, mount it in `ServicesDashboard`. | ~145 | Low |
| Pending-approvals list | `components/PendingApprovalsCard.tsx` already exports `usePendingApprovals()`; `settings/_lib/sections/McpSection.tsx` re-implements it inline — same route, same 15 s poll, same `FAILURES_BEFORE_ALERT` grace, same rows. | `McpSection` uses the hook and the shared list. | ~120 | Low |
| 401 handlers | Three (§2.1), one live. | Finish `apiFetch` Phase 2: delete the `window.fetch` patch and the `useSocket` copy. | ~40 + one global side effect | Low |
| Exec tiers | `executor.execArgv` (59 sites) is `exec(shellQuoteAll(argv))` — a shell round-trip for structured argv. `execSafe` (10 sites) is the real structured path. Of ~53 `.exec(` sites none uses a shell feature (`\|`, `>`, `&&`, `$()`). | `execArgv` → `execSafe`; retire the shell-string tier. | ~50 | A security cleanup, not a LOC win. |

### 3.4 Delete after groundwork (≈ 700 LOC)

| Candidate | LOC | Groundwork first |
|---|---:|---|
| `packages/frontend/src/app/actions/*` server actions — `ARCHITECTURE_INVARIANTS.md` calls the directory legacy; `getNodes` is defined identically in `actions/system.ts` and `actions/nodes.ts` | 560 (+115 test) | They are the *only* implementation (no route twins for nodes/ssh/onboarding). Write the route handlers + api-client methods, then delete. Deletable today: the duplicate `getNodes` in `actions/system.ts`. |
| `packages/backend/src/lib/mcp/approveRoute.ts` + `app/api/system/mcp/approve/**` — a third view over the durable approvals store (#2234) that reshapes records and hard-codes `expiresAt: null` | 144 | Point `PendingApprovalsCard` and Settings → MCP at `/api/approvals`, then delete. |

### 3.5 Checked and **not** removable — so nobody re-litigates it

- **Two "Operate" surfaces** — one implementation: `services/[name]/_lib/OperatePage.tsx` imports `useOperateService` and the three tabs from `settings/services/_lib/`.
- **Multiple install paths** — MCP `install_template`, `POST /api/install/assemble` + `/start`, `/napi/services/[name]/upgrade` and `reconfigure-preview` all converge on `assembleManifest → createJob → startJob`. One runner.
- **`app/napi/*`** — 2,036 LOC, ~950 production; handlers delegate to `ServiceManager` and the install runner. It is the companion app's surface (`docs/COMPANION_APP.md`), not a duplicate.
- **health vs. diagnose** — #484 split them: health detects, schedules, persists; diagnose reads `HealthStore` and attaches click-time actions. The 27 diagnose probes that do not touch the store ask genuinely different questions.
- **Three backup modules** — `lib/systemBackup.ts` (full-box tar, local + SSH), `lib/backup/service.ts` (scheduled data backup to SMB with history + email), `lib/externalBackup/*` (per-service config to NAS with manifests). Three concerns; only the worker fork in §3.3 is a duplicate.
- **`config.ts` / `ssoVerify.ts` / `registry.ts` export counts** (29 / 28 / 22) — types plus pure functions, not `getX()` wrappers; `registry.ts`'s readers are one-liners over a single `readTemplateFile`.
- **`ssh/pool.ts`** — live transport for the terminal and remote-node backups (`server.ts`, `watcher.ts`, `systemBackup.ts`, `agent/handler.ts` import it). Not superseded by the agent socket.
- **All 33 diagnose probes and all health probes** — loaded by side-effect barrels (`probes/register.ts`, `probes/index.ts`); a `from`-import scan false-positives on every one of them.
- **`retireSystemPodmanTimer`**, **`syncDnsRoutingChecks`** — cheap, idempotent self-heals for boxes that may still be in the field. `syncDnsRoutingChecks` can go one release after the last pre-#1564 box is gone.
- **`install-fedora-coreos.sh`** — does not exist; the installer is `install-sb.sh` (96 LOC, no OS-version branches).
- **MCP tools** — 2,438 LOC for 64 tools, ~38 each; thin dispatch, no duplication beyond `add_proxy_route`. `install_template` vs `deploy_service` and `get_config` vs `get_service_files` are distinct kernel paths, not aliases.

---

## 4. Levers, in order

Each lever names the invariant that locks it in afterwards — the repo's ratchet
principle. A lever without a gate is a TODO (#2430).

| # | Lever | What locks it in |
|---|---|---|
| **H0** | **Work §3.1 and §3.3** — in this order: NPM client (it is a bug fix), install-job provider, manifest package, then all of §3.1. | `npm run check:frontend-dup -- --strict`; a depcruise rule that only `lib/npm/` may fetch `/api/nginx`. |
| **H1** | **One typed API seam.** `packages/api-client` becomes the contract: a Zod request/response pair per route, the client generated from it; the three 401 handlers collapse to one; MSW handlers derive from the same schemas or go. | A new rule in `scripts/check-lint-ratchet.ts` counting raw `fetch('/api` in client code, baseline 203 → 0, monotonic like the two existing rules. |
| **H2** | **A runtime kernel.** `lib/runtime/lifecycle.ts` with `registerBackgroundTask({name, start, stop})`; `server.ts` becomes a declarative list; SIGTERM stops tasks in reverse order. All 13 intervals move onto it. | Invariant in `check-invariants.ts`: bare `setInterval` in `packages/backend/src/lib` outside the kernel, budget 13 → 0. |
| **H3** | **Versioned stores** — `defineStore({name, schema, version, migrations})` over `atomicWrite`, adopted store by store. Replaces the dead ledger in §3.1 with something that actually runs. | `DURABLE_STATE_MODULES` becomes "must use `defineStore`"; forward-only as today. |
| **H4** | **Split the god modules before the cap does it for you.** `network/service.ts` first (one export — the cleanest seam), `serviceLifecycle.ts` by verb, `backup/page.tsx` by backend. | `MAX_FILE_LOC` 2,200 → 1,500, the target the invariants doc already names. |
| **H5** | **Close the test pyramid.** Run the three Playwright specs in CI against the `dev-image` job's booted server (it already smoke-boots; add a stubbed agent). Put a budget on `: any` (72 in the backend, currently ungated). (An earlier draft listed `unmanaged/`, `fritzbox/`, `nginx/`, `quadlet/`, `ssh/` as untested — re-measured, each has dedicated test files under `tests/backend/`; withdrawn.) | `e2e` job in `ci.yml` as a PR gate; `BACKEND_COLON_ANY_BUDGET`. |
| **H6** | **Regression ⇒ gate.** An issue that names a predecessor (`#2717 ← #1298`) lands only with a test or invariant covering the *class*; label `recurrence`. | A planner rule in `assists/autoloop-issue-pipeline.md`. |
| **H7** | **A consolidation budget in the autoloop.** One debt item per batch, picked from the ratchet / dup-report output; releases weekly instead of per merge (509 in six months is noise, not signal); `pre-push` down to `vitest --changed`. | `assists/guide-how-work-enters-and-gets-batched.md`. |
| **H8** | **Hygiene.** `Dockerfile` — `USER nextjs` is commented out, the container runs as root. Rename `docs/adr/0010-node-20-minor-floats.md` (the content says 22). Seven stale `src/…` paths in `docs/TEMPLATE_LOGGING.md`, `TEMPLATE_AUTHORING.md`. The `.dependency-cruiser.cjs` header claims exemptions for "6 circular deps, 3 lib→app imports, 1 renderer fork" — all paid off, the comment was not updated. `knip`: drop `ignoreExportsUsedInFile`, add `packages/backend/src/server.ts` as an entry (today it reports 24 false-positive "unused" modules and hides 14 real ones). | — |

H2 and H8 are small and immediate. H0 is where the stability comes from. H1 is
the largest lever and runs ratchet-driven over months. H4 must precede the next
feature in any of the three backend files, or the cap breaks first. H3 must
precede the next new store.

---

## 5. Extraction candidate: the disk importer

**For.** `packages/disk-import-worker` (5.3k LOC) is already a sandboxed one-shot
worker with its own CLI and server layer; the backend side (`lib/diskImport/`,
1.6k) plus `app/(dashboard)/disk-import/page.tsx` (760) plus the routes are a thin
shell. It is a one-time migration tool, not a running service. It is already
excluded from `check:deps` because of the `cli/main.ts ⇄ server/index.ts` cycle
(`ARCHITECTURE_INVARIANTS.md`). Its own release cycle would keep core release
notes about the core.

**Against.** It shares the session and `mutate` scope gate, the
`file_access_request` flow, and the canonical target-folder conventions. A second
repo is a second CI, a second set of gates, a second place for the standards to
drift.

**Recommendation: not now.** First freeze the contract — a JSON schema for
scan/plan/apply plus a contract test in the core — break the cycle, and add the
package to the depcruise roots. After that the extraction is a pure move and can
be decided on its merits. `lib/unmanaged/` (bundle builder, 1.7k LOC, one test
file) would be the second candidate on the same pattern.

The gateway/Fritz!Box integration should *not* be extracted: put it behind the
existing `gateway/poller` seam as a provider, so a router change is a new
provider, not a rewrite.

---

## 6. What this page is not

Not a fix plan. Each row in §3 and each lever in §4 is cut so it becomes one
issue with one ratchet — that is the shape the autoloop consumes
(`assists/autoloop-issue-pipeline.md`). Filed 2026-09-02 as epic #2721 with
children #2722–#2747 (ascending number = dependency order; the DAG is a comment
on the epic). Numbers here are from 2026-09-02; re-measure before building.
