/**
 * CLASS GATE A (#2941) — the response a route actually emits must match the
 * client helper that reads it.
 *
 * `withApiHandler` wraps a handler's return in `{ ok: true, data }` ONLY when
 * the handler returns a plain value; `runHandler` does
 * `if (result instanceof Response) return result;`, so a route that shapes its
 * own `NextResponse.json(...)` never produces an envelope. `callApi`/`mutateApi`
 * assert `z.object({ ok: z.literal(true), data: schema })` and throw
 * `TypedFetchError('… response failed schema validation')` when it is absent —
 * so a hand-shaped route read through `mutateApi` reports FAILURE on a delete
 * that podman actually performed. `rawApi`/`mutateRawApi` are the siblings for
 * exactly that case.
 *
 * Why this is a CLASS gate: commit 642308d2 fixed this very shape for
 * backup.ts / settings.ts, per call site, and the defect came straight back in
 * the action hooks. So this test does not know about "the four call sites". It
 *
 *   1. ENUMERATES every route.ts under packages/frontend/src/app/api and
 *      classifies each exported method by what it returns on its SUCCESS paths;
 *   2. ENUMERATES every `callApi`/`mutateApi`/`rawApi`/`mutateRawApi`/
 *      `typedFetch` call in the client packages and resolves its URL + verb back
 *      to one of those routes;
 *   3. asserts the two agree, in BOTH directions.
 *
 * A route added tomorrow, or a call site moved to a new file, is covered with no
 * edit here. The `denominator` test below is the guard against the gate quietly
 * matching nothing and passing green — the house failure form.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app');
const API_ROOT = path.join(APP_ROOT, 'api');
const CLIENT_ROOTS = [
  path.join(REPO_ROOT, 'packages', 'frontend', 'src'),
  path.join(REPO_ROOT, 'packages', 'api-client', 'src'),
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Which envelope each helper asserts. */
const HELPERS = {
  callApi: { envelope: true, defaultMethod: 'GET' },
  mutateApi: { envelope: true, defaultMethod: 'POST' },
  rawApi: { envelope: false, defaultMethod: 'GET' },
  mutateRawApi: { envelope: false, defaultMethod: 'POST' },
  // `typedFetch` validates the body directly, exactly like rawApi.
  typedFetch: { envelope: false, defaultMethod: 'GET' },
} as const satisfies Record<string, { envelope: boolean; defaultMethod: HttpMethod }>;
type HelperName = keyof typeof HELPERS;

// ---------------------------------------------------------------------------
// 1. Enumerate the routes and classify their success shape
// ---------------------------------------------------------------------------

const fileCache = new Map<string, string>();
function readSource(file: string): string {
  let cached = fileCache.get(file);
  if (cached === undefined) {
    cached = fs.readFileSync(file, 'utf-8');
    fileCache.set(file, cached);
  }
  return cached;
}

/**
 * Language keywords and framework nouns are never a delegated handler; skipping
 * them keeps the resolution walk from re-scanning every file for `const`.
 */
const NOT_A_HANDLER = new Set([
  'const', 'let', 'var', 'async', 'await', 'return', 'if', 'else', 'try', 'catch', 'finally',
  'new', 'typeof', 'instanceof', 'true', 'false', 'null', 'undefined', 'this', 'void',
  'for', 'of', 'in', 'while', 'switch', 'case', 'break', 'continue', 'default', 'throw',
  'function', 'class', 'export', 'import', 'from', 'as', 'type', 'interface', 'satisfies',
  'string', 'number', 'boolean', 'unknown', 'any', 'Promise', 'Response', 'NextResponse',
  'z', 'request', 'params', 'query', 'body', 'auth', 'json', 'status', 'data', 'error',
]);

function* walk(dir: string, matches: (name: string) => boolean): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* walk(full, matches);
    } else if (entry.isFile() && matches(entry.name)) {
      yield full;
    }
  }
}

/** src/app/api/foo/[id]/bar/route.ts → /api/foo/[id]/bar */
function fileToApiPath(file: string): string {
  return '/' + path.relative(APP_ROOT, file).replace(/\/route\.ts$/, '');
}

/** Text of the balanced `(...)` that starts at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * The source of one exported handler: from its `export` keyword to the next
 * top-level `export`, or EOF. Handlers are one export each, so this is the
 * handler and nothing else.
 */
function methodBlock(src: string, method: HttpMethod): string | null {
  const re = new RegExp(`^export\\s+(?:async\\s+function\\s+${method}\\b|const\\s+${method}\\s*[=:])`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const next = /^export\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * Every top-level declaration in a file, name → source of that declaration
 * (down to the next top-level declaration). Built once per file: the resolution
 * walk below asks for many names per file, and a regex per name over a big
 * module is the difference between a fast gate and a slow one.
 */
const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\*?|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm;

const declCache = new Map<string, Map<string, string>>();
function declarations(file: string, src: string): Map<string, string> {
  let cached = declCache.get(file);
  if (cached) return cached;
  const starts: { name: string; index: number }[] = [];
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(src)) !== null) starts.push({ name: m[1], index: m.index });
  cached = new Map();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
    if (!cached!.has(start.name)) cached!.set(start.name, src.slice(start.index, end));
  });
  declCache.set(file, cached);
  return cached;
}

/** local name → module specifier, for the file's ES imports. */
function importMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) map.set(name, m[2]);
    }
  }
  return map;
}

const MODULE_ALIASES: [RegExp, string][] = [
  [/^@\/lib\//, path.join(REPO_ROOT, 'packages/backend/src/lib/')],
  [/^@\/components\//, path.join(REPO_ROOT, 'packages/frontend/src/components/')],
  [/^@\//, path.join(REPO_ROOT, 'packages/frontend/src/')],
];

function resolveModule(spec: string, fromFile: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else {
    for (const [re, target] of MODULE_ALIASES) {
      if (re.test(spec)) { base = spec.replace(re, target); break; }
    }
  }
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IDENTIFIER = /\b[A-Za-z_$][\w$]*\b/g;

/**
 * Modules that are the API FRAMEWORK, not a route's handler. `withApiHandler`
 * itself ends in `return NextResponse.json({ ok: true, data: result })`, so
 * following into it would classify literally every route as hand-shaped and the
 * gate would be pure noise. Same for the shared error helpers.
 */
const FRAMEWORK_MODULES = new Set([
  '@/lib/api/handler',
  '@/lib/api/errors',
  '@/lib/api/requireSession',
  'next/server',
  'zod',
]);

/**
 * The handler source a route method really executes: its own block plus, one
 * import hop deep, the bodies of the named handlers it delegates to. Without
 * this the classifier reads `export const GET = withApiHandler({}, getTokensHandler)`
 * as "returns a plain value" and the gate goes blind on every route that names
 * its handler instead of inlining it.
 */
function resolvedHandlerSource(file: string, src: string, method: HttpMethod): string | null {
  const root = methodBlock(src, method);
  if (root === null) return null;

  let combined = root;
  const seen = new Set<string>([`${file}#${method}`]);
  let frontier: { file: string; src: string; block: string }[] = [{ file, src, block: root }];

  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const nextFrontier: { file: string; src: string; block: string }[] = [];
    for (const node of frontier) {
      const imports = importMap(node.src);
      const names = new Set((node.block.match(IDENTIFIER) ?? []).filter((n) => !NOT_A_HANDLER.has(n)));
      for (const name of names) {
        const local = declarations(node.file, node.src).get(name);
        if (local !== undefined && !seen.has(`${node.file}#${name}`)) {
          seen.add(`${node.file}#${name}`);
          combined += `\n${local}`;
          nextFrontier.push({ file: node.file, src: node.src, block: local });
          continue;
        }
        const spec = imports.get(name);
        if (!spec || FRAMEWORK_MODULES.has(spec)) continue;
        const target = resolveModule(spec, node.file);
        if (!target || seen.has(`${target}#${name}`)) continue;
        seen.add(`${target}#${name}`);
        const targetSrc = readSource(target);
        const decl = declarations(target, targetSrc).get(name);
        if (decl === undefined) continue;
        combined += `\n${decl}`;
        nextFrontier.push({ file: target, src: targetSrc, block: decl });
      }
    }
    frontier = nextFrontier;
  }
  return combined;
}

const SUCCESS_STATUS = /status\s*:\s*(\d{3})/;

/**
 * True when the handler returns a Response it shaped itself on at least one
 * SUCCESS path — which is exactly when `withApiHandler` does NOT envelope.
 * A `NextResponse.json(..., { status: 4xx/5xx })` is an error path and does not
 * count; a non-literal status is treated as an error path too (conservative:
 * we only claim "hand-shaped" when we can see it).
 */
function returnsHandShapedSuccess(block: string): boolean {
  const re = /return\s+(?:NextResponse\.json|Response\.json|new\s+NextResponse|new\s+Response)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const args = balanced(block, m.index + m[0].length - 1);
    const status = SUCCESS_STATUS.exec(args);
    if (!status) return true;
    if (status[1].startsWith('2')) return true;
    // 4xx/5xx → an error path; keep looking for a success path.
  }
  return false;
}

interface RouteMethod {
  apiPath: string;
  method: HttpMethod;
  file: string;
  /** true = client must use callApi/mutateApi; false = rawApi/mutateRawApi/typedFetch */
  enveloped: boolean;
}

function collectRoutes(): RouteMethod[] {
  const out: RouteMethod[] = [];
  for (const file of walk(API_ROOT, (n) => n === 'route.ts')) {
    const src = readSource(file);
    const apiPath = fileToApiPath(file);
    for (const method of HTTP_METHODS) {
      const block = resolvedHandlerSource(file, src, method);
      if (block === null) continue;
      out.push({ apiPath, method, file, enveloped: !returnsHandShapedSuccess(block) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Enumerate the client call sites
// ---------------------------------------------------------------------------

interface CallSite {
  helper: HelperName;
  url: string;
  method: HttpMethod;
  file: string;
  line: number;
}

/** `/api/services/${x}/action?node=y` → `/api/services/[dyn]/action` */
function normalizeUrl(raw: string): string | null {
  const withoutQuery = raw.split('?')[0];
  // `/api/services/${name}` is a path segment; `/api/services/${name}/logs${query}`
  // ends in a query-string interpolation, which is not part of the path at all.
  const normalized = withoutQuery
    .replace(/(\/)\$\{[^{}]*\}/g, '$1[dyn]')
    .replace(/\$\{[^{}]*\}/g, '');
  if (!normalized.startsWith('/api/')) return null;
  if (normalized.includes('${')) return null; // nested interpolation — unresolvable
  return normalized.replace(/\/+$/, '');
}

const CALL_RE = new RegExp(
  `\\b(${Object.keys(HELPERS).join('|')})\\s*\\(\\s*(['"\`])((?:[^\\\\'"\`]|\\\\.)*?)\\2`,
  'g',
);

function collectCallSites(): { sites: CallSite[]; unresolved: number } {
  const sites: CallSite[] = [];
  let unresolved = 0;
  const seen = new Set<string>();

  for (const root of CLIENT_ROOTS) {
    for (const file of walk(root, (n) => /\.tsx?$/.test(n) && !/\.(test|spec)\.tsx?$/.test(n))) {
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = path.relative(REPO_ROOT, file);
      // Route handlers and the proxy are server code, not client call sites.
      if (rel.includes('/src/app/api/') || rel.includes('/src/app/napi/')) continue;
      const src = readSource(file);
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(src)) !== null) {
        const helper = m[1] as HelperName;
        const url = normalizeUrl(m[3]);
        if (url === null) { unresolved++; continue; }
        const args = balanced(src, src.indexOf('(', m.index));
        const verb = /['"](GET|POST|PUT|PATCH|DELETE)['"]/.exec(args);
        sites.push({
          helper,
          url,
          method: (verb ? verb[1] : HELPERS[helper].defaultMethod) as HttpMethod,
          file: rel,
          line: src.slice(0, m.index).split('\n').length,
        });
      }
    }
  }
  return { sites, unresolved };
}

// ---------------------------------------------------------------------------
// 3. Resolve + compare
// ---------------------------------------------------------------------------

/**
 * A client URL matches a route path when they have the same shape. Either side
 * may carry a placeholder: `[id]` in the route, `[dyn]` where the client
 * interpolated a value. `${decision}` in the client can legitimately be the
 * literal `approve` segment of a route, so a client placeholder matches
 * anything — the ambiguity that creates is resolved below, not papered over.
 */
function segmentsMatch(routePath: string, callPath: string): boolean {
  const r = routePath.split('/');
  const c = callPath.split('/');
  if (r.length !== c.length) return false;
  return r.every((seg, i) => /^\[.*\]$/.test(seg) || c[i] === '[dyn]' || seg === c[i]);
}

const ROUTES = collectRoutes();
const { sites: CALL_SITES, unresolved: UNRESOLVED } = collectCallSites();

interface Pair { site: CallSite; route: RouteMethod }

/**
 * Resolve one call site to the route method it hits.
 *
 * The verb can be invisible at the call site (`rawApi(url, schema, init)` with
 * the method inside `init`), and a URL can match more than one route (the
 * approve/reject pairs). So: prefer an exact verb match; otherwise fall back to
 * the path's routes *only when they all agree on the response shape*. When they
 * disagree the site is ambiguous and is skipped rather than asserted against a
 * guess — a guessed verdict would be worse than no verdict.
 */
function resolveSite(site: CallSite): { route: RouteMethod } | 'ambiguous' | 'unmatched' {
  const candidates = ROUTES.filter((r) => segmentsMatch(r.apiPath, site.url));
  if (candidates.length === 0) return 'unmatched';
  const exact = candidates.find((r) => r.method === site.method);
  if (exact) return { route: exact };
  const shapes = new Set(candidates.map((r) => r.enveloped));
  if (shapes.size === 1) return { route: candidates[0] };
  return 'ambiguous';
}

const PAIRS: Pair[] = [];
const UNMATCHED: CallSite[] = [];
const AMBIGUOUS: CallSite[] = [];
for (const site of CALL_SITES) {
  const resolved = resolveSite(site);
  if (resolved === 'unmatched') UNMATCHED.push(site);
  else if (resolved === 'ambiguous') AMBIGUOUS.push(site);
  else PAIRS.push({ site, route: resolved.route });
}

describe('CLASS GATE A — route response shape vs. the client that reads it (#2941)', () => {
  it('enumerates a meaningful number of routes and call sites (denominator guard)', () => {
    // Not a magic number contest: these floors only catch the failure mode
    // where a refactor breaks the walk/regex and the gate passes by matching
    // nothing — "Erfolg gemeldet, nichts getan", checked at the denominator.
    // Today: 217 route methods, 155 call sites, 155 of them resolved.
    expect(ROUTES.length, 'no route methods enumerated — the walk is broken').toBeGreaterThan(150);
    expect(CALL_SITES.length, 'no client call sites enumerated — the regex is broken').toBeGreaterThan(120);
    expect(PAIRS.length, 'no call site resolved to a route — URL matching is broken').toBeGreaterThan(120);
  });

  it('no hand-shaped route is read through the withApiHandler envelope', () => {
    const offenders = PAIRS
      .filter(({ site, route }) => !route.enveloped && HELPERS[site.helper].envelope)
      .map(({ site, route }) =>
        `${site.file}:${site.line} uses ${site.helper}() on ${site.method} ${route.apiPath}, ` +
        `but ${path.relative(REPO_ROOT, route.file)} shapes its own Response (no { ok, data })`);

    expect(
      offenders,
      `${offenders.length} call site(s) assert the withApiHandler envelope against a route that never emits one.\n` +
      `Every one of these reports FAILURE on an action that succeeded. Use rawApi/mutateRawApi ` +
      `(or make the route return a plain value so withApiHandler envelopes it).\n\n` +
      offenders.join('\n'),
    ).toEqual([]);
  });

  it('no enveloped route is read as a raw body', () => {
    const offenders = PAIRS
      .filter(({ site, route }) => route.enveloped && !HELPERS[site.helper].envelope)
      .map(({ site, route }) =>
        `${site.file}:${site.line} uses ${site.helper}() on ${site.method} ${route.apiPath}, ` +
        `but ${path.relative(REPO_ROOT, route.file)} returns a plain value that withApiHandler wraps in { ok, data }`);

    expect(
      offenders,
      `${offenders.length} call site(s) read a { ok, data } envelope as if it were the payload.\n` +
      `Use callApi/mutateApi so the envelope is unwrapped and the server's error message survives.\n\n` +
      offenders.join('\n'),
    ).toEqual([]);
  });

  it('every resolvable client URL points at a route that exists', () => {
    const offenders = UNMATCHED.map(
      (s) => `${s.file}:${s.line} → ${s.method} ${s.url} (no route.ts under app/api serves that path)`,
    );
    expect(
      offenders,
      `${offenders.length} typed client call(s) target a route that does not exist under ` +
      `packages/frontend/src/app/api. Either the URL is wrong or the gate can no longer see the route — ` +
      `both make the envelope check above blind.\n\n` + offenders.join('\n'),
    ).toEqual([]);
  });
});

// Exported only so a failure is easy to inspect from a console run.
export const __gateStats = { routes: ROUTES.length, callSites: CALL_SITES.length, pairs: PAIRS.length, ambiguous: AMBIGUOUS.length, unresolved: UNRESOLVED };
