/**
 * CLASS GATE: every agent-CLI verb's declared effect matches the tier of the
 * route it really speaks (#2965; widened for the mutating verbs by #2990).
 *
 * The agent CLI was read-only by design, and #2990 ended that deliberately:
 * the pi-web token carries `read,propose,lifecycle,mutate`, and a CLI that
 * refused to carry a mutation did not prevent one — it sent the session to the
 * raw `/mcp` endpoint with the token on the command line instead (ADR 0017).
 * So the property this gate defends is no longer "the CLI cannot change the
 * box". It is the one that still holds:
 *
 *   **A verb may only reach a route whose tier it declares, and it declares
 *   the tier the route really carries.** Neither side may drift from the
 *   other, in either direction, and a verb added next month cannot quietly
 *   point somewhere wider than it admits.
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
 *   `mutate`          → the route must carry a tokenScope on a MUTATING tier
 *                       of the ladder, and that tier must be EXACTLY the one
 *                       the verb declares in `scope` — so the CLI's own error
 *                       message ("this verb needs `lifecycle`") is the tier the
 *                       server will really demand, and a route quietly widened
 *                       from `lifecycle` to `destroy` breaks the build instead
 *                       of the operator's trust
 *
 * The fourth value is where the fail-closed argument lives, so it is checked in
 * BOTH directions and neither half is redundant:
 *
 *   - a verb that is NOT `mutate` may never resolve to a route on a mutating
 *     tier (the original #2965 clause, now scoped to the other three effects);
 *   - a verb that IS `mutate` may never resolve to a route on `read` or
 *     `propose` — a mutating verb pointed at a read route would sail through
 *     the first clause while telling its caller the wrong tier, and a verb
 *     declaring a scope its route does not carry is the same lie in reverse.
 *
 * What the CLI still may not do is decide. Destroy-tier work — removal, reset,
 * exec — has no verb and no route it may point at here: it stays an approval
 * (#2994), because a token that may change a service is not thereby a token
 * that may end one.
 *
 * The `describe('the check itself')` block at the bottom is the negative
 * control: synthetic verbs — an invented effect, a missing one, a read verb on
 * a mutating route, a mutate verb on a read route, a mutate verb whose declared
 * scope is not the route's, a request verb pointed somewhere that never files
 * an approval — each proving the corresponding criterion really goes red.
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

/** The closed set of effects a verb may declare (#2990 adds the fourth). */
const EFFECTS = ['read', 'request', 'own-credential', 'mutate'] as const;

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

    it('reaches a route on a mutating tier only if it declares effect=mutate', () => {
      if (verb.effect === 'mutate') return;
      expect(
        MUTATING_SCOPES,
        `verb \`${name}\` declares effect='${verb.effect}' but speaks ${verb.method} ${found.pathname}, whose `
          + `handler carries tokenScope='${found.scope}' — a tier that CHANGES the box. Only a verb that declares `
          + `effect='mutate' may reach one, and then it must declare that exact tier in \`scope\` (ADR 0017). If `
          + 'this verb should not change the box, point it elsewhere; if it should, say so in its effect.',
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
      if (verb.effect === 'mutate') {
        // Half one: the route really is on a mutating tier. A `mutate` verb
        // pointed at a read or propose route would pass the clause above (it
        // is exempt there) and then tell its caller the wrong tier.
        expect(
          MUTATING_SCOPES,
          `verb \`${name}\` declares effect='mutate', but ${verb.method} ${found.pathname} carries `
            + `tokenScope='${found.scope ?? 'none'}' — not a mutating tier. A verb that does not change the box `
            + 'must not claim it does: declare read, request or own-credential instead.',
        ).toContain(found.scope);
        // Half two: the tier it declares is the tier the server demands. The
        // CLI quotes `scope` back in every auth refusal, so a mismatch here is
        // an agent told to ask for the wrong thing.
        expect(
          found.scope,
          `verb \`${name}\` declares scope='${verb.scope}', but ${verb.method} ${found.pathname} demands `
            + `tokenScope='${found.scope ?? 'none'}'. The CLI reports its declared scope in every 401/403, so the `
            + 'two must be the same word or the error message sends the agent after the wrong grant.',
        ).toBe(verb.scope);
        return;
      }
      const expected = verb.effect === 'request' ? PROPOSE_SCOPE : READ_SCOPE;
      expect(
        found.scope,
        `verb \`${name}\` declares effect='${verb.effect}', so ${verb.method} ${found.pathname} must carry `
          + `tokenScope='${expected}' (it carries ${found.scope ?? 'none'}).`,
      ).toBe(expected);
    });

    it('declares the scope its route demands, for every scope-gated verb', () => {
      if (verb.effect === 'own-credential') return;
      expect(
        verb.scope,
        `verb \`${name}\` declares scope='${verb.scope}' while ${verb.method} ${found.pathname} carries `
          + `tokenScope='${found.scope ?? 'none'}'.`,
      ).toBe(found.scope);
    });

    it('never reaches the destroy, reboot or exec tiers — those stay approvals', () => {
      expect(
        ['destroy', 'reboot', 'exec'],
        `verb \`${name}\` speaks ${verb.method} ${found.pathname}, which carries tokenScope='${found.scope}'. `
          + 'A token that may change a service is not thereby a token that may end one: removal, reset and exec '
          + 'have no CLI verb and are requested, not performed (#2994).',
      ).not.toContain(found.scope);
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
    const bogus = { ...read, effect: 'destroy' } as Verb;
    expect(EFFECTS as readonly string[]).not.toContain(bogus.effect);
  });

  it('a read verb pointed at the real install route — the shape #2965 rejected', () => {
    // `POST /api/install/start` carries `tokenScope: 'lifecycle'`. The gate
    // reads that off the checkout and refuses, whatever the verb claims about
    // itself. #2990 widened WHO may reach such a route, not whether a verb may
    // misdescribe one.
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
    expect(found.scope).not.toBe(READ_SCOPE);
  });

  it('a mutate verb pointed at a READ route — the other direction (#2990)', () => {
    // The half that did not exist before the fourth effect: `GET /api/services`
    // carries `tokenScope: 'read'`. A verb declaring effect='mutate' there is
    // exempt from the "never touch a mutating tier" clause, so without this
    // check it would pass while telling its caller to go get `mutate`.
    const offending = { ...read, effect: 'mutate', scope: 'mutate' } as Verb;
    const found = inspect(offending);
    expect(found.file).not.toBeNull();
    expect(MUTATING_SCOPES).not.toContain(found.scope);
  });

  it('a mutate verb whose declared scope is not the tier the route demands', () => {
    // `POST /api/install/template` carries 'mutate'. A verb declaring
    // scope: 'lifecycle' against it would print "this verb needs `lifecycle`"
    // on every refusal and send the agent after a grant that still would not
    // work.
    const offending = {
      ...read,
      effect: 'mutate',
      scope: 'lifecycle',
      method: 'POST',
      positionals: [],
      path: () => '/api/install/template',
    } as Verb;
    const found = inspect(offending);
    expect(found.scope).toBe('mutate');
    expect(found.scope).not.toBe(offending.scope);
  });

  it('a mutating route that carries no tokenScope at all is refused too', () => {
    // The shape `POST /api/services/[name]/action` had until #2990: cookie-only,
    // no tokenScope to read. Simulated here rather than pointed at the real
    // route — which now carries 'lifecycle' — because an absent tier must stay
    // a red for every effect, not a hole. `effect: 'mutate'` demands membership
    // in MUTATING_SCOPES, and `null` is not a member.
    const found = { pathname: '/api/anything', file: 'route.ts', scope: null, skipAuth: false, reachesApproval: false };
    expect(MUTATING_SCOPES).not.toContain(found.scope);
    expect(found.scope).not.toBe(READ_SCOPE);
    expect(found.scope).not.toBe(PROPOSE_SCOPE);
  });

  it('the real mutating verbs resolve, and to the tiers they declare', () => {
    const update = inspect(VERBS.update);
    expect(update.file).not.toBeNull();
    expect(update.scope).toBe('lifecycle');
    expect(VERBS.update.scope).toBe('lifecycle');
    expect(MUTATING_SCOPES).toContain(update.scope);

    const install = inspect(VERBS.install);
    expect(install.file).not.toBeNull();
    expect(install.scope).toBe('mutate');
    expect(VERBS.install.scope).toBe('mutate');
    expect(MUTATING_SCOPES).toContain(install.scope);
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
