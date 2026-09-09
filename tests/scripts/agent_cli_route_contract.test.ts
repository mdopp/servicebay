/**
 * The agent CLI's verb table against the REAL routes (#2907, slice 2 of #2903).
 *
 * `tests/scripts/agent_cli.test.ts` (slice 1) drives every verb against a *fake*
 * ServiceBay, so it proves the CLI's own behaviour — and nothing at all about
 * whether the routes it names still exist. That is precisely the failure mode
 * the epic is about: `templates/claude-dev/config-ui/server.mjs` and solarisbay's
 * `pi-web-project` both hand-rebuild these routes and rot in silence.
 *
 * So this file checks the **class**, not a hand-picked list. It iterates
 * `VERBS` — every entry, no allow-list — and for each one asserts against the
 * checkout:
 *
 *   1. the path the verb builds resolves to a real `route.ts` under
 *      `packages/frontend/src/app/api/` (dynamic `[segment]` dirs included);
 *   2. that module really exports the verb's HTTP method;
 *   3. the handler carries the auth shape the verb declares — either the
 *      `tokenScope` the verb names (a route that drops it makes an otherwise
 *      valid `sb_` token 401, #2899) or, for a `parent-token` verb, the
 *      `skipAuth: true` mount AND no `tokenScope` at all (#2910: the delegate
 *      route's credential is the presented token itself, so a `tokenScope`
 *      appearing there would gate a route that must not be gated);
 *   4. every field in the verb's `reads` is really produced by that handler's
 *      success response.
 *
 * A NEW verb is covered the moment it is added to the table. A renamed or
 * deleted route fails and names verb + route. A response field the CLI reads
 * that the route stopped returning fails and names verb + field.
 *
 * ## How (4) works, and why it is not a grep
 *
 * The route sources are parsed with the TypeScript **parser** (no Program, no
 * type checker — this has to stay fast enough for `npm test`) and the response
 * expression of each success `NextResponse.json(...)` is resolved back to the
 * object literals that build it: through local consts, `.map()` callbacks,
 * array spreads, local helpers, and — via one import hop at a time — into the
 * lib function or class member that actually produces the payload. So
 * `GET /api/services/[name]`'s fields come from `ServiceListing.getServiceFiles`
 * where they are really written, not from a string that happens to appear in
 * the route file.
 *
 * The resolver degrades to **fewer** fields, never to more: an expression it
 * cannot follow contributes nothing, which turns into a red naming the field.
 * That is the safe direction — a resolver that quietly stopped working would
 * fail the suite rather than pass it, which is the substitution #2701 was.
 *
 * A route may also name its handler instead of inlining it —
 * `withApiHandler({ skipAuth: true }, delegateTokenHandler)`. That identifier is
 * followed through the import to the function that really answers, so the
 * fields come from where they are written there too; a handler this resolver
 * cannot follow contributes no fields, which is again the safe direction.
 *
 * The `describe('the check itself')` block at the bottom is the negative
 * control: four synthetic verbs — bad path, wrong method, invented field,
 * wrong auth shape — proving each acceptance criterion actually goes red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'agent-cli', 'servicebay.mjs');
const API_ROOT = path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app', 'api');

type Verb = {
  usage: string;
  /** Absent = the ServiceBay scope gate; `'parent-token'` = the delegate pair. */
  auth?: string;
  scope: string | null;
  method: string;
  positionals: string[];
  options: string[];
  path: (args: Record<string, string>, opts: Record<string, string>) => string;
  reads: string[];
};

const { VERBS } = (await import(CLI_PATH)) as { VERBS: Record<string, Verb> };

/* ------------------------------------------------------------------ *
 * 1. path → route file
 * ------------------------------------------------------------------ */

/**
 * Resolve a concrete pathname the way Next.js's app router does: a literal
 * directory wins, then a `[segment]`, then a `[...catchAll]`.
 */
function resolveRouteFile(pathname: string): string | null {
  const segments = pathname.split('?')[0].split('/').filter(Boolean);
  if (segments[0] !== 'api') return null;

  let dir = API_ROOT;
  for (const segment of segments.slice(1)) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    const literal = entries.find(e => e === decodeURIComponent(segment));
    const dynamic = entries.find(e => /^\[[^.].*\]$/.test(e));
    const catchAll = entries.find(e => /^\[\.\.\..*\]$/.test(e));
    const next = literal ?? dynamic ?? catchAll;
    if (!next) return null;
    dir = path.join(dir, next);
  }
  const file = path.join(dir, 'route.ts');
  return fs.existsSync(file) ? file : null;
}

/* ------------------------------------------------------------------ *
 * 2. parsing + module resolution
 * ------------------------------------------------------------------ */

const sourceCache = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = sourceCache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    sourceCache.set(file, sf);
  }
  return sf;
}

/** The `@/…` aliases from packages/frontend/tsconfig.json, longest prefix first. */
const ALIASES: [string, string][] = [
  ['@/lib/', path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib') + '/'],
  ['@/app/', path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app') + '/'],
  ['@/components/', path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'components') + '/'],
  ['@/', path.join(REPO_ROOT, 'packages', 'frontend', 'src') + '/'],
];

/** Module specifier → file on disk, or null for anything outside the checkout. */
function resolveModule(specifier: string, fromFile: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    for (const [prefix, target] of ALIASES) {
      if (specifier.startsWith(prefix)) {
        base = path.join(target, specifier.slice(prefix.length));
        break;
      }
    }
  }
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Local name → `{ file, exportedName }` for every named/default import. */
function importsOf(sf: ts.SourceFile): Map<string, { file: string; exported: string }> {
  const map = new Map<string, { file: string; exported: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const file = resolveModule(stmt.moduleSpecifier.text, sf.fileName);
    if (!file || !stmt.importClause) continue;
    const bindings = stmt.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        map.set(el.name.text, { file, exported: (el.propertyName ?? el.name).text });
      }
    }
    if (stmt.importClause.name) map.set(stmt.importClause.name.text, { file, exported: 'default' });
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * 3. the exported handler for a method
 * ------------------------------------------------------------------ */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function isExported(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}

/** Every HTTP method this route module exports. */
function exportedMethods(sf: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt) && HTTP_METHODS.includes(stmt.name.text)) {
      found.push(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && HTTP_METHODS.includes(decl.name.text)) found.push(decl.name.text);
      }
    }
  }
  return found;
}

/** `file` is where `fn` LIVES — not necessarily the route module (see below). */
type Handler = { fn: ts.FunctionLikeDeclaration; options: ts.ObjectLiteralExpression | null; file: string };

/**
 * A handler named rather than inlined — `withApiHandler({…}, delegateTokenHandler)`
 * — followed to the function that really answers, one import hop at a time.
 * Returns the file it was found in so its own module is the resolution context
 * for the response fields, not the route file that merely mounts it.
 */
function namedHandler(name: string, sf: ts.SourceFile, depth = 0): { fn: ts.FunctionLikeDeclaration; file: string } | null {
  if (depth > 4) return null;
  const ctx = ctxFor(sf.fileName);
  const imported = ctx.imports.get(name);
  if (imported) return namedHandler(imported.exported, parse(imported.file), depth + 1);
  for (const decl of ctx.decls.get(name) ?? []) {
    if (ts.isFunctionDeclaration(decl) && decl.body) return { fn: decl, file: sf.fileName };
    if (ts.isVariableDeclaration(decl) && decl.initializer
      && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
      return { fn: decl.initializer as ts.FunctionLikeDeclaration, file: sf.fileName };
    }
  }
  return null;
}

/**
 * The handler behind `export const GET = withApiHandler({…}, async ({…}) => …)`
 * — or a bare `export async function GET(…)`. Returns the function plus the
 * `withApiHandler` options object, which is where `tokenScope` and `skipAuth`
 * live.
 */
function handlerFor(sf: ts.SourceFile, method: string): Handler | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === method && isExported(stmt)) {
      return { fn: stmt, options: null, file: sf.fileName };
    }
    if (!ts.isVariableStatement(stmt) || !isExported(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== method || !decl.initializer) continue;
      const init = decl.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        return { fn: init, options: null, file: sf.fileName };
      }
      if (ts.isCallExpression(init)) {
        const options = init.arguments.find(ts.isObjectLiteralExpression) ?? null;
        const inline = [...init.arguments].reverse().find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (inline) return { fn: inline as ts.FunctionLikeDeclaration, options, file: sf.fileName };
        const named = [...init.arguments].reverse().find(ts.isIdentifier);
        const resolved = named ? namedHandler(named.text, sf) : null;
        if (resolved) return { ...resolved, options };
      }
    }
  }
  return null;
}

/** The string literal a `withApiHandler` options object gives `tokenScope`. */
function tokenScopeOf(options: ts.ObjectLiteralExpression | null): string | null {
  const prop = options?.properties.find(
    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'tokenScope',
  );
  const value = prop && ts.isPropertyAssignment(prop) ? prop.initializer : null;
  return value && ts.isStringLiteral(value) ? value.text : null;
}

/** Whether the options object mounts the route `skipAuth: true` (#2910). */
function skipAuthOf(options: ts.ObjectLiteralExpression | null): boolean {
  return Boolean(options?.properties.some(
    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'skipAuth'
      && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  ));
}

/* ------------------------------------------------------------------ *
 * 4. which fields the handler's success responses actually carry
 * ------------------------------------------------------------------ */

/** Return statements belonging to `fn` itself — nested closures are theirs. */
function ownReturns(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const out: ts.Expression[] = [];
  const body = fn.body;
  if (!body) return out;
  if (!ts.isBlock(body)) return [body]; // concise arrow body
  const walk = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    node.forEachChild(walk);
  };
  body.forEachChild(walk);
  return out;
}

/** `NextResponse.json(x, { status: 500 })` and `{ error: … }` are not payloads. */
function isErrorResponse(call: ts.CallExpression): boolean {
  const init = call.arguments[1];
  if (init && ts.isObjectLiteralExpression(init)) {
    for (const p of init.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'status') {
        const n = Number(p.initializer.getText());
        if (Number.isFinite(n) && n >= 400) return true;
      }
    }
  }
  const payload = call.arguments[0];
  if (payload && ts.isObjectLiteralExpression(payload)) {
    const names = payload.properties.map(p => (p.name && ts.isIdentifier(p.name) ? p.name.text : ''));
    if (names.length > 0 && names.every(n => n === 'error')) return true;
  }
  return false;
}

const MAX_DEPTH = 14;
const PASSTHROUGH_METHODS = new Set(['filter', 'sort', 'slice', 'concat', 'reverse', 'flat']);
const PROJECTING_METHODS = new Set(['map', 'flatMap']);

/**
 * Every named declaration in a file, at any nesting depth — the payload of a
 * route handler is almost always assembled in `const`s inside the handler body
 * (`const files = await ServiceManager.getServiceFiles(…)`), not at module
 * level. Same-named declarations in different scopes are unioned rather than
 * shadow-resolved; that is deliberately coarse, and coarse in the harmless
 * direction here, because the only question asked of it is "which names can
 * this response carry".
 */
function declarationsOf(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const map = new Map<string, ts.Node[]>();
  const push = (name: string, node: ts.Node) => {
    const list = map.get(name);
    if (list) list.push(node); else map.set(name, [node]);
  };
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) push(node.name.text, node);
    if (ts.isFunctionDeclaration(node) && node.name) push(node.name.text, node);
    if (ts.isClassDeclaration(node) && node.name) push(node.name.text, node);
    node.forEachChild(walk);
  };
  sf.forEachChild(walk);
  return map;
}

type Ctx = {
  sf: ts.SourceFile;
  imports: Map<string, { file: string; exported: string }>;
  decls: Map<string, ts.Node[]>;
};
const ctxCache = new Map<string, Ctx>();
function ctxFor(file: string): Ctx {
  let ctx = ctxCache.get(file);
  if (!ctx) {
    const sf = parse(file);
    ctx = { sf, imports: importsOf(sf), decls: declarationsOf(sf) };
    ctxCache.set(file, ctx);
  }
  return ctx;
}

/**
 * Top-level property names of whatever `expr` evaluates to.
 *
 * Follows only what it can prove; anything else yields the empty set, so the
 * resolver can lose ground but never invent a field.
 */
function fieldsOf(expr: ts.Expression | undefined, ctx: Ctx, depth = 0, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (!expr || depth > MAX_DEPTH) return out;
  const add = (more: Set<string>) => more.forEach(f => out.add(f));

  if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        add(fieldsOf(prop.expression, ctx, depth + 1, seen));
      } else if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        out.add(prop.name.text);
      }
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    for (const el of expr.elements) {
      add(fieldsOf(ts.isSpreadElement(el) ? el.expression : el, ctx, depth + 1, seen));
    }
    return out;
  }
  if (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    return fieldsOf(expr.expression, ctx, depth + 1, seen);
  }
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return fieldsOf(expr.expression, ctx, depth + 1, seen);
  }
  if (ts.isConditionalExpression(expr)) {
    add(fieldsOf(expr.whenTrue, ctx, depth + 1, seen));
    add(fieldsOf(expr.whenFalse, ctx, depth + 1, seen));
    return out;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      add(fieldsOf(expr.left, ctx, depth + 1, seen));
      add(fieldsOf(expr.right, ctx, depth + 1, seen));
    }
    return out;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (PASSTHROUGH_METHODS.has(method)) return fieldsOf(callee.expression, ctx, depth + 1, seen);
      if (PROJECTING_METHODS.has(method)) {
        const cb = expr.arguments[0];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          for (const ret of ownReturns(cb as ts.FunctionLikeDeclaration)) {
            add(fieldsOf(ret, ctx, depth + 1, seen));
          }
        }
        return out;
      }
      if (ts.isIdentifier(callee.expression)) {
        return resolveChain([callee.expression.text, method], ctx, depth + 1, seen);
      }
      return out;
    }
    if (ts.isIdentifier(callee)) return resolveChain([callee.text], ctx, depth + 1, seen);
    return out;
  }
  if (ts.isIdentifier(expr)) return resolveChain([expr.text], ctx, depth + 1, seen);
  return out;
}

/** Every return of a function-like, unioned. */
function fieldsOfFunction(fn: ts.FunctionLikeDeclaration, ctx: Ctx, depth: number, seen: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const ret of ownReturns(fn)) fieldsOf(ret, ctx, depth + 1, seen).forEach(f => out.add(f));
  return out;
}

/**
 * Resolve `['runDiagnose']`, `['ServiceManager', 'getServiceFiles']` or a plain
 * local const to the fields it produces — hopping one module at a time, so a
 * static alias (`static getServiceFiles = ServiceListing.getServiceFiles`) lands
 * where the object literal is actually written.
 */
function resolveChain(chain: string[], ctx: Ctx, depth: number, seen: Set<string>): Set<string> {
  const out = new Set<string>();
  if (depth > MAX_DEPTH) return out;
  const key = `${ctx.sf.fileName}#${chain.join('.')}`;
  if (seen.has(key)) return out;
  seen.add(key);

  const [head, ...rest] = chain;

  const imported = ctx.imports.get(head);
  if (imported) {
    return resolveChain([imported.exported, ...rest], ctxFor(imported.file), depth + 1, seen);
  }

  const add = (more: Set<string>) => more.forEach(f => out.add(f));

  for (const decl of ctx.decls.get(head) ?? []) {
    if (rest.length === 0) {
      if (ts.isFunctionDeclaration(decl)) {
        add(fieldsOfFunction(decl, ctx, depth, seen));
        continue;
      }
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = decl.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          add(fieldsOfFunction(init as ts.FunctionLikeDeclaration, ctx, depth, seen));
        } else {
          add(fieldsOf(init, ctx, depth + 1, seen));
        }
      }
      continue;
    }
    if (!ts.isClassDeclaration(decl)) continue;
    const member = decl.members.find(m => m.name && ts.isIdentifier(m.name) && m.name.text === rest[0]);
    if (!member) continue;
    if (ts.isMethodDeclaration(member)) {
      add(fieldsOfFunction(member, ctx, depth, seen));
      continue;
    }
    if (ts.isPropertyDeclaration(member) && member.initializer) {
      const init = member.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        add(fieldsOfFunction(init as ts.FunctionLikeDeclaration, ctx, depth, seen));
      } else if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)) {
        add(resolveChain([init.expression.text, init.name.text], ctx, depth + 1, seen));
      } else if (ts.isIdentifier(init)) {
        add(resolveChain([init.text], ctx, depth + 1, seen));
      }
    }
  }
  return out;
}

/** The union of every success payload the handler can answer with. */
function responseFields(handler: Handler): Set<string> {
  // The handler's OWN module is the context — a named handler mounted by the
  // route lives elsewhere, and resolving its consts against the route file
  // would find nothing.
  const ctx = ctxFor(handler.file);
  const out = new Set<string>();
  for (const ret of ownReturns(handler.fn)) {
    if (ts.isCallExpression(ret)) {
      const callee = ret.expression;
      const isJson = ts.isPropertyAccessExpression(callee) && callee.name.text === 'json';
      if (isJson) {
        if (isErrorResponse(ret)) continue;
        fieldsOf(ret.arguments[0], ctx).forEach(f => out.add(f));
        continue;
      }
    }
    // `withApiHandler` also serialises a bare value the handler returns.
    fieldsOf(ret, ctx).forEach(f => out.add(f));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The contract itself — one case per verb, no allow-list
 * ------------------------------------------------------------------ */

/** A plausible value per positional, so `path()` yields a concrete pathname. */
const SAMPLE = 'sample';

function pathnameFor(verb: Verb): string {
  const args = Object.fromEntries(verb.positionals.map(p => [p, SAMPLE]));
  return verb.path(args, {}).split('?')[0];
}

type Finding = {
  file: string | null;
  methods: string[];
  scope: string | null;
  skipAuth: boolean;
  fields: string[];
};

function inspect(verb: Verb): Finding {
  const pathname = pathnameFor(verb);
  const file = resolveRouteFile(pathname);
  if (!file) return { file: null, methods: [], scope: null, skipAuth: false, fields: [] };
  const sf = parse(file);
  const handler = handlerFor(sf, verb.method);
  return {
    file,
    methods: exportedMethods(sf),
    scope: handler ? tokenScopeOf(handler.options) : null,
    skipAuth: handler ? skipAuthOf(handler.options) : false,
    fields: handler ? [...responseFields(handler)] : [],
  };
}

const entries = Object.entries(VERBS);

describe('agent CLI verb table ↔ ServiceBay routes', () => {
  it('has verbs to check (a table that emptied itself is a red, not a pass)', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  describe.each(entries)('%s', (name, verb) => {
    const pathname = pathnameFor(verb);
    const found = inspect(verb);

    it(`${verb.method} ${pathname} exists`, () => {
      expect(
        found.file,
        `verb \`${name}\` speaks ${verb.method} ${pathname}, but no route.ts resolves under ` +
          `packages/frontend/src/app/api/ — the route was renamed, moved or removed.`,
      ).not.toBeNull();
    });

    it(`exports ${verb.method}`, () => {
      expect(
        found.methods,
        `verb \`${name}\` uses ${verb.method} ${pathname}, but ${path.relative(REPO_ROOT, found.file ?? '?')} ` +
          `exports [${found.methods.join(', ') || 'nothing'}].`,
      ).toContain(verb.method);
    });

    // Two auth shapes, one criterion: the route must carry the one the verb
    // declares. A `parent-token` verb (#2910) is the delegate pair, whose
    // credential is the presented token itself — so `skipAuth: true` is what
    // must be there, and a `tokenScope` appearing on it would be the
    // regression (it would start gating a route that must not be gated).
    const parentToken = verb.auth === 'parent-token';
    it(parentToken
      ? 'is mounted skipAuth, with no tokenScope gating it'
      : `is reachable with the \`${verb.scope}\` token scope`, () => {
      if (parentToken) {
        expect(
          found.skipAuth,
          `verb \`${name}\` declares auth='parent-token', but ${verb.method} ${pathname} is not mounted ` +
            `skipAuth: true — the presented token IS the delegation parent, verified inside the handler, ` +
            `so a gate in front of it refuses the very credential the route exists to accept.`,
        ).toBe(true);
        expect(
          found.scope,
          `verb \`${name}\` declares auth='parent-token', but ${verb.method} ${pathname} now carries ` +
            `tokenScope='${found.scope}'. A parent token may hold ANY scope; gating on a fixed one turns ` +
            `a valid delegation into a 403.`,
        ).toBeNull();
        return;
      }
      expect(
        found.scope,
        `verb \`${name}\` declares the \`${verb.scope}\` scope, but ${verb.method} ${pathname} carries ` +
          `tokenScope=${found.scope ?? 'none'} — without it requireSession skips the Bearer branch and a ` +
          `valid sb_ token 401s (#2899).`,
      ).toBe(verb.scope);
    });

    it.each(verb.reads.map(f => [f]))(`returns %s`, (field) => {
      expect(
        found.fields,
        `verb \`${name}\` reads \`${field}\` out of ${verb.method} ${pathname}, but that handler's success ` +
          `response carries [${found.fields.sort().join(', ') || 'nothing resolvable'}]. Either the route ` +
          `stopped returning it, or the CLI is reading a field that was renamed.`,
      ).toContain(field);
    });
  });
});

describe('the check itself goes red on a broken verb (negative control)', () => {
  const real = VERBS.assists;

  it('a verb whose route does not exist', () => {
    const bogus = { ...real, path: () => '/api/there-is-no-such-route' } as Verb;
    expect(inspect(bogus).file).toBeNull();
  });

  it('a verb using a method the route does not export', () => {
    const bogus = { ...real, method: 'DELETE' } as Verb;
    expect(inspect(bogus).methods).not.toContain(bogus.method);
  });

  it('a verb reading a field the route never returns', () => {
    expect(inspect(real).fields).not.toContain('fieldTheRouteNeverReturns');
  });

  it('a parent-token verb pointed at a scope-gated route', () => {
    const bogus = { ...real, auth: 'parent-token', scope: null } as Verb;
    const found = inspect(bogus);
    expect(found.skipAuth).toBe(false);
    expect(found.scope).toBe('read');
  });

  it('resolves a NAMED handler through the import hop, not just an inline arrow', () => {
    // `withApiHandler({ skipAuth: true }, delegateTokenHandler)` — the fields
    // live in packages/backend/src/lib/api/apiTokenRoutes.ts, two hops away.
    const found = inspect(VERBS.delegate);
    expect(found.fields).toContain('secret');
    expect(found.skipAuth).toBe(true);
  });

  it('resolves real fields through an import hop, so an empty set is never the reason', () => {
    // GET /api/services/[name] returns `ServiceManager.getServiceFiles(...)`
    // straight through: the names live two modules away, behind a static alias.
    const files = inspect(VERBS.service).fields;
    expect(files).toContain('serviceContent');
    expect(files).toContain('yamlContent');
  });
});
