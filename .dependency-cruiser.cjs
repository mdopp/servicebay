/**
 * Module-boundary invariants.
 *
 * Encodes the architecture-doc rules as import-graph forbidden edges so
 * a violating PR fails CI rather than waiting for the next architect
 * review. Each rule names the audit section / issue that justifies it.
 *
 * Run via: `npx depcruise --config .dependency-cruiser.cjs src server.ts`
 *
 * ## Ratchet exemptions
 *
 * **None (2026-09-02).** `npm run check:deps` is green with no debt carve-outs:
 * the 2026-05-17 audit batch — 6 circular deps in core, 3 `lib → app` imports,
 * and the forked Mustache renderer in `reconfigure-preview/route.ts` — has been
 * paid off in full, and the `pathNot` lists that carried them are gone.
 *
 * The `pathNot` entries that remain below are **scoping, not debt**, so don't
 * read them as an exemption backlog:
 *   - `no-orphans` — framework-resolved files (Next.js App Router conventions,
 *     `public/`, config + test files) that are never statically imported.
 *   - `one-renderer` — `template/render.ts` itself, the one module allowed to
 *     import mustache.
 *   - `no-test-from-prod` / `service-manager-single-mutation-path` — a `from`
 *     filter that says which side of the boundary the rule applies to.
 *
 * If a future rule does ship a debt carve-out, list it here with its date and
 * drop entries as they are fixed; when its list empties, delete the `pathNot`.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment:
                'Circular dependencies make refactoring and reasoning painful. ' +
                '#601 broke the last known cycle (extracted verifyNodeConnection ' +
                'from nodes.ts to nodes/verify.ts). Any new cycle now fails CI.',
            from: {},
            to: { circular: true },
        },
        {
            name: 'no-orphans',
            severity: 'warn',
            comment: 'Orphans usually mean dead code — confirm and delete, or wire them up.',
            from: {
                orphan: true,
                pathNot: [
                    '\\.d\\.ts$',
                    '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
                    '\\.config\\.(js|cjs|mjs|ts)$',
                    '\\.test\\.(js|ts|tsx)$',
                    '(^|/)tests?/',
                    '(^|/)scripts/',
                    '(^|/)next-env\\.d\\.ts$',
                    // Next.js App Router conventions — these are resolved by the
                    // framework, not via static imports.
                    '(^|/)src/app/(page|layout|loading|error|not-found|globals\\.css)\\.tsx?$',
                    '(^|/)src/app/.*/(page|layout|loading|error|not-found)\\.tsx?$',
                    '(^|/)src/app/api/.*/route\\.ts$',
                    // public/ files are loaded by the browser at runtime
                    // (service workers, favicons), not imported from JS.
                    '(^|/)public/',
                ],
            },
            to: {},
        },
        {
            name: 'lib-no-import-app',
            severity: 'error',
            comment:
                'packages/backend/src/lib is the reusable kernel. Importing from the Next.js app ' +
                'layer (packages/frontend/src/app) inverts the layering and ' +
                'breaks the "lib is depended-on, never depends-on UI" invariant. Fully tight ' +
                'after #600 — runner.ts now imports getTemplate* directly from registry, ' +
                'mcp/server.ts calls runDiagnose() in src/lib/diagnose/, and the client hook ' +
                'useStackInstall moved out of src/lib to src/hooks/.',
            from: { path: '^packages/backend/src/lib/' },
            to: { path: '^packages/frontend/src/app/' },
        },
        {
            name: 'lib-no-import-components',
            severity: 'error',
            comment: 'Same reason as lib-no-import-app: kernel must not depend on the UI layer.',
            from: { path: '^packages/backend/src/lib/' },
            to: { path: '^packages/frontend/src/components/' },
        },
        {
            name: 'lib-no-import-dashboards',
            severity: 'error',
            comment: 'Kernel must not depend on dashboard components.',
            from: { path: '^packages/backend/src/lib/' },
            to: { path: '^packages/frontend/src/dashboards/' },
        },
        {
            name: 'service-manager-single-mutation-path',
            severity: 'error',
            comment:
                'ARCH audit: every deploy / delete / start / stop / restart / update-yaml call must ' +
                'funnel through ServiceManager. Direct imports of the split modules ' +
                '(serviceLifecycle / serviceListing) from outside src/lib/services bypass the ' +
                'facade and re-introduce the multi-path-mutation bug #589 cleaned up.',
            from: { pathNot: '^packages/backend/src/lib/services/' },
            to: {
                path: '^packages/backend/src/lib/services/(serviceLifecycle|serviceListing)(\\.ts)?$',
            },
        },
        {
            name: 'one-renderer',
            severity: 'error',
            comment:
                'ARCH audit: all Mustache rendering must pass through src/lib/template/render.ts ' +
                '(#599, #1066). Direct `import mustache` from anywhere else is blocked so deploy ' +
                'and preview cannot drift on escape semantics.',
            from: {
                path: '^packages/backend/src/lib/',
                pathNot: [
                    '^packages/backend/src/lib/template/render\\.ts$',
                ],
            },
            to: { path: '^node_modules/mustache(/|$)' },
        },
        {
            name: 'no-test-from-prod',
            severity: 'error',
            comment: 'Production code must not import test files.',
            from: { pathNot: '\\.test\\.(ts|tsx)$' },
            to: { path: '\\.test\\.(ts|tsx)$' },
        },
        {
            name: 'no-deprecated-core',
            severity: 'warn',
            comment: 'Avoid deprecated Node core APIs.',
            from: {},
            to: { dependencyTypes: ['deprecated'] },
        },
    ],
    options: {
        doNotFollow: {
            path: 'node_modules',
        },
        tsPreCompilationDeps: true,
        tsConfig: {
            fileName: 'tsconfig.json',
        },
        enhancedResolveOptions: {
            exportsFields: ['exports'],
            conditionNames: ['import', 'require', 'node', 'default', 'types'],
            mainFields: ['module', 'main', 'types', 'typings'],
        },
        reporterOptions: {
            text: { highlightFocused: true },
            archi: {
                collapsePattern:
                    '^(node_modules|src/lib|src/app|src/components|src/dashboards|src/hooks|src/providers|src/content|src/types)/[^/]+',
            },
        },
    },
};
