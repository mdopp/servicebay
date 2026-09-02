/**
 * Invariant 8d — a health-check id the READ tool lists is one the WRITE tools
 * accept. Extracted from `scripts/check-invariants.ts`, which is at its
 * max-lines budget; the driver there calls `auditHealthCheckIdLifecycle` and
 * folds the result into the shared violation/measurement lists.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 8d. A health-check id the READ tool lists is one the WRITE tools accept.
//
// #2654/#2655 (from #2651): `get_health_checks` merges TWO sources at read time
// (#2615) — the stored `checks.json` registry plus the synthetic
// `diagnose:<probeId>` rows the diagnose bridge projects. `delete_health_check`
// and `run_check_now` queried only the first, so ~27 diagnose ids the list tool
// had just handed the caller came back "No check with id … found".
//
// The fix is a resolver (`lib/health/checkLookup.ts`) that classifies an id
// against the SAME readers the list tool merges — not a second list of probe
// ids. Four ways that regresses silently:
//
//   1. the resolver stops asking the diagnose reader and pattern-matches or
//      enumerates probe ids instead → the next probe is listable but not
//      runnable, which is the whole defect back again;
//   2. a write verb goes back to deciding existence from
//      `HealthStore.getChecks()` directly → same split, one tool at a time;
//   3. `run_check_now`'s diagnose branch drops `manual: true` → it "succeeds"
//      and returns the STALE finding (#1709's distinction), the worst outcome
//      of the three because it looks like it worked;
//   4. the live-host removal path (`removeProxyHost` in
//      lib/reverseProxy/proxyHostProvisioning.ts — since #2731 the kernel the
//      DELETE route, the MCP tool and uninstall all call) stops reconciling
//      the auto-managed `domain:` checks, or reconciles without naming the
//      removed domain → the polled route snapshot rebuilds the check the
//      caller just retired and the 60s race in #2654 is back.
// ---------------------------------------------------------------------------
export interface SourceRoots {
    /** `packages/frontend/src`. */
    frontendSrc: string;
    /** `packages/backend/src`. */
    backendSrc: string;
}

export interface AuditResult {
    violations: { check: string; detail: string }[];
    measurements: string[];
}

/** The body of one `server.tool('<name>', …)` registration, up to the next one. */
function mcpToolBody(source: string, toolName: string): string {
    const head = source.split(`'${toolName}',`)[1];
    if (head === undefined) return '';
    return head.split(/\n  server\.tool\(/)[0];
}

export async function auditHealthCheckIdLifecycle(roots: SourceRoots): Promise<AuditResult> {
    const check = 'health-check-id-lifecycle';
    const violations: AuditResult['violations'] = [];
    const measurements: string[] = [];
    const [lookup, healthTools, provisioning] = await Promise.all([
        path.join(roots.backendSrc, 'lib/health/checkLookup.ts'),
        path.join(roots.backendSrc, 'lib/mcp/tools/healthTools.ts'),
        path.join(roots.backendSrc, 'lib/reverseProxy/proxyHostProvisioning.ts'),
    ].map(f => readFile(f, 'utf-8').catch(() => '')));
    if (!lookup) {
        violations.push({
            check,
            detail: 'packages/backend/src/lib/health/checkLookup.ts is missing. It is the single resolver that keeps get_health_checks, delete_health_check and run_check_now agreeing about which ids exist (#2654/#2655).',
        });
        return { violations, measurements };
    }

    const getChecksTool = mcpToolBody(healthTools, 'get_health_checks');
    const deleteTool = mcpToolBody(healthTools, 'delete_health_check');
    const runTool = mcpToolBody(healthTools, 'run_check_now');
    // A literal probe id anywhere in the resolver means the class is being
    // enumerated instead of derived. The prefix constant itself is imported,
    // never spelled, so any `'diagnose:<word>'` string is a list forming.
    const enumeratedProbeIds = [...lookup.matchAll(/'diagnose:\w+'/g)].map(m => m[0]);
    // `removeProxyHost` is everything from its export up to the next one.
    const removeHost = provisioning.split('export async function removeProxyHost')[1]?.split(/\nexport /)[0] ?? '';

    const rules: [ok: boolean, detail: string][] = [
        [/getDiagnoseChecksEnriched\s*\(/.test(lookup),
            'lib/health/checkLookup.ts no longer calls `getDiagnoseChecksEnriched()`. The diagnose class must be DERIVED from the same reader `get_health_checks` merges — otherwise a probe becomes listable without becoming runnable, which is #2655 (#2654/#2655).'],
        [enumeratedProbeIds.length === 0,
            `lib/health/checkLookup.ts enumerates probe ids (${enumeratedProbeIds.join(', ')}). There are ~27 diagnose probes and the registry grows; resolve against the reader instead of maintaining a second list (#2655).`],
        [/resolveCheckId\s*\(/.test(deleteTool),
            '`delete_health_check` in lib/mcp/tools/healthTools.ts no longer resolves its id via `resolveCheckId`. Deciding existence from the stored registry alone is exactly how it rejected ids `get_health_checks` had just listed (#2655).'],
        [/resolveCheckId\s*\(/.test(runTool),
            '`run_check_now` in lib/mcp/tools/healthTools.ts no longer resolves its id via `resolveCheckId`, so diagnose ids the list tool returns are rejected again (#2655).'],
        [/runDiagnoseChecks\s*\([^)]*manual:\s*true/.test(runTool),
            '`run_check_now` no longer dispatches the diagnose re-run with `manual: true`. Without it a reader probe re-displays its STORED report, so the tool reports success while returning the stale finding — worse than the 400 it replaced (#2655, #1709).'],
        [/getDiagnoseChecksEnriched\s*\(/.test(getChecksTool) && /HealthStore\.getChecks\s*\(/.test(getChecksTool),
            '`get_health_checks` no longer merges both the stored checks and the diagnose rows. The resolver classifies exactly those two sources; if the list tool reads a different set the two drift apart again (#2615/#2655).'],
        [/syncDomainChecks\s*\(\s*\{\s*removedDomains/.test(removeHost),
            '`removeProxyHost` in lib/reverseProxy/proxyHostProvisioning.ts no longer reconciles the domain checks with `syncDomainChecks({ removedDomains: [...] })`. It is the one path every live-host removal takes (DELETE route, MCP remove_proxy_route, uninstall — #2731); without the named domain the polled route snapshot rebuilds the check that was just retired, restoring the 60s read/write race (#2654).'],
    ];

    for (const [ok, detail] of rules) {
        if (!ok) violations.push({ check, detail });
    }
    measurements.push(
        `health check id lifecycle: get_health_checks/delete_health_check/run_check_now all resolve ids via lib/health/checkLookup.ts (diagnose class derived, ${enumeratedProbeIds.length} probe ids enumerated)`,
    );
    return { violations, measurements };
}
