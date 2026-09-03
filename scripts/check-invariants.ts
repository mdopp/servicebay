/**
 * Architecture invariants — aggregate / metric checks.
 *
 * The companion to .semgrep.yml (per-pattern) and .dependency-cruiser.cjs
 * (per-import). This script owns the *aggregate* thresholds — file size,
 * adoption ratios, type-leak budgets — that pattern tools can't express
 * naturally.
 *
 * Each invariant has a threshold pinned to the codebase's current state.
 * Raising a threshold is a deliberate documented decision; lowering one
 * (ratchet) is encouraged when adoption catches up.
 *
 * Exits 0 (all good) or 1 (one or more violations). Designed to run in
 * CI without any extra deps beyond what's already in node 20.
 *
 * To recalibrate after a deliberate change, edit the constants at the
 * top of each check and reference the PR/issue that authorized it, then run
 * `npm run check:invariants -- --write-docs` to regenerate the threshold block
 * in docs/ARCHITECTURE_INVARIANTS.md (drift there is a violation, #2427).
 *
 * Two of the checks are *meta* — they guard the gates rather than the code:
 * `gate-path-resolves` (every path a gate config names must match a real file,
 * #2379/#2428) and `ci-runs-every-check-script` (every local `check:*` gate
 * must run in CI, #2429). Both failure modes report green.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { auditHealthCheckIdLifecycle } from './invariants/healthCheckIdLifecycle';
import { auditAssistCatalogSingleSource } from './invariants/assistCatalogSingleSource';
import { auditNpmApiLiterals } from './invariants/npmApiLiterals';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'packages', 'frontend', 'src');
const BACKEND_SRC = path.join(REPO_ROOT, 'packages', 'backend', 'src');

const WRITE_DOCS = process.argv.includes('--write-docs');

interface Violation {
    check: string;
    detail: string;
}

const violations: Violation[] = [];

/**
 * Measured-at-HEAD values, printed on every run.
 *
 * #2427: these are deliberately NOT written into
 * docs/ARCHITECTURE_INVARIANTS.md. A measurement stored in a doc is stale the
 * next time anyone merges — which is exactly how that doc came to assert three
 * wrong file names / counts. The doc keeps the (generated) thresholds; the
 * numbers live here, one command away.
 */
const measurements: string[] = [];

async function walk(dir: string, filter: (p: string) => boolean): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            out.push(...await walk(full, filter));
        } else if (entry.isFile() && filter(full)) {
            out.push(full);
        }
    }
    return out;
}

const isTs = (p: string) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts');
const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p) || p.includes('/tests/');

// ---------------------------------------------------------------------------
// 1. File-size ceiling.
//
// Pinned at 2,700 LOC: OnboardingWizard.tsx grew to 2,672 with the
// multi-stack picker rework (#682-followup — multi-select picker +
// Install-another loop + state migration). The "real" split of the
// wizard into per-step components is the proper fix; bumping the
// ceiling temporarily so the multi-stack PR isn't blocked by a
// concurrent refactor that's larger in scope than the UX win.
//
// Ratchet target: 1,500 once the three 2k dashboards + NetworkService
// + OnboardingWizard are split into per-step files (see audit doc
// ARCH follow-ups).
// Step taken: OnboardingWizard split into wizard/steps/* in #693, file
// dropped from 2,672 → ~1,300 LOC. Next-biggest survivor is
// NetworkDashboard.tsx at 2,114 — held at 2,200 here until that split
// lands so the ratchet keeps pressure on the remaining four files.
//
// The backend root shares this ceiling. It briefly had its own, looser pin
// (MAX_BACKEND_FILE_LOC = 2,400, #2379) because the newly-measured
// `lib/mcp/server.ts` sat at 2,391 LOC; #2384 split that file into
// `lib/mcp/tools/*` per tool group, so the separate pin is gone and both
// roots are back on one number. Ratchet target: 1,500 with the frontend.
// ---------------------------------------------------------------------------
const MAX_FILE_LOC = 2_200;

async function checkFileSize() {
    let over2000 = 0;
    for (const root of [SRC, BACKEND_SRC]) {
        const files = await walk(root, isTs);
        let largest = { file: '(none)', loc: 0 };
        for (const file of files) {
            const content = await readFile(file, 'utf-8');
            const loc = content.split('\n').length;
            if (loc > 2_000) over2000++;
            if (loc > largest.loc) largest = { file: path.relative(REPO_ROOT, file), loc };
            if (loc > MAX_FILE_LOC) {
                violations.push({
                    check: 'file-size',
                    detail: `${path.relative(REPO_ROOT, file)} = ${loc} LOC (max ${MAX_FILE_LOC})`,
                });
            }
        }
        measurements.push(
            `largest file in ${path.relative(REPO_ROOT, root)}: ${largest.file} (${largest.loc} LOC, max ${MAX_FILE_LOC})`,
        );
    }
    measurements.push(`files over 2,000 LOC: ${over2000}`);
}

// ---------------------------------------------------------------------------
// 2. Security-path `as any` budget.
//
// Counts non-test `as any` casts in security-critical modules. Budget is 0 —
// new `as any` in these paths needs an explicit ratchet bump + justification.
//
// Paths are repo-relative and must stay that way (#2379): they used to be
// written as pre-workspace-split `src/...`, which no longer exists, so every
// `stat()` below threw and the loop `continue`d — the check silently measured
// zero files. Keep these in sync with docs/ARCHITECTURE_INVARIANTS.md.
// ---------------------------------------------------------------------------
const SECURITY_PATHS = [
    'packages/backend/src/lib/auth',
    'packages/backend/src/lib/mcp',
    'packages/backend/src/lib/agent/executor.ts',
    'packages/frontend/src/proxy.ts',
];
const SECURITY_AS_ANY_BUDGET = 0;

async function checkSecurityAnyBudget() {
    let count = 0;
    const offenders: string[] = [];
    for (const target of SECURITY_PATHS) {
        const abs = path.join(REPO_ROOT, target);
        let files: string[];
        try {
            const s = await stat(abs);
            files = s.isDirectory() ? await walk(abs, isTs) : [abs];
        } catch {
            // #2428: a listed security path that does not resolve is a
            // VIOLATION, not a silent skip — the pre-#2379 `continue` here is
            // exactly how this gate measured zero files while reporting green.
            violations.push({
                check: 'security-as-any-budget',
                detail: `${target} is listed in SECURITY_PATHS but does not exist — repoint it (do not drop it).`,
            });
            continue;
        }
        for (const file of files) {
            if (isTestFile(file)) continue;
            const content = await readFile(file, 'utf-8');
            const hits = content.match(/\bas any\b/g)?.length ?? 0;
            if (hits > 0) {
                count += hits;
                offenders.push(`${path.relative(REPO_ROOT, file)} (${hits})`);
            }
        }
    }
    measurements.push(`\`as any\` in security paths: ${count} (budget ${SECURITY_AS_ANY_BUDGET})`);
    if (count > SECURITY_AS_ANY_BUDGET) {
        violations.push({
            check: 'security-as-any-budget',
            detail: `${count} \`as any\` in security paths (budget ${SECURITY_AS_ANY_BUDGET}). Offenders: ${offenders.join(', ')}`,
        });
    }
}

// ---------------------------------------------------------------------------
// 2b. Backend-wide `as any` budget OUTSIDE the security paths.
//
// Forward-only ratchet (#969). Tightened from the 79 + uncounted baseline
// after the cleanup PR landed the 5 module clusters (network/layout,
// logger, terminal/sessionManager, ssh, plus the test/test.ts/exclusions).
// Drop this number when each subsequent cluster lands — never raise it
// without a justification + an issue.
//
// 2026-05-26 (#974): bumped 22 → 24 to absorb the two pre-existing casts in
// the relocated server.ts (Partial<NodeTwin> coercion on SYNC_PARTIAL /
// SYNC_DIFF payloads + the agentManager.agents Map peek for the periodic
// health sync). Both predate this move; the scanner just couldn't see
// them while the file lived in packages/frontend. Drop back to 22 once
// the bootstrap-layer casts get typed properly.
// ---------------------------------------------------------------------------
const BACKEND_AS_ANY_BUDGET = 24;

// ---------------------------------------------------------------------------
// 2c. Backend-wide `: any` ANNOTATION budget.
//
// #2723: the ratchets above gate `as any` — the *cast* — and nothing gated
// `: any`, the *annotation*. Both erase the type; only one cost anything to
// write, so the ungated spelling is where the erasure accumulated (79 hits at
// the ratchet's introduction, against a cast budget of 24). A budget covering
// one spelling of "opt out of the type system" and not the other reads as a
// gate and behaves as a suggestion.
//
// Scope is deliberately ALL of `packages/backend/src` (non-test), SECURITY_PATHS
// included: unlike `as any` there is no separate security budget here, so
// excluding them would leave the tightest code the only place a `: any` is
// unmeasured.
//
// Forward-only ratchet, same contract as BACKEND_AS_ANY_BUDGET: drop the number
// as annotations get typed; never raise it without a justification + an issue.
//
// 2026-09-02 (#2723): introduced at the measured value at HEAD.
// ---------------------------------------------------------------------------
const BACKEND_COLON_ANY_BUDGET = 79;

// Both ratchets walk the same tree, so they share one pass. `skipSecurity`
// drops the files the tighter SECURITY_AS_ANY_BUDGET already counts, so no cast
// is double-counted; SECURITY_PATHS are repo-relative (#2379), compared directly.
const BACKEND_ANY_RATCHETS = [
    { check: 'backend-as-any-budget', label: '`as any` in packages/backend/src outside security paths', re: /\bas any\b/g, budget: BACKEND_AS_ANY_BUDGET, skipSecurity: true, remedy: 'New violations need to be cleared or the budget bumped with a justification.' },
    { check: 'backend-colon-any-budget', label: '`: any` annotations in packages/backend/src', re: /:\s*any\b/g, budget: BACKEND_COLON_ANY_BUDGET, skipSecurity: false, remedy: 'Type the annotation, or bump the budget with a justification + an issue.' },
];

async function checkBackendAnyBudgets() {
    const root = path.join(REPO_ROOT, 'packages/backend/src');
    // #2428 failure shape: a ratchet whose root does not resolve scans nothing
    // and reports green. That is a violation, never a silent skip.
    const files = await walk(root, isTs).catch(() => null);
    if (!files) {
        violations.push({ check: 'backend-any-budgets', detail: 'packages/backend/src does not resolve — the `as any` / `: any` ratchets scanned nothing.' });
        return;
    }
    const inSecurity = (rel: string) => SECURITY_PATHS.some(p => rel === p || rel.startsWith(`${p}/`));
    const tallies = BACKEND_ANY_RATCHETS.map(r => ({ ...r, count: 0, offenders: [] as string[] }));
    for (const file of files) {
        if (isTestFile(file)) continue;
        const rel = path.relative(REPO_ROOT, file);
        const content = await readFile(file, 'utf-8');
        for (const t of tallies) {
            if (t.skipSecurity && inSecurity(rel)) continue;
            const hits = content.match(t.re)?.length ?? 0;
            t.count += hits;
            if (hits > 0) t.offenders.push(`${rel} (${hits})`);
        }
    }
    for (const t of tallies) {
        measurements.push(`${t.label}: ${t.count} (budget ${t.budget})`);
        if (t.count <= t.budget) continue;
        violations.push({ check: t.check, detail: `${t.count} ${t.label} (budget ${t.budget}). ${t.remedy} Offenders: ${t.offenders.join(', ')}` });
    }
}

// ---------------------------------------------------------------------------
// 3. executor.exec template-literal interpolation count.
//
// The safe path is `executor.execArgv([...])` via shellQuoteAll. Template
// literals with ${...} are the shell-injection foot-gun documented in the
// audit. Ratcheted to 0 in #602 — every previous offender swept; the
// ESLint rule is now `error` everywhere.
//
// #2428: this walked `SRC` (the frontend) only, while essentially every
// `executor.exec` call site in the repo lives under `packages/backend/src`.
// The #2379 sweep repointed the other aggregate checks at both roots and
// missed this one — so the check `.semgrep.yml` names as "the single source of
// truth" for the aggregate count scanned none of the code it exists to guard.
// Both roots now, like `checkFileSize` / `checkTwinFanIn`.
// ---------------------------------------------------------------------------
const EXEC_TEMPLATE_LITERAL_MAX = 0;

// ---------------------------------------------------------------------------
// 3b. executor.execArgv call-site count. Sibling of EXEC_TEMPLATE_LITERAL_MAX.
//
// `execArgv(argv)` used to be `exec(shellQuoteAll(argv))` — a structured argv
// quoted into a shell string and re-parsed on the host, a layer in which a
// filename with a space or a `$` can mean something else. #2737 swept every
// call site onto `execSafe` (argv handed to the agent's `safe_exec` verbatim);
// `execArgv` survives only as a deprecated alias. Zero keeps the shell-string
// tier for argv from regrowing. Sites that genuinely need a shell stay on
// `exec()` and each carries a comment saying why.
// ---------------------------------------------------------------------------
const EXEC_ARGV_MAX = 0;

async function checkExecCallSiteBudgets() {
    const budgets = [
        // Conservative: only flags template literals that contain ${...}.
        { label: 'executor.exec template-literal call sites', check: 'exec-template-literal',
          re: /\b\w+\.exec\(`[^`]*\$\{[^`]*`/g, max: EXEC_TEMPLATE_LITERAL_MAX, remedy: 'Use execSafe instead.' },
        // A *call site*: `<expr>.execArgv(`. The method declaration and the
        // interface signature are not calls, so they stay allowed.
        { label: 'executor.execArgv call sites', check: 'exec-argv-call-site',
          re: /\.execArgv\(/g, max: EXEC_ARGV_MAX,
          remedy: 'execArgv is a deprecated alias for execSafe (#2737) — call execSafe directly, or exec() with a comment saying why a shell is needed.' },
    ];
    const files = [...await walk(SRC, isTs), ...await walk(BACKEND_SRC, isTs)];
    const roots = [SRC, BACKEND_SRC].map(r => path.relative(REPO_ROOT, r)).join(' + ');
    for (const b of budgets) {
        let count = 0;
        const offenders: string[] = [];
        for (const file of files) {
            if (isTestFile(file)) continue;
            const hits = (await readFile(file, 'utf-8')).match(b.re)?.length ?? 0;
            if (hits > 0) { count += hits; offenders.push(`${path.relative(REPO_ROOT, file)} (${hits})`); }
        }
        measurements.push(`${b.label}: ${count} across ${files.length} files in ${roots} (max ${b.max})`);
        if (count > b.max) {
            violations.push({ check: b.check, detail: `${count} ${b.label} (max ${b.max}). ${b.remedy} Offenders: ${offenders.join(', ')}` });
        }
    }
}

// ---------------------------------------------------------------------------
// 4. withApiHandler adoption ratio.
//
// Routes that hand-roll their own try/catch + envelope drift apart. The
// abstraction in src/lib/api/handler.ts is the SoT. Should monotonically
// increase; ratchet up after each cluster migration so any regression
// fails CI immediately. The #603 burn-down completed the migration:
// 108/108 routes (100%) now use withApiHandler / withApiHandlerParams.
// Floor is locked at 1.0 — every new route.ts must use the wrapper
// (the `sb/api-route-needs-handler` ESLint rule, now `error`, is the
// per-export gate; this ratio is the file-level backstop).
// ---------------------------------------------------------------------------
const MIN_WITH_API_HANDLER_RATIO = 1.0;

async function checkWithApiHandlerAdoption() {
    const routeFiles = await walk(path.join(SRC, 'app', 'api'), p => p.endsWith('/route.ts'));
    if (routeFiles.length === 0) return;
    let adopted = 0;
    for (const file of routeFiles) {
        const content = await readFile(file, 'utf-8');
        // #603 — match both the static-route wrapper and the
        // dynamic-segment variant (`withApiHandlerParams`).
        if (/\bwithApiHandler(Params)?\s*[<(]/.test(content)) adopted++;
    }
    const ratio = adopted / routeFiles.length;
    measurements.push(
        `withApiHandler adoption: ${adopted}/${routeFiles.length} route.ts files ` +
        `(${(ratio * 100).toFixed(1)}%, floor ${(MIN_WITH_API_HANDLER_RATIO * 100).toFixed(0)}%)`,
    );
    if (ratio < MIN_WITH_API_HANDLER_RATIO) {
        violations.push({
            check: 'with-api-handler-adoption',
            detail: `${adopted}/${routeFiles.length} (${(ratio * 100).toFixed(1)}%) of route.ts files use withApiHandler — below floor ${(MIN_WITH_API_HANDLER_RATIO * 100).toFixed(1)}%. New routes must use it.`,
        });
    }
}

// ---------------------------------------------------------------------------
// 5. Singleton fan-in to DigitalTwinStore.
//
// Architecture audit ARCH-05ff flags that reads should go through a reader
// API. Ratcheted to 0 now that all Next.js route call-sites use repository.ts
// selectors (#841, #842) — the run prints the measured count.
//
// Scans both `src/` (Next.js routes / pages / components) and
// `packages/backend/src/` (extracted backend library). The store itself
// (`store/twin.ts`), the encapsulation layer (`store/repository.ts`),
// and the process entry point (`server.ts`, the bootstrap site that
// constructs the singleton and broadcasts twin:state to the socket)
// are the only allowed call sites.
// ---------------------------------------------------------------------------
const TWIN_GETINSTANCE_MAX = 0;

async function checkTwinFanIn() {
    const files = [
        ...await walk(SRC, isTs),
        ...await walk(BACKEND_SRC, isTs),
    ];
    let count = 0;
    for (const file of files) {
        if (isTestFile(file)) continue;
        // Skip the store itself and the encapsulation layer.
        if (file.endsWith(path.join('store', 'twin.ts'))) continue;
        if (file.endsWith(path.join('store', 'repository.ts'))) continue;
        // Skip the process entry point — bootstrap legitimately gets the
        // singleton once and wires the twin:state socket broadcast.
        if (file.endsWith(path.join('backend', 'src', 'server.ts'))) continue;
        const content = await readFile(file, 'utf-8');
        const hits = content.match(/\bDigitalTwinStore\.getInstance\(\)/g)?.length ?? 0;
        count += hits;
    }
    measurements.push(`DigitalTwinStore.getInstance() call sites: ${count} (max ${TWIN_GETINSTANCE_MAX})`);
    if (count > TWIN_GETINSTANCE_MAX) {
        violations.push({
            check: 'twin-singleton-fan-in',
            detail: `${count} direct DigitalTwinStore.getInstance() call sites (max ${TWIN_GETINSTANCE_MAX}). Route new reads through packages/backend/src/lib/store/repository.ts.`,
        });
    }
}

// ---------------------------------------------------------------------------
// 6. Durable-state files are written atomically.
//
// `config.json` and `checks.json` under DATA_DIR are the operator's data, not
// caches: losing one re-onboards the box or drops every configured health
// check. A bare `fs.writeFile`/`writeFileSync` truncates the target before the
// new bytes land, so a power cut / OOM-kill / container stop mid-write leaves
// the file permanently half-written. `lib/util/atomicWrite.ts` is the only
// sanctioned way to touch them (tmp → fsync → rename: a crash leaves the
// ORIGINAL intact).
//
// #2414: `config/transformer.ts` — the boot-time normalizer that ran before
// the first `getConfig()` on every backend start — wrote config.json bare while
// `config.ts` next door already used `atomicWriteFile`. Two writers, two
// durability contracts, on the one file whose loss is unrecoverable from the UI.
// This check is the ratchet that keeps the second writer from coming back.
// (#2725 deleted that module and folded its one live migration into
// `config.ts`, so there is now a single boot-time writer, still listed below.)
//
// The budget is 0 and the list is forward-only: add a module when it starts
// owning durable DATA_DIR state; never delete one to make a bare write pass.
// `lib/util/atomicWrite.ts` is deliberately absent — it IS the primitive, and
// its own `writeFileSync` is the fsync'd temp-file write.
// ---------------------------------------------------------------------------
const DURABLE_STATE_MODULES = [
    'packages/backend/src/lib/config.ts',
    'packages/backend/src/lib/health/store.ts',
];
const DURABLE_STATE_BARE_WRITE_BUDGET = 0;

// `fs.writeFile(` / `fsSync.writeFileSync(` (namespace import) and the bare
// `writeFile(` / `writeFileSync(` named-import form. The `(?<![.\w])` guard
// keeps `atomicWriteFile(`, `atomicWriteFileSync(` and `executor.writeFile(`
// (a remote/agent write, not a local durable-state one) out of the count.
const BARE_WRITE_RE = /\bfs\w*\.writeFile(?:Sync)?\s*\(|(?<![.\w])writeFile(?:Sync)?\s*\(/g;

async function checkDurableStateAtomicWrites() {
    let count = 0;
    const offenders: string[] = [];
    for (const target of DURABLE_STATE_MODULES) {
        const abs = path.join(REPO_ROOT, target);
        let files: string[];
        try {
            const s = await stat(abs);
            files = s.isDirectory() ? await walk(abs, isTs) : [abs];
        } catch {
            // Unlike the older checks, a missing entry is a VIOLATION, not a
            // silent skip (#2379): a moved/renamed module must not quietly
            // disable its own durability gate.
            violations.push({
                check: 'durable-state-atomic-write',
                detail: `${target} is listed as a durable-state module but does not exist — update DURABLE_STATE_MODULES to its new path (do not drop it).`,
            });
            continue;
        }
        for (const file of files) {
            if (isTestFile(file)) continue;
            const content = await readFile(file, 'utf-8');
            const hits = content.match(BARE_WRITE_RE)?.length ?? 0;
            if (hits > 0) {
                count += hits;
                offenders.push(`${path.relative(REPO_ROOT, file)} (${hits})`);
            }
        }
    }
    measurements.push(
        `bare fs.writeFile/writeFileSync in the ${DURABLE_STATE_MODULES.length} durable-state modules: ` +
        `${count} (budget ${DURABLE_STATE_BARE_WRITE_BUDGET})`,
    );
    if (count > DURABLE_STATE_BARE_WRITE_BUDGET) {
        violations.push({
            check: 'durable-state-atomic-write',
            detail: `${count} bare fs.writeFile/writeFileSync call(s) in durable-state modules (budget ${DURABLE_STATE_BARE_WRITE_BUDGET}). Use atomicWriteFile / atomicWriteFileSync from packages/backend/src/lib/util/atomicWrite.ts — a bare write truncates the file a crash lands in. Offenders: ${offenders.join(', ')}`,
        });
    }
}

// ---------------------------------------------------------------------------
// 7. Every path a gate config names must resolve to a non-empty file set.
//
// This is the regression guard for the whole class of bug behind #2379 and
// #2428: a quality gate whose paths point at a tree that no longer exists
// scans nothing, finds nothing, and reports GREEN. The green is
// indistinguishable from a real pass — the failure mode is invisible by
// construction, which is why it survived a workspace split, a postmortem,
// and a follow-up sweep.
//
// Covered here:
//   - every glob under a `paths:` block in `.semgrep.yml`
//   - the depcruise roots passed on the `check:deps` command line
// `SECURITY_PATHS` and `DURABLE_STATE_MODULES` carry the same assertion inside
// their own checks (a listed path that does not resolve is a violation there).
//
// Glob semantics deliberately follow gitignore / Semgrepignore v2 — the
// interpretation semgrep is migrating to, and the one that makes
// `src/lib/systemBackup.ts` (anchored at the repo root) resolve to nothing.
// Matching the FUTURE semantics is the point: a path that only works under
// semgrep's legacy unanchored matching is already broken, it just hasn't
// been told yet.
// ---------------------------------------------------------------------------

/** Paths that name a real but untracked directory — never walked, always present. */
const GATE_PATH_EXEMPT = new Set(['node_modules/']);

const REPO_SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'dist-server', 'coverage', 'out',
]);

/** Every repo-relative file path, minus build output and vendored trees. */
async function walkRepoFiles(dir: string, out: string[] = []): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (REPO_SKIP_DIRS.has(entry.name) || entry.name.endsWith('-worktree')) continue;
            await walkRepoFiles(full, out);
        } else if (entry.isFile()) {
            out.push(path.relative(REPO_ROOT, full));
        }
    }
    return out;
}

/**
 * gitignore-style glob → RegExp over repo-relative paths.
 *
 * - a trailing `/` means "directory" (match anything beneath it)
 * - a `/` anywhere else anchors the pattern at the repo root
 * - a pattern with no `/` matches at any depth
 * - `*` / `?` do not cross `/`; `**` does
 */
export function gateGlobToRegExp(glob: string): RegExp {
    let g = glob.trim();
    const dirOnly = g.endsWith('/');
    if (dirOnly) g = g.slice(0, -1);
    const rooted = g.startsWith('/');
    if (rooted) g = g.slice(1);
    const anchored = rooted || g.includes('/');
    let re = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*' && g[i + 1] === '*') {
            i++;
            if (g[i + 1] === '/') {
                i++;
                re += '(?:.*/)?';
            } else {
                re += '.*';
            }
        } else if (c === '*') {
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`${anchored ? '^' : '(?:^|.*/)'}${re}${dirOnly ? '/' : '(?:$|/)'}`);
}

interface GateGlob {
    source: string;
    label: string;
    glob: string;
}

/**
 * Pull every glob under a `paths:` block out of `.semgrep.yml`.
 *
 * Line-based on purpose — the house rule is `node:`-only scripts with no new
 * dependency, and this file is ours (stable 4-space indentation, no anchors,
 * no flow-style sequences).
 */
export function extractSemgrepPathGlobs(yaml: string): GateGlob[] {
    const out: GateGlob[] = [];
    let rule = '(top-level)';
    let pathsIndent = -1;
    let kind: string | null = null;
    for (const raw of yaml.split('\n')) {
        if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
        const indent = raw.length - raw.trimStart().length;
        const id = /^\s*-?\s*id:\s*(\S+)/.exec(raw);
        if (id) rule = id[1];
        if (pathsIndent >= 0 && indent <= pathsIndent) {
            pathsIndent = -1;
            kind = null;
        }
        if (/^\s*paths:\s*$/.test(raw)) {
            pathsIndent = indent;
            kind = null;
            continue;
        }
        if (pathsIndent < 0) continue;
        const k = /^\s*(include|exclude):\s*$/.exec(raw);
        if (k) {
            kind = k[1];
            continue;
        }
        const item = /^\s*-\s*(.+?)\s*$/.exec(raw);
        if (item && kind) {
            out.push({
                source: '.semgrep.yml',
                label: `${rule} paths.${kind}`,
                glob: item[1].replace(/^['"]|['"]$/g, ''),
            });
        }
    }
    return out;
}

/** The positional roots `check:deps` hands depcruise (everything after `--config <file>`). */
export function extractDepcruiseRoots(script: string): string[] {
    const tokens = script.trim().split(/\s+/);
    const roots: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '--config') {
            i++;
            continue;
        }
        if (tokens[i].startsWith('-')) continue;
        roots.push(tokens[i]);
    }
    return roots;
}

async function checkGatePathsResolve() {
    const files = await walkRepoFiles(REPO_ROOT);
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
    };

    const globs: GateGlob[] = [
        ...extractSemgrepPathGlobs(await readFile(path.join(REPO_ROOT, '.semgrep.yml'), 'utf-8')),
        ...extractDepcruiseRoots(pkg.scripts['check:deps'] ?? '').map(root => ({
            source: 'package.json',
            label: 'check:deps root',
            glob: root.endsWith('/') ? root : `${root}/`,
        })),
    ];

    for (const g of globs) {
        if (GATE_PATH_EXEMPT.has(g.glob)) continue;
        const re = gateGlobToRegExp(g.glob);
        if (files.some(f => re.test(f))) continue;
        violations.push({
            check: 'gate-path-resolves',
            detail: `${g.source} — ${g.label}: \`${g.glob}\` matches no tracked file. A gate that scans nothing passes vacuously (#2379, #2428). Repoint it at the current tree, or delete the entry if it is genuinely obsolete.`,
        });
    }
}

// ---------------------------------------------------------------------------
// 8. Every local `check:*` gate runs in CI.
//
// #2429: `check:arch` is the documented "run everything" gate and chains
// invariants → backup-coverage → deps. CI reimplemented that chain as separate
// jobs and dropped the middle one, so `check:backup-coverage` — the only gate
// between "a template ships a new persistent volume" and "the box loses that
// data on a disk-loss reinstall" — passed locally and ran nowhere that gates a
// merge. Symmetric to check 7: there, a gate scans nothing; here, a gate runs
// nowhere. Both look green.
//
// An aggregator (`check:arch`) is satisfied when every `npm run` it chains is
// itself covered — CI is free to run the members as parallel jobs instead of
// the chain.
// ---------------------------------------------------------------------------
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * The subset of a workflow file GitHub Actions actually EXECUTES: the shell text
 * of every `run:` step (inline scalar or `|`/`>` block), with comment-only lines
 * dropped.
 *
 * #2466: this check used to match `npm run <name>` against the raw joined text
 * of every workflow file, so a `#` comment satisfied it just as well as a step.
 * ci.yml already carries prose comments naming script names next to (not inside)
 * their run steps — so deleting a real `- run: npm run check:foo` while leaving
 * its neighbouring comment kept the meta-gate green. That is the same "a gate
 * that runs nowhere reports green" failure (#2429) this check exists to catch,
 * one level up. Matching only executed text closes it.
 */
export function extractCiRunText(yamlText: string): string {
    const lines = yamlText.split('\n');
    const steps: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(?:(-\s+))?run:(.*)$/.exec(lines[i]);
        if (!m) continue;
        const keyIndent = m[1].length + (m[2]?.length ?? 0);
        const inline = m[3].trim();
        // `run: |`, `run: >-`, `run: |2` … — the command is the indented block
        // below. Anything else on the line IS the command (`run: npm ci`); an
        // empty value is a mapping (`defaults:` → `run:` → `shell:`), not a step.
        if (!/^[|>][+-]?\d*$/.test(inline)) {
            if (inline) steps.push(inline.replace(/^(['"])(.*)\1$/, '$2'));
            continue;
        }
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            if (lines[j].trim() === '') continue; // blank lines belong to the block
            if (lines[j].length - lines[j].trimStart().length <= keyIndent) break;
            body.push(lines[j].trimStart());
        }
        i = j - 1;
        steps.push(body.join('\n'));
    }
    // A `#` line inside a run block is a shell comment — also not executed.
    return steps
        .flatMap(s => s.split('\n'))
        .filter(l => !/^\s*#/.test(l))
        .join('\n');
}

async function checkCiRunsEveryCheckScript() {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};

    const workflowFiles = (await readdir(WORKFLOW_DIR)).filter(f => /\.ya?ml$/.test(f));
    const workflowText = (
        await Promise.all(workflowFiles.map(f => readFile(path.join(WORKFLOW_DIR, f), 'utf-8')))
    )
        .map(extractCiRunText)
        .join('\n');

    // Fail closed if the extractor itself goes blind (a workflow-syntax change
    // it can't parse). Without this, "no executed text" would silently turn the
    // reverse-drift scan below into a vacuous pass.
    if (!/\bnpm (run|ci)\b/.test(workflowText)) {
        violations.push({
            check: 'ci-runs-every-check-script',
            detail: `no executable \`run:\` step in .github/workflows/ mentions npm — the run-step extractor (extractCiRunText) parsed nothing, so this gate would pass vacuously (#2466). Fix the extractor for the workflow syntax in use.`,
        });
    }

    const runsInCi = (name: string) => new RegExp(`npm run ${name.replace(/[:]/g, '[:]')}(?![\\w:-])`).test(workflowText);

    const satisfied = (name: string, depth = 0): boolean => {
        if (runsInCi(name)) return true;
        if (depth > 2) return false;
        const members = [...(scripts[name] ?? '').matchAll(/npm run ([\w:-]+)/g)].map(m => m[1]);
        return members.length > 0 && members.every(m => satisfied(m, depth + 1));
    };

    for (const name of Object.keys(scripts)) {
        if (!name.startsWith('check:')) continue;
        if (satisfied(name)) continue;
        violations.push({
            check: 'ci-runs-every-check-script',
            detail: `package.json script \`${name}\` is never run under .github/workflows/ — a local-only gate is a gate that does not gate. Add it to a CI job (or chain it from one that already runs).`,
        });
    }

    // The reverse drift: a workflow that invokes a script the manifest no
    // longer defines fails the job at run time, not at review time.
    for (const [, name] of workflowText.matchAll(/npm run ([\w:-]+)/g)) {
        if (scripts[name]) continue;
        violations.push({
            check: 'ci-runs-every-check-script',
            detail: `.github/workflows/ runs \`npm run ${name}\`, which is not a script in package.json.`,
        });
    }
}

// ---------------------------------------------------------------------------
// 8b. The service-repo bootstrap step still consults the standards catalog.
//
// #2513: `get_service_standards` served an excellent index that nothing outside
// an already-connected MCP session referenced, so a sibling repo picked its
// stack, its CI and its storage before ever meeting the ADRs. The fix is a step
// — step 1 of the `create-service` recipe — plus the generated CLAUDE.md pointer
// the new repo carries from its first commit.
//
// A step that lives only in prose is a step an agent skips (CLAUDE.md
// § "Deterministic execution → scripts"), and prose is also what silently rots:
// re-order the recipe, drop the pointer block, and nothing complains. This check
// is the ratchet — the recipe must still name the tool in its FIRST ordered
// action, and must still carry a pointer block that references the tool, the
// assist fetch, and the gap-reporting convention.
// ---------------------------------------------------------------------------
const CREATE_SERVICE_ASSIST = path.join(REPO_ROOT, 'assists', 'create-service.md');
const BOOTSTRAP_BEGIN_RE = /<!-- BEGIN SERVICEBAY STANDARDS POINTER/;
const BOOTSTRAP_END_RE = /<!-- END SERVICEBAY STANDARDS POINTER -->/;
/** Every pointer block is worthless without these — same list as the module. */
const BOOTSTRAP_POINTER_REFS = ['get_service_standards', 'get_assist', 'standards-gap', 'workingAgreements'];

/**
 * Pure audit of the `create-service` recipe text. Returns one detail string per
 * problem (empty = the bootstrap step is intact). Exported so the suite can
 * exercise the RED path — a gate whose failure branch is never run is a gate
 * nobody knows still works.
 */
export function auditServiceRepoBootstrap(doc: string): string[] {
    const problems: string[] = [];

    // The first entry of the "## Ordered actions" list must be the standards step.
    const ordered = /\n## Ordered actions\n([\s\S]*?)(?:\n## |\s*$)/.exec(doc);
    if (!ordered) {
        problems.push('assists/create-service.md has no "## Ordered actions" section to carry the bootstrap step (#2513).');
    } else {
        const firstAction = /^1\.[\s\S]*?(?=^\d+\.\s)/m.exec(ordered[1])?.[0] ?? ordered[1];
        if (!firstAction.includes('get_service_standards')) {
            problems.push(
                'assists/create-service.md — the FIRST ordered action no longer names `get_service_standards`. Consulting the catalog must come before the image/stack/CI choices, or a new repo is built past the ADRs again (#2513).',
            );
        }
    }

    const start = doc.search(BOOTSTRAP_BEGIN_RE);
    const end = doc.search(BOOTSTRAP_END_RE);
    if (start < 0 || end < 0) {
        problems.push(
            'assists/create-service.md no longer carries the generated CLAUDE.md standards-pointer block. Regenerate it with `npm run standards:bootstrap -- --print` (#2513).',
        );
        return problems;
    }
    const block = doc.slice(start, end);
    for (const ref of BOOTSTRAP_POINTER_REFS) {
        if (block.includes(ref)) continue;
        problems.push(
            `assists/create-service.md — the standards-pointer block no longer mentions \`${ref}\`, so a repo bootstrapped from it loses that link into the catalog (#2513).`,
        );
    }
    return problems;
}

async function checkServiceRepoBootstrapStep() {
    const check = 'service-repo-bootstrap-step';
    let doc: string;
    try {
        doc = await readFile(CREATE_SERVICE_ASSIST, 'utf-8');
    } catch {
        violations.push({
            check,
            detail: 'assists/create-service.md is missing — it owns step 1 of the service-repo bootstrap (#2513).',
        });
        return;
    }

    const problems = auditServiceRepoBootstrap(doc);
    for (const detail of problems) violations.push({ check, detail });
    if (problems.length === 0) {
        measurements.push('service-repo bootstrap: step 1 of assists/create-service.md consults get_service_standards, pointer block intact');
    }
}

// ---------------------------------------------------------------------------
// 8b. Agent payloads are redacted at the LOG SINK, never per call site.
//
// #1211 masked the two command-path logs that carried the rendered quadlet
// `content` (plaintext env secrets). #2603 then found the state sync emitting
// the identical bytes through a *second* sink that nobody had routed through
// the redactor — the same leak, reopened by adding a caller. Both sides are
// now structural: agent.py redacts inside `log_structured`, and the backend
// (the process that actually writes the journal) redacts again in
// `tryHandleStructuredLog`, so a stale agent build can't leak through it.
//
// This check is the ratchet: it fails if either sink stops redacting, or if a
// second raw `logRaw` sink appears in the handler. Never relax it — tighten it.
// (The agent-side companion — "no new raw `sys.stderr.write` outside the
// redacting helpers" — is an AST scan in
// packages/backend/src/lib/agent/v4/tests/test_redact.py.)
// ---------------------------------------------------------------------------
const AGENT_PY = path.join(REPO_ROOT, 'packages/backend/src/lib/agent/v4/agent.py');
const AGENT_HANDLER_TS = path.join(REPO_ROOT, 'packages/backend/src/lib/agent/handler.ts');
/** Only `tryHandleStructuredLog` may write a raw (unformatted) agent line. */
const AGENT_LOGRAW_MAX = 1;

// ---------------------------------------------------------------------------
// 8c. The assist catalog has exactly ONE source (#2701) — see
// scripts/invariants/assistCatalogSingleSource.ts for the why.
// ---------------------------------------------------------------------------
async function checkAssistCatalogSingleSource() {
    const { check, problems, measurement } = await auditAssistCatalogSingleSource(REPO_ROOT);
    for (const detail of problems) violations.push({ check, detail });
    if (problems.length === 0 && measurement) measurements.push(measurement);
}

async function checkAgentLogRedaction() {
    const check = 'agent-log-redaction';
    let py: string;
    let ts: string;
    try {
        py = await readFile(AGENT_PY, 'utf-8');
        ts = await readFile(AGENT_HANDLER_TS, 'utf-8');
    } catch {
        violations.push({
            check,
            detail: 'packages/backend/src/lib/agent/{v4/agent.py,handler.ts} — one of the two agent log sinks is missing; the #1211/#2603 redaction guard cannot be verified.',
        });
        return;
    }

    const structuredBody = py.split('def log_structured(')[1]?.split('\ndef ')[0] ?? '';
    if (!structuredBody.includes('_redact_for_log(payload)')) {
        violations.push({
            check,
            detail: 'agent.py `log_structured()` no longer passes its payload through `_redact_for_log()`. Every structured payload (the state sync ships whole quadlet files) would reach the journal in plaintext again (#1211, #2603).',
        });
    }

    const relayBody = ts.split('private tryHandleStructuredLog(')[1]?.split('\n  private ')[0] ?? '';
    if (!relayBody.includes('redactStructuredLogLine(')) {
        violations.push({
            check,
            detail: 'handler.ts `tryHandleStructuredLog()` no longer routes the agent line through `redactStructuredLogLine()`. This is the process that writes the journal — it must redact even when the agent already did (#2603).',
        });
    }

    const logRawCalls = ts.match(/this\.logRaw\(/g)?.length ?? 0;
    if (logRawCalls > AGENT_LOGRAW_MAX) {
        violations.push({
            check,
            detail: `${logRawCalls} \`this.logRaw(\` call sites in handler.ts (max ${AGENT_LOGRAW_MAX}). A raw log sink bypasses the redaction — log through \`this.log\` with a redacted value instead (#2603).`,
        });
    }

    measurements.push(`agent log redaction: log_structured + tryHandleStructuredLog redact; ${logRawCalls} raw handler sink(s) (max ${AGENT_LOGRAW_MAX})`);
}

// ---------------------------------------------------------------------------
// 8c. Stored credentials reach a browser only as a projection, never as
//     the stored objects.
//
// #2605 is #1211/#2603 one layer up: the redaction existed and was applied on
// one egress (MCP `get_config` replaces `installManifest.credentials` with an
// entry count) but not on the other (`GET /api/system/credentials` returned
// `config.installManifest` verbatim, and `getConfig()` decrypts). Encryption at
// rest says nothing about the wire. The recurring fault is not the one route
// somebody forgot; it is that redaction was decided *per caller*.
//
// So the fix is a type: `CredentialView` = `Omit<Credential, 'password'>` plus
// the one derived bit the UI needs. The field is absent, not blanked, so a
// route holding a view cannot serialise the secret and a component holding one
// cannot read it. This check is the ratchet on that:
//
//   1. the view type still omits `password` (blanking it instead would put a
//      mask on the wire that a write-back could persist as the literal
//      password);
//   2. the credentials route's GET still projects through `toCredentialViews`;
//   3. no *other* API route reads `installManifest`. A new route that needs the
//      list must project too — adding it here is a deliberate act, which is
//      exactly what was missing all three times.
//
// The hand-over (`system/credentials/handover`) is the one path that may ship
// the plaintext, and it does not go through an API route reading the manifest
// directly — it builds the CSV in `lib/stackInstall/credentialsHandover.ts`
// against proof of delivery. Never relax this list — extend it consciously.
// ---------------------------------------------------------------------------
const CREDENTIALS_MANIFEST_TS = path.join(
    BACKEND_SRC, 'lib/stackInstall/credentialsManifest.ts',
);
const API_ROUTES_DIR = path.join(SRC, 'app/api');
/** API routes allowed to touch `config.installManifest` at all. */
const INSTALL_MANIFEST_ROUTES = new Set(['system/credentials/route.ts']);

async function checkCredentialHttpEgress() {
    const check = 'credential-http-egress';
    let manifestTs: string;
    try {
        manifestTs = await readFile(CREDENTIALS_MANIFEST_TS, 'utf-8');
    } catch {
        violations.push({
            check,
            detail: 'packages/backend/src/lib/stackInstall/credentialsManifest.ts is missing — the #2605 credential wire-shape guard cannot be verified.',
        });
        return;
    }

    if (!/interface CredentialView extends Omit<Credential, 'password'>/.test(manifestTs)) {
        violations.push({
            check,
            detail: "`CredentialView` no longer declares `extends Omit<Credential, 'password'>`. The wire shape must OMIT the secret, not blank it — a masked field is still a field a route can fill and a client can write back (#2605).",
        });
    }

    const routes = await walk(API_ROUTES_DIR, p => p.endsWith(`${path.sep}route.ts`));
    const offenders: string[] = [];
    for (const file of routes) {
        const rel = path.relative(API_ROUTES_DIR, file).split(path.sep).join('/');
        const raw = await readFile(file, 'utf-8');
        // Comments discuss the manifest freely (factory-reset explains what it
        // clears); only actual code counts as an egress.
        const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (!body.includes('installManifest')) continue;
        if (!INSTALL_MANIFEST_ROUTES.has(rel)) {
            offenders.push(rel);
            continue;
        }
        const get = body.split('export const GET')[1]?.split('export const ')[0] ?? '';
        if (!get.includes('toCredentialViews(')) {
            violations.push({
                check,
                detail: `packages/frontend/src/app/api/${rel} — GET no longer projects the manifest through \`toCredentialViews()\`. It would hand every stored password to the browser in plaintext again (#2605).`,
            });
        }
    }
    for (const rel of offenders) {
        violations.push({
            check,
            detail: `packages/frontend/src/app/api/${rel} reads \`installManifest\` but is not in INSTALL_MANIFEST_ROUTES. Project through \`toCredentialViews()\` and add it to that list deliberately — the credentials list must never leave the box with its passwords (#2605).`,
        });
    }

    measurements.push(
        `credential http egress: CredentialView omits password; ${INSTALL_MANIFEST_ROUTES.size} API route(s) may read installManifest, all projecting`,
    );
}

// ---------------------------------------------------------------------------
// 8d. The MCP audit log masks file BODIES, at any depth, from one shared
//     redactor.
//
// #2624 is the fourth instance of #1211's class (→ #2603 agent sink, → #2616
// journal history). `mcp/audit.ts` redacted a flat, exact-name denylist over
// the TOP LEVEL of a tool's args: it listed `kubeContent`/`yamlContent` but not
// `content`, so `write_file({path, content, node})` persisted every byte an
// agent wrote under /mnt/data — restored `.env` files, API keys, private keys —
// in plaintext in `DATA_DIR/mcp-audit.log` and its rotated copy. The nested
// bodies (`deploy_service`'s `extraFiles[].content`) and the newer alias
// (`update_service_yaml`'s `podSpecContent`) walked past it too.
//
// The recurring fault is never the one key somebody forgot; it is that the
// denylist is per-sink and shallow. So this is the ratchet on the fixed shape:
//
//   1. `recordAudit` still routes `args` through `redactArgs`;
//   2. `redactArgs` still recurses (a top-level-only pass is what missed the
//      nested bodies every previous time);
//   3. the sink still uses the SHARED `isSecretKey` from `mcp/redact.ts` rather
//      than growing a fifth private copy of the key matcher;
//   4. every `*Content` argument any MCP tool declares is listed in
//      `BODY_KEYS`. This is the part that makes a new sink fail MECHANICALLY:
//      adding `manifestContent: z.string()` to a tool without listing it is a
//      build failure, not a security review someone has to remember to do.
//
// Masking, not dropping: the log keeps the tool, caller, outcome, `path` and
// `<N chars redacted>`, so the operator still sees WHAT the agent did. Never
// relax this — tighten it.
// ---------------------------------------------------------------------------
const MCP_AUDIT_TS = path.join(BACKEND_SRC, 'lib/mcp/audit.ts');
const MCP_TOOLS_DIR = path.join(BACKEND_SRC, 'lib/mcp/tools');
/** Body-shaped args whose names don't end in `Content`. Floor, not ceiling. */
const EXTRA_BODY_ARGS = ['body', 'advancedConfig'];

/** Every arg name an MCP tool declares that carries a file/config body. */
async function collectBodyShapedToolArgs(): Promise<Set<string>> {
    const toolFiles = await walk(
        MCP_TOOLS_DIR,
        p => p.endsWith('.ts') && !p.endsWith('.test.ts'),
    );
    const declared = new Set<string>(EXTRA_BODY_ARGS);
    for (const file of toolFiles) {
        const raw = await readFile(file, 'utf-8');
        for (const m of raw.matchAll(/^\s*(\w*[Cc]ontent)\s*:\s*z\.string\(/gm)) {
            declared.add(m[1]);
        }
    }
    return declared;
}

async function checkMcpAuditRedaction() {
    const check = 'mcp-audit-redaction';
    let auditTs: string;
    try {
        auditTs = await readFile(MCP_AUDIT_TS, 'utf-8');
    } catch {
        violations.push({
            check,
            detail: 'packages/backend/src/lib/mcp/audit.ts is missing — the #2624 audit-log redaction guard cannot be verified.',
        });
        return;
    }

    const recordBody = auditTs.split('export async function recordAudit(')[1]?.split('\nexport ')[0] ?? '';
    if (!recordBody.includes('redactArgs(entry.args)')) {
        violations.push({
            check,
            detail: '`recordAudit()` no longer routes `entry.args` through `redactArgs()`. Every MCP tool argument — including `write_file`\'s full file body — would land in mcp-audit.log verbatim (#2624).',
        });
    }
    // The per-field fall-through must RECURSE. That one line is the whole
    // difference between this redactor and the top-level-only pass it
    // replaced, so pin it literally rather than "mentions the walker
    // somewhere" — a mutation that returns the value verbatim has to fail.
    if (!/return redactAuditValue\(value, depth \+ 1\);/.test(auditTs)
        || !/REDACT_MAX_DEPTH/.test(auditTs)) {
        violations.push({
            check,
            detail: 'audit.ts\'s arg redactor no longer walks nested values to a capped depth (`return redactAuditValue(value, depth + 1)` + `REDACT_MAX_DEPTH`). A top-level-only pass is exactly what let `deploy_service`\'s `extraFiles[].content` and `install_template`\'s `variables` through (#2603, #2624).',
        });
    }
    if (!/import \{[^}]*\bisSecretKey\b[^}]*\} from '\.\/redact'/.test(auditTs)) {
        violations.push({
            check,
            detail: 'audit.ts no longer imports `isSecretKey` from `./redact`. The secret-shaped-key matcher is shared on purpose — a private copy per sink is how this leak got reopened four times (#1211/#2603/#2616/#2624).',
        });
    }

    // The BODY_KEYS set, as written in the source, lowercased.
    const bodyKeysBlock = auditTs.split('const BODY_KEYS = new Set([')[1]?.split(']);')[0] ?? '';
    const bodyKeys = new Set(
        [...bodyKeysBlock.matchAll(/'([^']+)'/g)].map(m => m[1].toLowerCase()),
    );

    // Every body-shaped arg any MCP tool declares must be covered.
    const declared = await collectBodyShapedToolArgs();
    const uncovered = [...declared].filter(name => !bodyKeys.has(name.toLowerCase())).sort();
    for (const name of uncovered) {
        violations.push({
            check,
            detail: `MCP tool argument \`${name}\` carries a file/config body but is not in \`BODY_KEYS\` in packages/backend/src/lib/mcp/audit.ts. Its full value would be written to mcp-audit.log in plaintext. Add it there (the log keeps \`<N chars redacted>\` plus the path, so the event stays legible) — #2624.`,
        });
    }

    measurements.push(
        `mcp audit redaction: recordAudit redacts args recursively via shared isSecretKey; ${declared.size} body-shaped tool arg(s), all in BODY_KEYS`,
    );
}

// ---------------------------------------------------------------------------
// 8c. An approvalId handed to an agent must name a poll verb that exists.
//
// #2653/#2651: every `destroy`-tier tool and one-shot `request_token` return an
// `approvalId` and then said nothing about what happened to it. The fix is one
// read tool (`APPROVAL_STATUS_TOOL` in `lib/mcp/toolPolicy.ts`) referenced from
// the TWO places that mint such an id — the destroy-tier gate in `server.ts`
// and `request_token`'s one-shot branch. Three ways that regresses silently:
//
//   1. the constant names a tool nobody registers (rename, or a dropped
//      TOOL_SCOPES entry) → agents poll a tool that 404s;
//   2. a message re-spells the verb as a bare literal → the next rename fixes
//      the constant and leaves the message pointing at the old name;
//   3. `isDestroyTierTool` stops deriving from `TOOL_SCOPES` and grows its own
//      list of tool names → a NEW destroy tool skips the gate entirely, the
//      exact "two lists that can disagree" shape #2623 closed for scopes.
//
// All three are structural, so they are pinned here rather than left to prose.
// ---------------------------------------------------------------------------
const MCP_TOOL_POLICY_TS = path.join(BACKEND_SRC, 'lib/mcp/toolPolicy.ts');
const MCP_SERVER_TS = path.join(BACKEND_SRC, 'lib/mcp/server.ts');
const MCP_REQUEST_TOOLS_TS = path.join(BACKEND_SRC, 'lib/mcp/tools/requestTools.ts');

async function checkMcpApprovalPollability() {
    const check = 'mcp-approval-pollability';
    const [policy, server, requestTools] = await Promise.all(
        [MCP_TOOL_POLICY_TS, MCP_SERVER_TS, MCP_REQUEST_TOOLS_TS]
            .map(f => readFile(f, 'utf-8').catch(() => '')),
    );
    const declared = policy.match(/export const APPROVAL_STATUS_TOOL = '([^']+)'/)?.[1];
    if (!declared) {
        violations.push({
            check,
            detail: 'lib/mcp/toolPolicy.ts does not export `APPROVAL_STATUS_TOOL = \'<tool>\'` (or the file is unreadable). It is the single source for the verb that resolves an `approvalId`; without it every pending_approval message spells the name itself and drifts (#2653).',
        });
        return;
    }
    // The `pending_approval` result object, one-shot request_token's message,
    // and the scope table — the three regions the rules below read.
    const gate = server.split("status: 'pending_approval'")[1]?.split('};')[0] ?? '';
    const oneShot = requestTools.split('One-shot ${scopes[0]} token request filed as approval')[1]?.split('\n')[0] ?? '';
    const scopes = policy.split('export const TOOL_SCOPES')[1]?.split('\n};')[0] ?? '';
    // Several entries share a line, so count off the block, not per line.
    const destroyCount = [...scopes.matchAll(/(\w+)\s*:\s*'destroy'/g)].length;

    const rules: [ok: boolean, detail: string][] = [
        [new RegExp(`^\\s*${declared}\\s*:\\s*'`, 'm').test(policy),
            `\`APPROVAL_STATUS_TOOL\` names "${declared}", which has no entry in \`TOOL_SCOPES\`. An agent holding an approvalId would be sent to a tool that is never registered (#2653).`],
        [gate.includes('APPROVAL_STATUS_TOOL'),
            'The `pending_approval` result in lib/mcp/server.ts no longer interpolates `APPROVAL_STATUS_TOOL`. A destroy-tier caller gets an approvalId with no way to learn whether the approved action ran — the #2651 blind spot (#2653).'],
        [!new RegExp(`'[^']*\\b${declared}\\b[^']*'`).test(gate),
            `lib/mcp/server.ts hardcodes the literal "${declared}" in the pending_approval result. Use \`APPROVAL_STATUS_TOOL\` so a rename cannot leave the message naming a tool that no longer exists (#2653).`],
        [oneShot.includes('APPROVAL_STATUS_TOOL'),
            'One-shot `request_token`\'s message in lib/mcp/tools/requestTools.ts no longer interpolates `APPROVAL_STATUS_TOOL`. It hands back the same kind of approvalId as the destroy-tier gate and must name the same poll verb (#2653).'],
        [/TOOL_SCOPES\[toolName\] === 'destroy'/.test(policy),
            '`isDestroyTierTool` no longer derives the tier from `TOOL_SCOPES[toolName] === \'destroy\'`. A hand-maintained list of destroy-tier tool names is how a new destroy tool silently skips the approval gate (#2623/#2653).'],
        [destroyCount > 0,
            '`TOOL_SCOPES` declares no `destroy`-tier tool. Either the tier was dropped (the approval gate now gates nothing) or the table moved and this guard is reading the wrong text (#2653).'],
    ];
    for (const [ok, detail] of rules) {
        if (!ok) violations.push({ check, detail });
    }
    measurements.push(
        `mcp approval pollability: ${destroyCount} destroy-tier tool(s) + one-shot request_token all point at \`${declared}\` via APPROVAL_STATUS_TOOL`,
    );
}

// 8d. A health-check id the READ tool lists is one the WRITE tools accept.
// The rules live in their own module (this file is at its max-lines budget);
// see scripts/invariants/healthCheckIdLifecycle.ts for the why.
async function checkHealthCheckIdLifecycle() {
    const found = await auditHealthCheckIdLifecycle({ frontendSrc: SRC, backendSrc: BACKEND_SRC });
    violations.push(...found.violations);
    measurements.push(...found.measurements);
}

// 8e. Only lib/npm/ talks to NPM's admin API (#2731). depcruise keeps the
// transport import-private; this catches the bare `fetch` that re-derives the
// URL. See scripts/invariants/npmApiLiterals.ts.
async function checkNpmApiLiterals() {
    const found = await auditNpmApiLiterals({ frontendSrc: SRC, backendSrc: BACKEND_SRC });
    violations.push(...found.violations);
    measurements.push(...found.measurements);
}

// ---------------------------------------------------------------------------
// 9. docs/ARCHITECTURE_INVARIANTS.md's numbers are generated, not typed.
//
// #2427: the doc carried a hand-maintained measurement table ("largest backend
// file is lib/network/service.ts at 2,046 LOC", "files > 2,000 LOC: 2", the
// twin fan-in threshold as "35/40" when the enforced constant was 0). Nothing
// verified any of it, so it drifted on any normal day of merges and an agent
// orienting from it got false statements about the code.
//
// The fix is structural, not a re-type: the doc's THRESHOLDS are generated from
// the constants above, and drift is a build failure. Regenerate with
// `npm run check:invariants -- --write-docs`.
//
// The MEASURED values are deliberately not written to the doc at all — they
// change with every merge, so any file that stores them is stale by
// construction. `npm run check:invariants` prints them instead.
// ---------------------------------------------------------------------------
const INVARIANTS_DOC = path.join(REPO_ROOT, 'docs', 'ARCHITECTURE_INVARIANTS.md');
const DOC_BEGIN = '<!-- BEGIN GENERATED: thresholds — do not edit by hand -->';
const DOC_END = '<!-- END GENERATED: thresholds -->';

function renderThresholdBlock(): string {
    const rows: [string, string, string][] = [
        ['Max file LOC (each source root)', 'MAX_FILE_LOC', MAX_FILE_LOC.toLocaleString('en-US')],
        ['`as any` in security paths', 'SECURITY_AS_ANY_BUDGET', String(SECURITY_AS_ANY_BUDGET)],
        ['`as any` in `packages/backend/src` outside security paths', 'BACKEND_AS_ANY_BUDGET', String(BACKEND_AS_ANY_BUDGET)],
        ['`: any` annotations in `packages/backend/src` (security paths included)', 'BACKEND_COLON_ANY_BUDGET', String(BACKEND_COLON_ANY_BUDGET)],
        ['`executor.exec` template-literal call sites', 'EXEC_TEMPLATE_LITERAL_MAX', String(EXEC_TEMPLATE_LITERAL_MAX)],
        ['`executor.execArgv` call sites (deprecated alias for `execSafe`)', 'EXEC_ARGV_MAX', String(EXEC_ARGV_MAX)],
        ['`withApiHandler` adoption across `route.ts` files', 'MIN_WITH_API_HANDLER_RATIO', `${(MIN_WITH_API_HANDLER_RATIO * 100).toFixed(0)}%`],
        ['`DigitalTwinStore.getInstance()` call sites', 'TWIN_GETINSTANCE_MAX', String(TWIN_GETINSTANCE_MAX)],
        ['Bare `fs.writeFile`/`writeFileSync` in durable-state modules', 'DURABLE_STATE_BARE_WRITE_BUDGET', String(DURABLE_STATE_BARE_WRITE_BUDGET)],
    ];
    const lines = [
        DOC_BEGIN,
        '',
        '| Invariant | Constant in `scripts/check-invariants.ts` | Threshold |',
        '|---|---|---:|',
        ...rows.map(([what, constant, value]) => `| ${what} | \`${constant}\` | ${value} |`),
        '',
        `Source roots walked: ${[SRC, BACKEND_SRC].map(r => `\`${path.relative(REPO_ROOT, r)}\``).join(', ')}.`,
        '',
        `Security paths (\`SECURITY_PATHS\`): ${SECURITY_PATHS.map(p => `\`${p}\``).join(', ')}.`,
        '',
        `Durable-state modules (\`DURABLE_STATE_MODULES\`): ${DURABLE_STATE_MODULES.map(p => `\`${p}\``).join(', ')}.`,
        '',
        '_Generated from the constants — run `npm run check:invariants -- --write-docs` after changing one. For the **measured** values at HEAD run `npm run check:invariants`: they are deliberately not stored here, because a hand-maintained measurement table is stale the next time anyone merges (#2427)._',
        '',
        DOC_END,
    ];
    return lines.join('\n');
}

async function syncOrCheckThresholdDoc() {
    const doc = await readFile(INVARIANTS_DOC, 'utf-8');
    const start = doc.indexOf(DOC_BEGIN);
    const end = doc.indexOf(DOC_END);
    if (start < 0 || end < 0) {
        violations.push({
            check: 'invariants-doc-generated-block',
            detail: `docs/ARCHITECTURE_INVARIANTS.md is missing the generated threshold markers (${DOC_BEGIN} … ${DOC_END}).`,
        });
        return;
    }
    const current = doc.slice(start, end + DOC_END.length);
    const expected = renderThresholdBlock();
    if (current === expected) return;
    if (WRITE_DOCS) {
        await writeFile(INVARIANTS_DOC, doc.slice(0, start) + expected + doc.slice(end + DOC_END.length), 'utf-8');
        console.log('Rewrote the generated threshold block in docs/ARCHITECTURE_INVARIANTS.md.');
        return;
    }
    violations.push({
        check: 'invariants-doc-generated-block',
        detail: 'docs/ARCHITECTURE_INVARIANTS.md\'s generated threshold block is out of date with the constants in scripts/check-invariants.ts. Run `npm run check:invariants -- --write-docs`.',
    });
}

// Retired in Phase 3.3 (#764). The three FE↔BE ratchet counts
// (`fe-template-lib-imports`, `fe-backend-imports`, `fe-install-helpers`)
// became vacuous once Phase 3.2 (#763) moved the FE dirs out of `src/`,
// and now obsolete because the workspace boundary makes a forbidden
// import physically unresolvable. The `sb/no-fe-backend-import` ESLint
// rule remains as defense-in-depth + editor-time signal.

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
async function main() {
    await Promise.all([
        checkFileSize(),
        checkSecurityAnyBudget(),
        checkBackendAnyBudgets(),
        checkExecCallSiteBudgets(),
        checkWithApiHandlerAdoption(),
        checkTwinFanIn(),
        checkDurableStateAtomicWrites(),
        checkGatePathsResolve(),
        checkCiRunsEveryCheckScript(),
        checkServiceRepoBootstrapStep(),
        checkAssistCatalogSingleSource(),
        checkAgentLogRedaction(),
        checkCredentialHttpEgress(),
        checkMcpAuditRedaction(),
        checkMcpApprovalPollability(),
        checkHealthCheckIdLifecycle(),
        checkNpmApiLiterals(),
        syncOrCheckThresholdDoc(),
    ]);

    // #2427: the measured values are printed, never stored. The doc keeps the
    // generated thresholds; anything that changes on a normal merge lives here.
    console.log('Architecture invariants — measured at HEAD:');
    for (const m of measurements.sort()) console.log(`  · ${m}`);
    console.log('');

    if (violations.length === 0) {
        console.log('Architecture invariants: all checks passed.');
        return;
    }

    console.error('Architecture invariants: violations detected.\n');
    for (const v of violations) {
        console.error(`  [${v.check}] ${v.detail}`);
    }
    console.error('\nSee docs/ARCHITECTURE_INVARIANTS.md for the rubric and how to ratchet thresholds.');
    process.exit(1);
}

// Run only when invoked as the CLI. `gateGlobToRegExp` /
// `extractSemgrepPathGlobs` / `extractDepcruiseRoots` are imported by
// tests/scripts/gate-config-truth.test.ts, which must not trigger a full run
// (and a `process.exit`) just by importing them.
if (/check-invariants\.ts$/.test(process.argv[1] ?? '')) {
    main().catch(err => {
        console.error('check-invariants crashed:', err);
        process.exit(2);
    });
}
