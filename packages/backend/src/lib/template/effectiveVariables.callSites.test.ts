import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The guard that closes the pattern (#2544).
 *
 * Four times in a row a code path was written that resolves a template
 * variable BY NAME out of `config.templateSettings` and stops there —
 * #2531, #2537, and the two consumers #2544 fixed. Each was found by a
 * human noticing a wrong value in production, months apart, because
 * nothing in the repo objected to a fifth one being written.
 *
 * This test is that objection. It enumerates every place that reads
 * `templateSettings` as a variable LOOKUP (dynamic index, or bulk-copied
 * into a value/render view) and requires each to be on the list below with
 * a reason. A new call site fails this test on the commit that introduces
 * it, with the resolver named in the message.
 *
 * It deliberately does NOT match `config.templateSettings?.DATA_DIR` and
 * friends: a fixed property read with a literal fallback is a config
 * lookup, not template-variable resolution, and there are dozens of them.
 */

const ROOTS = ['packages/backend/src', 'packages/frontend/src'];

/**
 * Reading `templateSettings` as a variable lookup:
 *   - `templateSettings?.[expr]` / `templateSettings[expr]` — resolve a
 *     variable whose NAME is computed;
 *   - `...config.templateSettings` / `templateSettings ?? {}` — copy the
 *     whole map into a values/render view.
 */
const LOOKUP_PATTERNS: RegExp[] = [
  /templateSettings(\?\.)?\[/,
  /\.\.\.\(?\s*(config|cfg)\.templateSettings/,
  /templateSettings\s*\?\?\s*\{\}/,
];

/**
 * Every legitimate reader, with why it is not a new resolution idiom.
 * REMOVE an entry when the file stops matching — do not add one without
 * reading `effectiveVariables.ts` first.
 */
const ALLOWLIST: Record<string, string> = {
  'packages/backend/src/lib/template/effectiveVariables.ts':
    'THE resolver — the one precedence every read path goes through.',
  'packages/backend/src/lib/install/manifestAssembler.ts':
    'The install path (assembleManifest), which the resolver mirrors. The write side of the same precedence; #2537 routes the reconfigure preview through it.',
};

/**
 * Drop comments before matching. Prose ABOUT the old idiom is not the old
 * idiom — `reconfigure-preview/route.ts` documents the chain #2537 deleted,
 * and flagging that would train the next reader to weaken the patterns.
 * Block comments plus whole-line `//` / `*` comments; a trailing comment on
 * a code line is left alone (matching one is harmless, the message says
 * what to do).
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('template-variable resolution has exactly one idiom (#2544)', () => {
  const repoRoot = path.resolve(__dirname, '../../../../..');

  const found = ROOTS.flatMap(root => sourceFiles(path.join(repoRoot, root)))
    .filter(file => {
      const text = stripComments(fs.readFileSync(file, 'utf-8'));
      return LOOKUP_PATTERNS.some(re => re.test(text));
    })
    .map(file => path.relative(repoRoot, file).split(path.sep).join('/'))
    .sort();

  it('scans a plausible amount of source (guards against a broken walk)', () => {
    expect(ROOTS.flatMap(root => sourceFiles(path.join(repoRoot, root))).length).toBeGreaterThan(200);
  });

  it('has no call site that resolves a template variable outside the shared resolver', () => {
    const unexpected = found.filter(f => !(f in ALLOWLIST));
    expect(
      unexpected,
      unexpected.length === 0
        ? ''
        : `New template-variable resolution found in:\n  ${unexpected.join('\n  ')}\n\n` +
          'Resolve through resolveEffectiveVariable / buildEffectiveVariableView in ' +
          'packages/backend/src/lib/template/effectiveVariables.ts (precedence: templateSettings > ' +
          'operator-set installedVariables > template default), or — if this genuinely is not ' +
          'variable resolution — add it to ALLOWLIST in this file with the reason.',
    ).toEqual([]);
  });

  it('carries no stale allowlist entry', () => {
    const stale = Object.keys(ALLOWLIST).filter(f => !found.includes(f));
    expect(stale, `Allowlisted files that no longer match — delete these entries: ${stale.join(', ')}`)
      .toEqual([]);
  });

  it('still sees the two consumers this issue fixed going through the resolver', () => {
    // Belt and braces: the guard above only proves they stopped hand-rolling.
    // These prove they took the shared route rather than a private helper.
    const reads = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf-8');
    expect(reads('packages/backend/src/lib/health/serviceHealthBootstrap.ts'))
      .toContain('buildEffectiveVariableView');
    expect(reads('packages/backend/src/lib/portal/services.ts'))
      .toContain('resolveEffectiveVariable');
  });

  it('sees the two consumers #2551 fixed going through the resolver too', () => {
    // Dropping their allowlist entries only proves they stopped matching the
    // patterns above; a hand-rolled `installedVariables.find(...)` would slip
    // through. These pin the shared route. hostFirewall is the load-bearing
    // one — its boot re-assert is a security control (#2388).
    const reads = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf-8');
    expect(reads('packages/backend/src/lib/capabilities/hostFirewall.ts'))
      .toContain('buildEffectiveVariableView');
    expect(reads('packages/backend/src/lib/hermes/client.ts'))
      .toContain('resolveEffectiveVariable');
  });
});
