/**
 * Invariant 8e — NPM's admin API is spoken to from `lib/npm/` only (#2731).
 * Extracted into its own module because `scripts/check-invariants.ts` is at
 * its max-lines budget; the driver there calls `auditNpmApiLiterals` and
 * folds the result into the shared violation/measurement lists.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 8e. Only lib/npm/ talks to Nginx Proxy Manager's admin API.
//
// Before #2731 the NPM client existed eleven times: the proxy-hosts route, the
// migration orchestrator, two health probes, four diagnose probes and the MCP
// tools each carried their own `fetch(`${adminUrl}/api/nginx/...`)` with its
// own timeout, its own error text and its own idea of what a 400 means. The
// fix is one transport (`lib/npm/http.ts`) and one typed client next to it;
// `.dependency-cruiser.cjs` (`npm-api-only-from-lib-npm`) keeps the transport
// import-private to `lib/npm/`.
//
// depcruise sees the import graph, not strings. A caller that re-derives the
// URL with a bare `fetch` never imports the transport, so the graph rule does
// not fire — this check does: no `/api/nginx` literal outside `lib/npm/`.
// Test files are exempt (they stub fetch by URL on purpose); comments are
// not, because a comment naming the endpoint is the first line of the next
// hand-rolled client.
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

/** Directory (relative to `backendSrc`) that owns the NPM admin API. */
export const NPM_CLIENT_DIR = 'lib/npm';

const NPM_API_LITERAL = /\/api\/nginx\b/g;

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
        } else if (entry.isFile() && isTs(full) && !isTestFile(full)) {
            out.push(full);
        }
    }
    return out;
}

export async function auditNpmApiLiterals(roots: SourceRoots): Promise<AuditResult> {
    const check = 'npm-api-only-from-lib-npm';
    const violations: AuditResult['violations'] = [];
    const clientDir = path.join(roots.backendSrc, NPM_CLIENT_DIR) + path.sep;
    const files = [...await walk(roots.frontendSrc), ...await walk(roots.backendSrc)];

    let insideClient = 0;
    const offenders: string[] = [];
    for (const file of files) {
        const source = await readFile(file, 'utf-8');
        const hits = source.match(NPM_API_LITERAL)?.length ?? 0;
        if (hits === 0) continue;
        if (file.startsWith(clientDir)) {
            insideClient += hits;
            continue;
        }
        const line = source.slice(0, source.search(NPM_API_LITERAL)).split('\n').length;
        offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
    }

    for (const where of offenders) {
        violations.push({
            check,
            detail: `${where} names NPM's admin API (\`/api/nginx…\`) outside packages/backend/src/${NPM_CLIENT_DIR}/. Call the typed client instead (lib/npm/proxyHosts, certs, accessLists) — one transport, one set of timeouts and error shapes (#2731).`,
        });
    }
    return {
        violations,
        measurements: [
            `NPM admin API literals: ${insideClient} inside ${NPM_CLIENT_DIR}/, ${offenders.length} outside (threshold 0)`,
        ],
    };
}
