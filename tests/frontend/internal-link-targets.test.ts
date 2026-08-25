/**
 * Internal-link integrity guard (#2625).
 *
 * Symptom the issue reported: `CoreHealthBanner` ("Self-diagnose") and
 * `DashboardHydrationGate` ("Diagnose") both link to `/diagnose`, which has no
 * page under `app/(dashboard)/` — only the API route `/api/system/diagnose`.
 * Both links render exactly when the operator most needs a recovery path (core
 * stack unhealthy / hydration stalled past 25 s), and both 404'd.
 *
 * The class of bug is "a hard-coded in-app href outlived the route it pointed
 * at" — an IA move (Diagnostics folded into Status, #2030) leaves the link
 * behind and nothing fails. So this test does not hard-code the two known
 * links: it scans every frontend source for literal in-app link targets and
 * resolves each against the real App Router route set plus `next.config.ts`'s
 * redirects. A new dead link fails here instead of in the operator's browser.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import nextConfig from '../../packages/frontend/next.config';

const FRONTEND = path.resolve(__dirname, '../../packages/frontend');
const APP_DIR = path.join(FRONTEND, 'src', 'app');

/** Every source file the frontend ships (tests excluded). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Route patterns served by the App Router: one per `page.tsx`, with the
 * route-group dirs `(name)` dropped and `[param]` kept as a wildcard segment.
 */
function routePatterns(): string[][] {
  const patterns: string[][] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `(group)` dirs organise files, not URLs.
        const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        walk(full, isGroup ? segments : [...segments, entry.name]);
      } else if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
        patterns.push(segments);
      }
    }
  };
  walk(APP_DIR, []);
  return patterns;
}

/** `{ '/settings': '/settings/network-domain', … }` from next.config.ts. */
async function redirectMap(): Promise<Map<string, string>> {
  const redirects = (await nextConfig.redirects?.()) ?? [];
  return new Map(redirects.map(r => [r.source, r.destination]));
}

function matchesRoute(pathname: string, patterns: string[][]): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return patterns.some(
    pattern =>
      pattern.length === segments.length &&
      pattern.every((seg, i) => (seg.startsWith('[') ? true : seg === segments[i])),
  );
}

/**
 * Literal in-app link targets: `href="/x"`, `router.push('/x')`,
 * `router.replace('/x')`, `redirect('/x')`. Anything interpolated (`${…}`) is
 * skipped — only a literal can be checked statically.
 */
function linkTargets(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /href=["'](\/[^"'{}]*)["']/g,
    /(?:router\.(?:push|replace)|redirect)\(\s*["'](\/[^"'{}]*)["']/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) out.push(match[1]);
  }
  return out;
}

/** API surfaces + framework paths are not App Router pages. */
const NON_PAGE_PREFIXES = ['/api/', '/napi/', '/_next/'];

describe('internal link targets resolve to a real route (#2625)', () => {
  it('every literal in-app href/push/redirect lands on a page or a configured redirect', async () => {
    const patterns = routePatterns();
    const redirects = await redirectMap();
    // Sanity: the scan found the routes at all, so an empty set can never make
    // this test vacuously green.
    expect(patterns.length).toBeGreaterThan(10);

    const dead: string[] = [];
    for (const file of sourceFiles(path.join(FRONTEND, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const target of linkTargets(source)) {
        if (NON_PAGE_PREFIXES.some(p => target.startsWith(p))) continue;
        // Strip the query and the hash — neither selects the route.
        const pathname = target.split('?')[0].split('#')[0] || '/';
        // Follow the configured redirects (bounded; the config has no chains).
        let resolved = pathname;
        for (let hop = 0; hop < 5 && redirects.has(resolved); hop++) {
          resolved = redirects.get(resolved)!.split('?')[0].split('#')[0];
        }
        if (!matchesRoute(resolved, patterns)) {
          dead.push(`${path.relative(FRONTEND, file)} → ${target}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('/diagnose resolves to the Status screen that renders the diagnose probes', async () => {
    const redirects = await redirectMap();
    expect(redirects.get('/diagnose')).toBe('/status');
    expect(existsSync(path.join(APP_DIR, '(dashboard)', 'status', 'page.tsx'))).toBe(true);
  });

  it('the two error surfaces still offer the diagnose recovery link', () => {
    const banner = readFileSync(path.join(FRONTEND, 'src/components/CoreHealthBanner.tsx'), 'utf8');
    const gate = readFileSync(path.join(FRONTEND, 'src/components/DashboardHydrationGate.tsx'), 'utf8');
    expect(banner).toMatch(/href="\/(diagnose|status)"/);
    expect(gate).toMatch(/href="\/(diagnose|status)"/);
  });
});
