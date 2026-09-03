/**
 * Invariant 6 — durable state: writes are atomic (#2414) and adopted stores are
 * versioned (#2739, ADR 0016). Extracted from `scripts/check-invariants.ts`,
 * which is at its max-lines budget; the driver there calls
 * `auditDurableStateAtomicWrites` / `auditVersionedStores` and folds the
 * results into the shared violation/measurement lists.
 *
 * ## 6a — durable-state files are written atomically (#2414)
 *
 * `config.json` and `checks.json` under DATA_DIR are the operator's data, not
 * caches: losing one re-onboards the box or drops every configured health
 * check. A bare `fs.writeFile`/`writeFileSync` truncates the target before the
 * new bytes land, so a power cut / OOM-kill / container stop mid-write leaves
 * the file permanently half-written. `lib/util/atomicWrite.ts` is the only
 * sanctioned way to touch them (tmp -> fsync -> rename: a crash leaves the
 * ORIGINAL intact).
 *
 * #2414: `config/transformer.ts` — the boot-time normalizer that ran before the
 * first `getConfig()` on every backend start — wrote config.json bare while
 * `config.ts` next door already used `atomicWriteFile`. Two writers, two
 * durability contracts, on the one file whose loss is unrecoverable from the
 * UI. This check is the ratchet that keeps the second writer from coming back.
 * (#2725 deleted that module and folded its one live migration into
 * `config.ts`, so there is now a single boot-time writer, still listed below.)
 *
 * The budget is 0 and the list is forward-only: add a module when it starts
 * owning durable DATA_DIR state; never delete one to make a bare write pass.
 * `lib/util/atomicWrite.ts` is deliberately absent — it IS the primitive, and
 * its own `writeFileSync` is the fsync'd temp-file write.
 *
 * ## 6b — adopted durable stores stay on `defineStore` (#2739, ADR 0016)
 *
 * Writing durably is half the problem; the other half is CHANGING the shape
 * of what is written. `packages/backend/src/lib/store/defineStore.ts` is the
 * mechanism: a store declares `{ name, schema, version, migrations }`, an older
 * file is pulled forward through the registered migrations on load, and a NEWER
 * file is refused loudly instead of being silently overwritten by a downgraded
 * build. The predecessor — a `CURRENT_SCHEMA_VERSION` field nothing ever
 * branched on — was deleted in #2725; do not bring it back.
 *
 * Adoption is store-by-store, so this is a growth ratchet rather than a budget:
 * a module listed here must keep calling `defineStore`, must stay in
 * DURABLE_STATE_MODULES (so its writes stay atomic too), and the list may only
 * get longer. `VERSIONED_STORE_MIN` is the floor — lowering it is the explicit,
 * visible edit that un-adopts a store.
 *
 * `lib/store/defineStore.ts` itself is deliberately absent, for the same reason
 * `lib/util/atomicWrite.ts` is absent from the durable-state list: it IS the
 * mechanism.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface DurableStateAuditResult {
    violations: { check: string; detail: string }[];
    measurements: string[];
}

/** Repo-relative modules that own durable operator state under DATA_DIR. */
export const DURABLE_STATE_MODULES = [
    'packages/backend/src/lib/config.ts',
    'packages/backend/src/lib/health/store.ts',
    'packages/backend/src/lib/health/bootState.ts',
    'packages/backend/src/lib/network/store.ts',
];
export const DURABLE_STATE_BARE_WRITE_BUDGET = 0;

// `fs.writeFile(` / `fsSync.writeFileSync(` (namespace import) and the bare
// `writeFile(` / `writeFileSync(` named-import form. The `(?<![.\w])` guard
// keeps `atomicWriteFile(`, `atomicWriteFileSync(` and `executor.writeFile(`
// (a remote/agent write, not a local durable-state one) out of the count.
const BARE_WRITE_RE = /\bfs\w*\.writeFile(?:Sync)?\s*\(|(?<![.\w])writeFile(?:Sync)?\s*\(/g;

const isTs = (p: string) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts');
const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p) || p.includes('/tests/');

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

export async function auditDurableStateAtomicWrites(repoRoot: string): Promise<DurableStateAuditResult> {
    const check = 'durable-state-atomic-write';
    const violations: DurableStateAuditResult['violations'] = [];
    let count = 0;
    const offenders: string[] = [];

    for (const target of DURABLE_STATE_MODULES) {
        const abs = path.join(repoRoot, target);
        let files: string[];
        try {
            files = (await stat(abs)).isDirectory() ? await walk(abs) : [abs];
        } catch {
            // Unlike the older checks, a missing entry is a VIOLATION, not a
            // silent skip (#2379): a moved/renamed module must not quietly
            // disable its own durability gate.
            violations.push({
                check,
                detail: `${target} is listed as a durable-state module but does not exist — update DURABLE_STATE_MODULES to its new path (do not drop it).`,
            });
            continue;
        }
        for (const file of files) {
            if (isTestFile(file)) continue;
            const hits = (await readFile(file, 'utf-8')).match(BARE_WRITE_RE)?.length ?? 0;
            if (hits > 0) {
                count += hits;
                offenders.push(`${path.relative(repoRoot, file)} (${hits})`);
            }
        }
    }

    if (count > DURABLE_STATE_BARE_WRITE_BUDGET) {
        violations.push({
            check,
            detail: `${count} bare fs.writeFile/writeFileSync call(s) in durable-state modules (budget ${DURABLE_STATE_BARE_WRITE_BUDGET}). Use atomicWriteFile / atomicWriteFileSync from packages/backend/src/lib/util/atomicWrite.ts — a bare write truncates the file a crash lands in. Offenders: ${offenders.join(', ')}`,
        });
    }
    return {
        violations,
        measurements: [
            `bare fs.writeFile/writeFileSync in the ${DURABLE_STATE_MODULES.length} durable-state modules: ` +
            `${count} (budget ${DURABLE_STATE_BARE_WRITE_BUDGET})`,
        ],
    };
}

/** Repo-relative modules that own a durable store adopted onto `defineStore`. */
export const VERSIONED_STORE_MODULES = [
    'packages/backend/src/lib/health/bootState.ts',
    'packages/backend/src/lib/network/store.ts',
];

/** Floor for the adopted-store count. Forward-only: raise it as stores adopt. */
export const VERSIONED_STORE_MIN = 2;

const DEFINE_STORE_CALL = /\bdefineStore\s*[(<]/;

export async function auditVersionedStores(repoRoot: string): Promise<DurableStateAuditResult> {
    const check = 'versioned-store';
    const violations: DurableStateAuditResult['violations'] = [];
    let adopted = 0;

    for (const target of VERSIONED_STORE_MODULES) {
        let content: string;
        try {
            content = await readFile(path.join(repoRoot, target), 'utf-8');
        } catch {
            // Same rule as DURABLE_STATE_MODULES: a listed path that no longer
            // resolves is a VIOLATION, never a silent skip (#2379) — a moved
            // module must not quietly disable its own gate.
            violations.push({
                check,
                detail: `${target} is listed as a versioned store but does not exist — update VERSIONED_STORE_MODULES to its new path (do not drop it).`,
            });
            continue;
        }
        if (!DEFINE_STORE_CALL.test(content)) {
            violations.push({
                check,
                detail: `${target} is listed as a versioned store but no longer calls defineStore(). An adopted store keeps its declared version + migrations — see packages/backend/src/lib/store/defineStore.ts and ADR 0016.`,
            });
            continue;
        }
        if (!DURABLE_STATE_MODULES.includes(target)) {
            violations.push({
                check,
                detail: `${target} is a versioned store but is missing from DURABLE_STATE_MODULES — an adopted store must also stay under the atomic-write budget.`,
            });
            continue;
        }
        adopted++;
    }

    if (VERSIONED_STORE_MODULES.length < VERSIONED_STORE_MIN) {
        violations.push({
            check,
            detail: `VERSIONED_STORE_MODULES lists ${VERSIONED_STORE_MODULES.length} store(s) but the floor is ${VERSIONED_STORE_MIN}. The list is forward-only: adopt more stores, never fewer.`,
        });
    }

    return {
        violations,
        measurements: [
            `durable stores adopted onto defineStore: ${adopted} (floor ${VERSIONED_STORE_MIN}, forward-only)`,
        ],
    };
}
