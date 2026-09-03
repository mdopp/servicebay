import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Session lock-in for the routes that replaced `app/actions/*` (#2745).
 *
 * This is the carried-forward `app/actions/_session.test.ts`. Server Actions
 * are routed on page paths, so the `/api/*`-only auth gate in `proxy.ts` did
 * not cover them and every sensitive action had to call `assertAdminSession()`
 * itself (#1203) — a guard that was easy to forget on a new action. Route
 * handlers get the gate structurally: `proxy.ts` requires a session cookie for
 * `/api/*`, and `withApiHandler` runs `requireSession` again on every mutating
 * verb unless the route explicitly opts out with `skipAuth`.
 *
 * So the invariant worth pinning is the opt-out: NONE of these routes may set
 * `skipAuth` (nor `tokenScope`, which would open them to a scoped Bearer). We
 * read it out of the FIRST argument to `withApiHandler` — the options object
 * handler.ts's gate actually reads — rather than grepping the whole file,
 * which would also match a comment (the #2249 lesson from scopeGuards.test.ts).
 *
 * The gate machinery itself is proven in `lib/api/requireSession.test.ts`.
 */
const SYSTEM_API_DIR = __dirname;

/**
 * The options object that is the FIRST arg to withApiHandler(Params).
 *
 * `[^(]*` swallows any explicit type arguments — including nested ones like
 * `<undefined, z.infer<typeof Query>>`, which a naive `<[^>]*>` stops short of
 * and then silently reports "no handler found" (a green-looking false pass).
 */
function handlerOptions(relPath: string): string[] {
  const src = readFileSync(path.join(SYSTEM_API_DIR, relPath), 'utf8');
  const matches = src.matchAll(/withApiHandler(?:Params)?[^(]*\(\s*(\{[^}]*\})/g);
  return [...matches].map(m => m[1]);
}

/** Every route that took over a server action from `app/actions/`. */
const ROUTES = [
  'nodes/route.ts',
  'nodes/[name]/route.ts',
  'nodes/[name]/default/route.ts',
  'ssh/check/route.ts',
  'ssh/verify/route.ts',
  'ssh/install-key/route.ts',
  'ssh/key/route.ts',
  'os-updates/route.ts',
  'onboarding/route.ts',
  'onboarding/config/route.ts',
  'onboarding/complete/route.ts',
  'onboarding/install-lock/route.ts',
];

describe('routes that replaced app/actions/* keep the session gate (#2745)', () => {
  for (const route of ROUTES) {
    it(`${route} — every handler is wrapped and none opts out of the gate`, () => {
      const options = handlerOptions(route);
      expect(options.length).toBeGreaterThan(0);
      for (const opts of options) {
        expect(opts).not.toMatch(/skipAuth/);
        expect(opts).not.toMatch(/tokenScope/);
      }
    });
  }
});
