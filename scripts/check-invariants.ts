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
 * top of each check and reference the PR/issue that authorized it.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

interface Violation {
    check: string;
    detail: string;
}

const violations: Violation[] = [];

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
// ---------------------------------------------------------------------------
const MAX_FILE_LOC = 2_200;

async function checkFileSize() {
    const files = await walk(SRC, isTs);
    for (const file of files) {
        const content = await readFile(file, 'utf-8');
        const loc = content.split('\n').length;
        if (loc > MAX_FILE_LOC) {
            violations.push({
                check: 'file-size',
                detail: `${path.relative(REPO_ROOT, file)} = ${loc} LOC (max ${MAX_FILE_LOC})`,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Security-path `as any` budget.
//
// Counts non-test `as any` casts in security-critical modules. Pinned to
// the current count (3, all in executor.ts error augmentation). New `as
// any` in these paths needs an explicit ratchet bump + justification.
// ---------------------------------------------------------------------------
const SECURITY_PATHS = [
    'src/lib/auth',
    'src/lib/mcp',
    'src/lib/agent/executor.ts',
    'src/proxy.ts',
];
const SECURITY_AS_ANY_BUDGET = 3;

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
    if (count > SECURITY_AS_ANY_BUDGET) {
        violations.push({
            check: 'security-as-any-budget',
            detail: `${count} \`as any\` in security paths (budget ${SECURITY_AS_ANY_BUDGET}). Offenders: ${offenders.join(', ')}`,
        });
    }
}

// ---------------------------------------------------------------------------
// 3. executor.exec template-literal interpolation count.
//
// The safe path is `executor.execArgv([...])` via shellQuoteAll. Template
// literals with ${...} are the shell-injection foot-gun documented in the
// audit. Ratcheted to 0 in #602 — every previous offender swept; the
// ESLint rule is now `error` everywhere.
// ---------------------------------------------------------------------------
const EXEC_TEMPLATE_LITERAL_MAX = 0;

async function checkExecTemplateLiterals() {
    const files = await walk(SRC, isTs);
    let count = 0;
    const offenders: string[] = [];
    for (const file of files) {
        if (isTestFile(file)) continue;
        const content = await readFile(file, 'utf-8');
        // Match: <ident>.exec(`...${ ... }...`)
        // Conservative: only flags template literals that contain ${...}.
        const re = /\b\w+\.exec\(`[^`]*\$\{[^`]*`/g;
        const hits = content.match(re)?.length ?? 0;
        if (hits > 0) {
            count += hits;
            offenders.push(`${path.relative(REPO_ROOT, file)} (${hits})`);
        }
    }
    if (count > EXEC_TEMPLATE_LITERAL_MAX) {
        violations.push({
            check: 'exec-template-literal',
            detail: `${count} \`executor.exec(\`...\${x}...\`)\` calls (max ${EXEC_TEMPLATE_LITERAL_MAX}). Use execArgv instead. Offenders: ${offenders.join(', ')}`,
        });
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
// 35 direct getInstance() consumers today. Architecture audit ARCH-05ff
// flags that this should go through a reader API. Pinned at 40 (slack
// for one or two new sites while the reader API is being built), ratchet
// to 5 (server.ts + reader module + tests) once it exists.
// ---------------------------------------------------------------------------
const TWIN_GETINSTANCE_MAX = 40;

async function checkTwinFanIn() {
    const files = await walk(SRC, isTs);
    let count = 0;
    for (const file of files) {
        if (isTestFile(file)) continue;
        // Skip the store itself.
        if (file.endsWith(path.join('store', 'twin.ts'))) continue;
        const content = await readFile(file, 'utf-8');
        const hits = content.match(/\bDigitalTwinStore\.getInstance\(\)/g)?.length ?? 0;
        count += hits;
    }
    if (count > TWIN_GETINSTANCE_MAX) {
        violations.push({
            check: 'twin-singleton-fan-in',
            detail: `${count} direct DigitalTwinStore.getInstance() call sites (max ${TWIN_GETINSTANCE_MAX}). Route new reads through a reader API.`,
        });
    }
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
        checkExecTemplateLiterals(),
        checkWithApiHandlerAdoption(),
        checkTwinFanIn(),
    ]);

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

main().catch(err => {
    console.error('check-invariants crashed:', err);
    process.exit(2);
});
