/**
 * Contract lint for templates' post-deploy.py scripts (#584).
 *
 * Bundled templates POST to ServiceBay-internal HTTP endpoints to
 * surface credentials, seed users, register OIDC clients, etc. The
 * exact endpoint paths are implicit — there is no versioned schema,
 * no typed module, just literal strings inside Python files. A refactor
 * that renames `/api/system/lldap/seed` would silently break
 * `templates/auth/post-deploy.py` on the next deploy, with no test
 * catching it before the wizard runs.
 *
 * This test locks down the *current* shape so that drift is caught at
 * PR time. It is the smallest first step of ARCH-03 from the audit;
 * the full proposal (typed contract module + `servicebay.template-api-
 * version` annotation) is deferred until a second template starts
 * duplicating the same endpoint surface.
 *
 * Scope:
 *   - scan every `templates/<name>/post-deploy.py` for URL literals
 *     anchored to `{sb_api}` or `{SB_API_URL}` (the env-injected
 *     internal base URL — see docs/TEMPLATE_AUTHORING.md § Environment
 *     available to the script)
 *   - extract the literal path (giving up at any `{var}` segment past
 *     the host placeholder, since those are runtime-substituted)
 *   - resolve each path against `packages/frontend/src/app/api/<path>/route.ts`,
 *     allowing `[param]` segments to match any literal
 *   - fail if any post-deploy script references an endpoint that
 *     doesn't exist
 *
 * Out of scope (covered by other tests or deferred):
 *   - request/response body shape — the typed contract module from
 *     the ticket's full proposal
 *   - external-service URLs (Authelia OIDC, Ollama, Audiobookshelf
 *     admin API) — those are the upstream service's contract, not
 *     ServiceBay's
 *   - HTTP method (POST vs GET) — same; deferred until needed
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');
const API_ROOT = path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app', 'api');

interface EndpointRef {
  template: string;
  file: string;
  line: number;
  rawUrl: string;
  path: string;
}

/**
 * Extract literal endpoint paths from one post-deploy.py. We match
 * f-string fragments anchored to either `{sb_api}` or `{SB_API_URL}`
 * (the two name shapes the scripts use). The captured group is the
 * URL suffix; we then trim at the first `{var}` so any further runtime
 * substitution is treated as "rest of path is dynamic and we can't
 * verify the segments past here".
 */
function extractEndpoints(scriptPath: string, template: string): EndpointRef[] {
  const text = fs.readFileSync(scriptPath, 'utf-8');
  const lines = text.split('\n');
  const re = /\{(?:sb_api|SB_API_URL)\}(\/api\/[A-Za-z0-9/_\-.{}]*)/g;
  const out: EndpointRef[] = [];

  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      const raw = m[1];
      // Trim at the first {var} placeholder past the API base — segments
      // after it are dynamic and we don't try to resolve them.
      const literal = raw.replace(/\{[^}]+\}.*$/, '');
      // Strip trailing slashes for matching, but keep leading.
      const cleaned = literal.replace(/\/+$/, '') || literal;
      out.push({
        template,
        file: path.relative(REPO_ROOT, scriptPath),
        line: i + 1,
        rawUrl: m[0],
        path: cleaned,
      });
    }
  }
  return out;
}

/**
 * Resolve `/api/foo/bar` to an existing `packages/frontend/src/app/api/foo/bar/route.ts`,
 * allowing `[param]` directory segments to act as wildcards (the way
 * Next.js does at runtime). Returns the resolved path on success, null
 * on miss.
 */
function resolveRoute(apiPath: string): string | null {
  // apiPath always begins with `/api/`; strip the leading `/api/`.
  const segments = apiPath.replace(/^\/api\//, '').split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Walk the api directory tree segment by segment, allowing `[name]`
  // entries to match anything.
  function walk(curDir: string, remaining: string[]): string | null {
    if (remaining.length === 0) {
      const routeFile = path.join(curDir, 'route.ts');
      return fs.existsSync(routeFile) ? routeFile : null;
    }
    const [head, ...tail] = remaining;
    if (!fs.existsSync(curDir)) return null;
    const entries = fs.readdirSync(curDir, { withFileTypes: true });
    const candidates = entries
      .filter(e => e.isDirectory())
      .filter(e => e.name === head || /^\[.+\]$/.test(e.name));
    for (const cand of candidates) {
      const hit = walk(path.join(curDir, cand.name), tail);
      if (hit) return hit;
    }
    return null;
  }
  return walk(API_ROOT, segments);
}

function listTemplatesWithPostDeploy(): { name: string; scriptPath: string }[] {
  return fs.readdirSync(TEMPLATES_DIR)
    .filter(name => {
      const full = path.join(TEMPLATES_DIR, name);
      return fs.statSync(full).isDirectory();
    })
    .map(name => ({
      name,
      scriptPath: path.join(TEMPLATES_DIR, name, 'post-deploy.py'),
    }))
    .filter(t => fs.existsSync(t.scriptPath));
}

describe('template post-deploy.py → ServiceBay API contract (#584)', () => {
  const templates = listTemplatesWithPostDeploy();

  it('every {sb_api}/api/... reference in post-deploy.py resolves to a real Next.js route', () => {
    const offenders: string[] = [];
    let total = 0;

    for (const t of templates) {
      const refs = extractEndpoints(t.scriptPath, t.name);
      for (const ref of refs) {
        total++;
        const resolved = resolveRoute(ref.path);
        if (!resolved) {
          offenders.push(
            `${ref.file}:${ref.line} → ${ref.path} ` +
            `(from ${ref.rawUrl}) — no matching route under packages/frontend/src/app/api/`,
          );
        }
      }
    }

    // Sanity: if extraction silently breaks, the test would always pass
    // because there's nothing to check. Fail loudly if we scanned every
    // bundled template's script and found zero refs.
    expect(
      total,
      'Extracted zero {sb_api}/api/... references — the regex probably regressed. ' +
      'Expected at least one per templates with post-deploy.py (auth, hermes, file-share, …).',
    ).toBeGreaterThan(0);

    expect(
      offenders,
      `${offenders.length} post-deploy.py reference(s) point at endpoints that don't exist:\n  ${offenders.join('\n  ')}\n\n` +
      `Either restore the endpoint, update the post-deploy.py script, or move the call to a different path that exists. ` +
      `The full ARCH-03 fix (typed contract module + servicebay.template-api-version annotation) is the medium-term plan; ` +
      `this test is the short-term tripwire that catches accidental endpoint renames.`,
    ).toEqual([]);
  });
});

/**
 * #3048 — Jellyfin's client-identification header.
 *
 * Jellyfin 12 reads the identifier only from `Authorization`; it ignores
 * the legacy `X-Emby-Authorization`, so a request carrying only the `X-`
 * spelling arrives with no client identity and the server answers 400
 * from `AuthenticateNewSessionInternal` before any auth provider runs.
 *
 * That cost every media deploy its admin token the moment
 * `jellyfin:latest` crossed 10.x -> 12.x, which silently skipped the LDAP
 * plugin-binary install, Quick Connect and library auto-add, and wrote
 * `<EnabledFolders></EnabledFolders>` empty — so LDAP users auto-created
 * on first login got no libraries at all.
 *
 * This is an upstream service's contract rather than ServiceBay's, which
 * is why the header is pinned here by lint instead of by a live call.
 */
describe('Jellyfin auth header in post-deploy scripts (#3048)', () => {
  const mediaPostDeploy = path.join(TEMPLATES_DIR, 'media', 'post-deploy.py');

  it('exists, so the assertions below are not vacuous', () => {
    expect(fs.existsSync(mediaPostDeploy)).toBe(true);
  });

  it('sends the identifier on Authorization and nowhere else', () => {
    const src = fs.readFileSync(mediaPostDeploy, 'utf-8');
    const legacy = src.match(/["']X-Emby-Authorization["']\s*:/g) ?? [];
    expect(legacy).toEqual([]);
    expect(src).toMatch(/["']Authorization["']\s*:\s*f?['"]?\{?JELLYFIN_AUTH_HEADER/);
  });

  it('pairs every JELLYFIN_AUTH_HEADER call site with an Authorization key', () => {
    const src = fs.readFileSync(mediaPostDeploy, 'utf-8');
    // Line-wise rather than count-wise: a bare interpolation would be a
    // header nobody sends, but comments and the constant's own definition
    // legitimately name it too.
    const unkeyed = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes('JELLYFIN_AUTH_HEADER'))
      .filter(({ line }) => !/^\s*#/.test(line))
      .filter(({ line }) => !/^JELLYFIN_AUTH_HEADER\s*=/.test(line))
      .filter(({ line }) => !/["']Authorization["']\s*:/.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`);
    expect(unkeyed, 'JELLYFIN_AUTH_HEADER used without an Authorization key').toEqual([]);
  });

  it('keeps no other template on the legacy header either', () => {
    for (const name of fs.readdirSync(TEMPLATES_DIR)) {
      const f = path.join(TEMPLATES_DIR, name, 'post-deploy.py');
      if (!fs.existsSync(f)) continue;
      expect(
        fs.readFileSync(f, 'utf-8'),
        `${name}/post-deploy.py still sends X-Emby-Authorization (#3048)`,
      ).not.toMatch(/["']X-Emby-Authorization["']\s*:/);
    }
  });
});
