/**
 * CLASS GATE: no agent-CLI verb reaches a mutating call (#2965, criterion 6).
 *
 * The agent CLI is read-only by design. #2965 adds the first verb that writes
 * anything at all — `request-install`, which files a request an operator must
 * approve — and the whole security argument for it rests on a property no
 * single test of that one verb can carry: that the CLI still cannot change the
 * box, and that a verb added next month cannot quietly start to.
 *
 * So this file checks the **class**. It walks `VERBS` — every entry, no
 * allow-list, no hand-kept list of "the safe ones" — and for each entry asks
 * the checkout what the route it speaks really is.
 *
 * ## What "a mutating call" means here, and why it is derived
 *
 * ServiceBay already has one authority on how much blast radius a route
 * carries: the scope ladder in `packages/backend/src/lib/auth/apiScope.ts`,
 * declared per route as `withApiHandler({ tokenScope })`. `read` inspects;
 * `propose` is the ladder's *independent* "ask a human" capability (it writes a
 * proposal, never the box); `lifecycle | mutate | reboot | destroy | exec` are
 * the tiers that change something. This gate derives its mutating set from
 * `ALL_SCOPES` by SUBTRACTION — so a new tier added to the ladder tomorrow is
 * treated as mutating until someone deliberately says otherwise, which is the
 * fail-closed direction.
 *
 * Each verb also declares an `effect` from a closed set of three, and the gate
 * holds the declaration against the route:
 *
 *   `read`            → the route must carry `tokenScope: 'read'`
 *   `request`         → the route must carry `tokenScope: 'propose'`, AND its
 *                       handler must actually reach `submitApproval` — that is
 *                       the "without going through the approval path" clause,
 *                       checked structurally rather than believed
 *   `own-credential`  → the route must be mounted `skipAuth: true` with no
 *                       `tokenScope` (the delegate pair, #2910: the presented
 *                       token IS the credential, and a child is never wider
 *                       than its parent)
 *
 * There is deliberately no fourth value. A verb that would install, deploy,
 * restart, delete or exec has nowhere to declare itself and no route tier it
 * may point at, so it goes red on the day it is added rather than on the day
 * someone notices.
 *
 * The `describe('the check itself')` block at the bottom is the negative
 * control: synthetic verbs — a mutating route, an invented effect, a missing
 * one, a request verb pointed somewhere that never files an approval — each
 * proving the corresponding criterion really goes red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ALL_SCOPES } from '../../packages/backend/src/lib/auth/apiScope';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'agent-cli', 'servicebay.mjs');
const API_ROOT = path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app', 'api');

type Verb = {
  usage: string;
  effect?: string;
  auth?: string;
  scope: string | null;
  method: string;
  positionals: string[];
  options: string[];
  path: (args: Record<string, string>, opts: Record<string, string>) => string;
};

const { VERBS } = (await import(CLI_PATH)) as { VERBS: Record<string, Verb> };

/* ------------------------------------------------------------------ *
 * the tiers, derived from the ladder rather than listed
 * ------------------------------------------------------------------ */

/** Inspects only. */
const READ_SCOPE = 'read';
/** Writes a proposal for a human to weigh; never the box (apiScope.ts). */
const PROPOSE_SCOPE = 'propose';

/** Everything else on the ladder changes something. Subtraction, not a list:
 *  a tier added later counts as mutating without anyone remembering to. */
export const MUTATING_SCOPES: readonly string[] = ALL_SCOPES.filter(
  s => s !== READ_SCOPE && s !== PROPOSE_SCOPE,
);

/** The closed set of effects a verb may declare. */
const EFFECTS = ['read', 'request', 'own-credential'] as const;

/* ------------------------------------------------------------------ *
 * route resolution (same app-router rules as agent_cli_route_contract)
 * ------------------------------------------------------------------ */

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

const sourceCache = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = sourceCache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    sourceCache.set(file, sf);
  }
  return sf;
}

const ALIASES: [string, string][] = [
  ['@/lib/', path.join(REPO_ROOT, 'packages', 'backend', 'src', 'lib') + '/'],
  ['@/app/', path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'app') + '/'],
  ['@/components/', path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'components') + '/'],
  ['@/', path.join(REPO_ROOT, 'packages', 'frontend', 'src') + '/'],
];

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

/** Local name → the file it was imported from. */
function importedFrom(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const file = resolveModule(stmt.moduleSpecifier.text, sf.fileName);
    if (!file || !stmt.importClause) continue;
    const bindings = stmt.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) map.set(el.name.text, file);
    }
    if (stmt.importClause.name) map.set(stmt.importClause.name.text, file);
  }
  return map;
}

function isExported(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}

type Handler = { fn: ts.FunctionLikeDeclaration | null; options: ts.ObjectLiteralExpression | null };

/** The handler behind `export const GET = withApiHandler({…}, fn)`. */
function handlerFor(sf: ts.SourceFile, method: string): Handler | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === method && isExported(stmt)) {
      return { fn: stmt, options: null };
    }
    if (!ts.isVariableStatement(stmt) || !isExported(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== method || !decl.initializer) continue;
      const init = decl.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return { fn: init, options: null };
      if (ts.isCallExpression(init)) {
        const options = init.arguments.find(ts.isObjectLiteralExpression) ?? null;
        const inline = [...init.arguments].reverse().find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        return { fn: (inline as ts.FunctionLikeDeclaration) ?? null, options };
      }
    }
  }
  return null;
}

function stringProp(options: ts.ObjectLiteralExpression | null, name: string): string | null {
  const prop = options?.properties.find(
    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
  );
  const value = prop && ts.isPropertyAssignment(prop) ? prop.initializer : null;
  return value && ts.isStringLiteral(value) ? value.text : null;
}

function trueProp(options: ts.ObjectLiteralExpression | null, name: string): boolean {
  return Boolean(options?.properties.some(
    p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
      && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  ));
}

/** Every plain-identifier callee inside `fn` (including nested closures). */
function calledNames(fn: ts.FunctionLikeDeclaration | null): Set<string> {
  const out = new Set<string>();
  if (!fn?.body) return out;
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) out.add(node.expression.text);
    node.forEachChild(walk);
  };
  fn.body.forEachChild(walk);
  return out;
}

/** Does this module import `submitApproval` out of the approvals kernel? */
function filesApproval(file: string): boolean {
  const sf = parse(file);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!/(^|\/)approvals$/.test(stmt.moduleSpecifier.text.replace(/\/index$/, ''))) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      if (bindings.elements.some(el => (el.propertyName ?? el.name).text === 'submitApproval')) return true;
    }
  }
  return false;
}

/**
 * Whether the handler reaches the approval path: it either calls
 * `submitApproval` itself, or calls something imported from a module that
 * does. One hop is enough and is the honest bound — a lib that files the
 * approval is where the request parks.
 */
function reachesApprovalPath(routeFile: string, handler: Handler | null): boolean {
  if (!handler) return false;
  if (filesApproval(routeFile)) return true;
  const imports = importedFrom(parse(routeFile));
  for (const name of calledNames(handler.fn)) {
    const target = imports.get(name);
    if (target && filesApproval(target)) return true;
  }
  return false;
}

const SAMPLE = 'sample';

function pathnameFor(verb: Verb): string {
  const args = Object.fromEntries(verb.positionals.map(p => [p, SAMPLE]));
  return verb.path(args, {}).split('?')[0];
}

interface Finding {
  pathname: string;
  file: string | null;
  scope: string | null;
  skipAuth: boolean;
  reachesApproval: boolean;
}

export function inspect(verb: Verb): Finding {
  const pathname = pathnameFor(verb);
  const file = resolveRouteFile(pathname);
  if (!file) return { pathname, file: null, scope: null, skipAuth: false, reachesApproval: false };
  const handler = handlerFor(parse(file), verb.method);
  return {
    pathname,
    file,
    scope: stringProp(handler?.options ?? null, 'tokenScope'),
    skipAuth: trueProp(handler?.options ?? null, 'skipAuth'),
    reachesApproval: reachesApprovalPath(file, handler),
  };
}

const entries = Object.entries(VERBS);

describe('every agent-CLI verb is read, own-credential, or a request (#2965)', () => {
  it('has verbs to check (a table that emptied itself is a red, not a pass)', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('derives the mutating tiers from the ladder, and the ladder still has some', () => {
    // If this ever empties, every check below silently passes.
    expect(MUTATING_SCOPES.length).toBeGreaterThan(0);
    expect(MUTATING_SCOPES).toContain('mutate');
    expect(MUTATING_SCOPES).toContain('destroy');
    expect(MUTATING_SCOPES).not.toContain(READ_SCOPE);
    expect(MUTATING_SCOPES).not.toContain(PROPOSE_SCOPE);
  });

  describe.each(entries)('%s', (name, verb) => {
    const found = inspect(verb);

    it('declares one of the three allowed effects', () => {
      expect(
        EFFECTS as readonly string[],
        `verb \`${name}\` declares effect=${JSON.stringify(verb.effect)}. The agent CLI has exactly three: `
          + `'read' (inspects), 'own-credential' (acts on the caller's own token lineage), 'request' (files an `
          + `approval ServiceBay executes). A verb that would change the box directly has no fourth value to `
          + 'declare and no route tier it may point at — that is the point of this gate.',
      ).toContain(verb.effect);
    });

    it('speaks a route that exists', () => {
      expect(found.file, `verb \`${name}\` speaks ${verb.method} ${found.pathname}, which resolves to no route.ts.`).not.toBeNull();
    });

    it('never reaches a route on a mutating tier of the scope ladder', () => {
      expect(
        MUTATING_SCOPES,
        `verb \`${name}\` speaks ${verb.method} ${found.pathname}, whose handler carries `
          + `tokenScope='${found.scope}' — a tier that CHANGES the box. The agent CLI never reaches one: an `
          + 'installation is REQUESTED and ServiceBay executes what the operator approved (#2965). If this verb '
          + 'genuinely needs to cause a change, file it as a request instead of widening the CLI.',
      ).not.toContain(found.scope);
    });

    it(`matches its declared effect against the route's real auth shape`, () => {
      if (verb.effect === 'own-credential') {
        expect(
          found.skipAuth,
          `verb \`${name}\` declares effect='own-credential', so its route must be mounted skipAuth: true — the `
            + 'presented token IS the credential being acted on, verified inside the handler.',
        ).toBe(true);
        expect(found.scope).toBeNull();
        return;
      }
      const expected = verb.effect === 'request' ? PROPOSE_SCOPE : READ_SCOPE;
      expect(
        found.scope,
        `verb \`${name}\` declares effect='${verb.effect}', so ${verb.method} ${found.pathname} must carry `
          + `tokenScope='${expected}' (it carries ${found.scope ?? 'none'}).`,
      ).toBe(expected);
    });

    it('goes through the approval path when, and only when, it is a request', () => {
      if (verb.effect !== 'request') return;
      expect(
        found.reachesApproval,
        `verb \`${name}\` declares effect='request', but the handler behind ${verb.method} ${found.pathname} `
          + 'never reaches `submitApproval`. A request verb that does not park a decision with the operator is '
          + 'a mutating verb wearing the word "request".',
      ).toBe(true);
    });
  });
});

describe('the check itself goes red on an offending verb (negative control)', () => {
  const read = VERBS.services;

  it('a verb with no declared effect', () => {
    const bogus = { ...read, effect: undefined } as Verb;
    expect(EFFECTS as readonly string[]).not.toContain(bogus.effect);
  });

  it('an invented effect nobody vetted', () => {
    const bogus = { ...read, effect: 'mutate' } as Verb;
    expect(EFFECTS as readonly string[]).not.toContain(bogus.effect);
  });

  it('a verb pointed at the real install route — the shape #2965 rejected', () => {
    // `POST /api/install/start` is the route a direct `install` verb would
    // speak, and it carries `tokenScope: 'lifecycle'`. The gate reads that off
    // the checkout and refuses, whatever the verb claims about itself.
    const offending = {
      ...read,
      effect: 'read',
      method: 'POST',
      positionals: [],
      path: () => '/api/install/start',
    } as Verb;
    const found = inspect(offending);
    expect(found.file).not.toBeNull();
    expect(MUTATING_SCOPES).toContain(found.scope);
  });

  it('a mutating route that carries no tokenScope at all is refused too', () => {
    // `POST /api/services/[name]/action` (start/stop/restart/update) is
    // cookie-only: no tokenScope to read. `effect: 'read'` demands 'read', so
    // an absent tier is a red rather than a hole.
    const offending = {
      ...read,
      effect: 'read',
      method: 'POST',
      positionals: ['name'],
      path: (args: Record<string, string>) => `/api/services/${args.name}/action`,
    } as Verb;
    const found = inspect(offending);
    expect(found.file).not.toBeNull();
    expect(found.scope).not.toBe(READ_SCOPE);
  });

  it('a request verb whose route never files an approval', () => {
    const offending = { ...read, effect: 'request' } as Verb;
    const found = inspect(offending);
    expect(found.reachesApproval).toBe(false);
    expect(found.scope).not.toBe(PROPOSE_SCOPE);
  });

  it('the real request verb is not passing by resolving to nothing', () => {
    const found = inspect(VERBS['request-install']);
    expect(found.file).not.toBeNull();
    expect(found.scope).toBe(PROPOSE_SCOPE);
    expect(found.reachesApproval).toBe(true);
  });
});
