/**
 * Invariant 10 — every recurring backend job goes through the runtime kernel
 * (#2738). Extracted from `scripts/check-invariants.ts`, which is at its
 * max-lines budget; the driver there calls `auditBareSetInterval` and folds the
 * result into the shared violation/measurement lists.
 *
 * ## Why
 *
 * Before #2738 the backend had **13** bare `setInterval` calls spread over
 * seven modules and `server.ts`. Not one of them was cleared on SIGTERM, and
 * nothing recorded what a "background job" even was, which bought two standing
 * defects:
 *
 *   - **Write-after-close.** A tick fired mid-restart kept writing to stores the
 *     process was already tearing down. Nothing sequenced the teardown, so the
 *     window was as wide as the shutdown.
 *   - **Boot order by line number.** `server.ts` was a linear boot script for
 *     ~30 subsystems; the only thing declaring what ran when was where the call
 *     happened to sit in the file.
 *
 * `packages/backend/src/lib/runtime/` is the fix: `timers.ts` owns the one
 * `setInterval` call, `lifecycle.ts` owns the registry — start in registration
 * order, stop in REVERSE registration order on SIGTERM, then sockets, then
 * exit. `server.ts` holds the task list and no timers.
 *
 * ## The budget
 *
 * `BACKEND_BARE_SETINTERVAL_BUDGET` is **0** outside the kernel directory: a new
 * recurring job registers a background task instead of reaching for a raw
 * timer. This is a ratchet — it may go down, never up. Tests are exempt (a test
 * drives its own fake clock); the kernel is exempt because it IS the mechanism,
 * the same way `lib/util/atomicWrite.ts` is exempt from the bare-write budget.
 *
 * The kernel path is asserted to resolve to a non-empty file set, for the reason
 * invariant 7 exists at all: a check pointed at a tree that no longer exists
 * scans nothing, finds nothing, and reports green (#2379, #2428).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface BackgroundTaskAuditResult {
    violations: { check: string; detail: string }[];
    measurements: string[];
}

/** Repo-relative root walked for bare timers. */
export const BACKEND_SRC_ROOT = 'packages/backend/src';

/** The runtime kernel — the only place a bare `setInterval` is allowed. */
export const RUNTIME_KERNEL_DIR = 'packages/backend/src/lib/runtime';

/** Bare `setInterval` call sites outside the kernel. Ratchet: 0, downward-only. */
export const BACKEND_BARE_SETINTERVAL_BUDGET = 0;

// `setInterval(` and `globalThis.setInterval(` / `timers.setInterval(`. The
// kernel's own `managedInterval(` never matches.
const BARE_SET_INTERVAL_RE = /\bsetInterval\s*\(/g;

const isTs = (p: string) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts');
const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p) || /(^|\/)(tests|__tests__)\//.test(p);

async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            out.push(...await walk(full));
        } else if (entry.isFile() && isTs(full)) {
            out.push(full);
        }
    }
    return out;
}

export async function auditBareSetInterval(repoRoot: string): Promise<BackgroundTaskAuditResult> {
    const check = 'backend-bare-setinterval';
    const violations: BackgroundTaskAuditResult['violations'] = [];

    const backendSrc = path.join(repoRoot, BACKEND_SRC_ROOT);
    const kernelDir = path.join(repoRoot, RUNTIME_KERNEL_DIR);

    const all = await walk(backendSrc);
    if (all.length === 0) {
        violations.push({
            check,
            detail: `${BACKEND_SRC_ROOT} does not resolve to any TypeScript file — the bare-setInterval ratchet scanned nothing.`,
        });
        return { violations, measurements: [] };
    }

    const kernelFiles = await walk(kernelDir);
    if (kernelFiles.length === 0) {
        violations.push({
            check,
            detail: `${RUNTIME_KERNEL_DIR} does not resolve to any TypeScript file — the runtime kernel moved or was deleted. Point RUNTIME_KERNEL_DIR at its new path (do not drop it).`,
        });
    }

    let count = 0;
    const offenders: string[] = [];
    for (const file of all) {
        if (isTestFile(file)) continue;
        if (file.startsWith(kernelDir + path.sep)) continue;
        const hits = (await readFile(file, 'utf-8')).match(BARE_SET_INTERVAL_RE)?.length ?? 0;
        if (hits > 0) {
            count += hits;
            offenders.push(`${path.relative(repoRoot, file)} (${hits})`);
        }
    }

    if (count > BACKEND_BARE_SETINTERVAL_BUDGET) {
        violations.push({
            check,
            detail: `${count} bare setInterval call site(s) in ${BACKEND_SRC_ROOT} outside ${RUNTIME_KERNEL_DIR} (budget ${BACKEND_BARE_SETINTERVAL_BUDGET}). Register a background task with registerBackgroundTask/registerIntervalTask from packages/backend/src/lib/runtime/lifecycle.ts, or take a named handle from managedInterval — an uncleared timer keeps writing while the process shuts down. Offenders: ${offenders.join(', ')}`,
        });
    }

    return {
        violations,
        measurements: [
            `bare setInterval in ${BACKEND_SRC_ROOT} outside the runtime kernel: ${count} (budget ${BACKEND_BARE_SETINTERVAL_BUDGET}); kernel files: ${kernelFiles.length}`,
        ],
    };
}
