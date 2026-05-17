/**
 * Enforcement test: every mutating /api/* route handler must either
 * call `requireSession()` directly or be wrapped in `withApiHandler`
 * (which calls it internally for POST/PATCH/PUT/DELETE) (#596).
 *
 * The exception list mirrors `src/proxy.ts:PUBLIC_API_RULES` — those
 * paths are intentionally public (login, OIDC initiator, family-portal
 * submission, etc.) and don't need the gate.
 *
 * Without this test, a new route with a POST handler can ship without
 * the gate and only get caught when something breaks `src/proxy.ts`'s
 * middleware regex. The route-level check is the defense-in-depth
 * layer the audit asked for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.join(REPO_ROOT, 'src', 'app', 'api');

// Mirror of PUBLIC_API_RULES in src/proxy.ts. Keep in sync.
interface PublicRule { prefix: string; methods?: ReadonlySet<string> }
const PUBLIC_RULES: PublicRule[] = [
  { prefix: '/api/auth/login' },
  { prefix: '/api/auth/oidc' },
  { prefix: '/api/auth/lldap-url' },
  { prefix: '/api/system/access-requests', methods: new Set(['POST']) },
  { prefix: '/api/portal/asset', methods: new Set(['GET']) },
];

function isPublic(apiPath: string, method: string): boolean {
  return PUBLIC_RULES.some(r =>
    (apiPath === r.prefix || apiPath.startsWith(r.prefix + '/')) &&
    (!r.methods || r.methods.has(method)),
  );
}

function* walkRoutes(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkRoutes(full);
    else if (entry.isFile() && entry.name === 'route.ts') yield full;
  }
}

const MUTATING = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

function fileToApiPath(file: string): string {
  // src/app/api/foo/[id]/bar/route.ts → /api/foo/[id]/bar
  const rel = path.relative(path.join(REPO_ROOT, 'src', 'app'), file);
  return '/' + rel.replace(/\/route\.ts$/, '');
}

describe('per-route session gate (#596)', () => {
  it('every mutating /api/* handler is gated or in the public allowlist', () => {
    const offenders: string[] = [];
    for (const file of walkRoutes(API_ROOT)) {
      const src = fs.readFileSync(file, 'utf-8');
      const apiPath = fileToApiPath(file);
      const usesGateDirectly = /requireSession\s*\(/.test(src);
      const usesWrapper = /withApiHandler\b/.test(src);
      for (const method of MUTATING) {
        const re = new RegExp(
          `export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\s*=`,
        );
        if (!re.test(src)) continue;
        if (isPublic(apiPath, method)) continue;
        if (usesGateDirectly) continue;
        if (usesWrapper) continue;
        offenders.push(`${path.relative(REPO_ROOT, file)} [${method}]`);
      }
    }

    expect(
      offenders,
      `${offenders.length} mutating route handler(s) lack requireSession + are not in the public allowlist + don't use withApiHandler.\n` +
      `Add \`const auth = await requireSession(request); if (auth instanceof NextResponse) return auth;\` ` +
      `as the first line of each handler, or use withApiHandler. See #596.\n\n` +
      `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
