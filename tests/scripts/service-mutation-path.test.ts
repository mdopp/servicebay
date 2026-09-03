import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import depcruiseConfig from '../../.dependency-cruiser.cjs';

/**
 * #2741 — the one-mutation-path rule must cover the SPLIT-OFF modules, not just
 * the file that used to hold everything.
 *
 * `service-manager-single-mutation-path` is what keeps every deploy / delete /
 * start / stop / restart behind `ServiceManager` (the bug #589 cleaned up was
 * exactly a second mutation path). When `serviceLifecycle.ts` was cut into
 * `services/lifecycle/*`, a rule that named two files by name would have gone
 * on passing while every verb it guarded moved to a module it did not mention —
 * green, and guarding nothing. That is the failure shape this file pins:
 *
 *   1. every module actually on disk under `services/lifecycle/` is matched by
 *      the rule's `to` pattern (and so is a hypothetical future one, because
 *      the pattern is a directory prefix, not a file list);
 *   2. a would-be importer from OUTSIDE `src/lib/services/` is in scope for the
 *      rule (the `from` filter does not exempt it) — i.e. the edge really is
 *      forbidden, which is the red probe;
 *   3. a sibling INSIDE `src/lib/services/` is exempt, so the facade and the
 *      modules can still talk to each other.
 *
 * The enforcement run itself is `npm run check:deps` (in `check:arch`); this
 * pins the rule's reach, which is the part that silently rots.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIFECYCLE_DIR = 'packages/backend/src/lib/services/lifecycle';

const rule = (depcruiseConfig.forbidden ?? []).find(
    (r: { name?: string }) => r.name === 'service-manager-single-mutation-path',
);

/** dependency-cruiser accepts a string or an array of strings for path filters. */
const asRegExps = (p: unknown): RegExp[] =>
    (Array.isArray(p) ? p : [p]).filter((s): s is string => typeof s === 'string').map(s => new RegExp(s));

const matchesAny = (patterns: unknown, candidate: string): boolean =>
    asRegExps(patterns).some(re => re.test(candidate));

/** True when the rule applies to an import originating at `candidate`. */
const ruleAppliesFrom = (candidate: string): boolean => {
    const from = (rule as { from?: { path?: unknown; pathNot?: unknown } }).from ?? {};
    if (from.path !== undefined && !matchesAny(from.path, candidate)) return false;
    if (from.pathNot !== undefined && matchesAny(from.pathNot, candidate)) return false;
    return true;
};

/** True when the rule forbids importing `candidate`. */
const ruleForbidsTarget = (candidate: string): boolean => {
    const to = (rule as { to?: { path?: unknown; pathNot?: unknown } }).to ?? {};
    if (to.path !== undefined && !matchesAny(to.path, candidate)) return false;
    if (to.pathNot !== undefined && matchesAny(to.pathNot, candidate)) return false;
    return true;
};

describe('service-manager-single-mutation-path covers the #2741 split modules', () => {
    it('is still an error-severity rule', () => {
        expect(rule).toBeDefined();
        expect((rule as { severity?: string }).severity).toBe('error');
    });

    it('guards the facade files it always guarded', () => {
        expect(ruleForbidsTarget('packages/backend/src/lib/services/serviceLifecycle.ts')).toBe(true);
        expect(ruleForbidsTarget('packages/backend/src/lib/services/serviceListing.ts')).toBe(true);
    });

    it('guards EVERY module that exists under services/lifecycle/', () => {
        const modules = readdirSync(path.join(REPO_ROOT, LIFECYCLE_DIR))
            .filter(f => f.endsWith('.ts'))
            .map(f => `${LIFECYCLE_DIR}/${f}`);

        // Guard the guard: if the split were reverted this list would be empty
        // and every assertion below would pass vacuously.
        expect(modules.length).toBeGreaterThan(5);
        for (const m of modules) {
            expect(ruleForbidsTarget(m), `${m} is not covered by the one-mutation-path rule`).toBe(true);
        }
    });

    it('covers a module added to services/lifecycle/ tomorrow', () => {
        expect(ruleForbidsTarget(`${LIFECYCLE_DIR}/someNewVerb.ts`)).toBe(true);
    });

    it('rejects a direct import of a split-off module from outside services/', () => {
        // The red probe: an MCP tool / API route reaching past the facade.
        const outsiders = [
            'packages/backend/src/lib/mcp/tools/serviceTools.ts',
            'packages/frontend/src/app/api/services/[name]/route.ts',
            'packages/backend/src/lib/install/performStackReset.ts',
        ];
        for (const outsider of outsiders) {
            expect(ruleAppliesFrom(outsider), `${outsider} should be in scope`).toBe(true);
        }
        expect(ruleForbidsTarget(`${LIFECYCLE_DIR}/trash.ts`)).toBe(true);
        expect(ruleForbidsTarget(`${LIFECYCLE_DIR}/units.ts`)).toBe(true);
    });

    it('still lets the facade and its siblings import each other', () => {
        expect(ruleAppliesFrom('packages/backend/src/lib/services/serviceLifecycle.ts')).toBe(false);
        expect(ruleAppliesFrom(`${LIFECYCLE_DIR}/deploy.ts`)).toBe(false);
        expect(ruleAppliesFrom('packages/backend/src/lib/services/forceUpdate.ts')).toBe(false);
    });

    it('keeps the facade as the only door — nothing outside services/ imports a lifecycle module', () => {
        // `git grep -l` exits 1 when nothing matches — that is "no importers".
        let hits = '';
        try {
            hits = execFileSync(
                'git',
                ['grep', '-l', '-E', "from '[^']*services/lifecycle/", '--', 'packages', 'scripts', 'tests'],
                { cwd: REPO_ROOT, encoding: 'utf-8' },
            );
        } catch { /* no matches at all */ }
        const offenders = hits
            .split('\n')
            .filter(Boolean)
            .filter(f => !f.startsWith('packages/backend/src/lib/services/'));
        expect(offenders).toEqual([]);
    });
});
