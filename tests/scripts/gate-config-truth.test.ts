import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  gateGlobToRegExp,
  extractSemgrepPathGlobs,
  extractDepcruiseRoots,
} from '../../scripts/check-invariants';

/**
 * #2428 / #2429 / #2427 — the two ways a quality gate lies, and the doc that
 * asserted three things about the code that were not true.
 *
 * A gate can fail open in two shapes, and BOTH report green:
 *   1. it scans nothing — its paths point at a tree that no longer exists
 *      (`src/…` survived the workspace split in three `.semgrep.yml` rules and
 *      in `checkExecTemplateLiterals`, which walked the frontend only while
 *      every `executor.exec` call site lives in the backend);
 *   2. it runs nowhere — the script exists and passes locally but no CI job
 *      invokes it (`check:backup-coverage`, the only gate between "a template
 *      ships a new persistent volume" and "the box loses that data on a
 *      disk-loss reinstall").
 *
 * These cases pin the structural guards that make both shapes build-breaking,
 * so the next workspace move can't quietly re-open them.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Every tracked file path, repo-relative. */
const trackedFiles: string[] = execFileSync('git', ['ls-files'], {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
  maxBuffer: 32 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const matchCount = (glob: string) => {
  const re = gateGlobToRegExp(glob);
  return trackedFiles.filter(f => re.test(f)).length;
};

describe('gateGlobToRegExp — gitignore / Semgrepignore v2 semantics', () => {
  it('anchors a pattern that contains a separator at the repo root', () => {
    // The exact stale entries #2428 found. They only kept matching under
    // semgrep's LEGACY unanchored globbing; under the semantics semgrep is
    // migrating to they resolve to nothing.
    expect(matchCount('src/lib/systemBackup.ts')).toBe(0);
    expect(matchCount('src/lib/util/safeTarExtract*')).toBe(0);
    expect(matchCount('src/app/api/**/route.ts')).toBe(0);

    // …and their repointed replacements resolve.
    expect(matchCount('packages/backend/src/lib/systemBackup.ts')).toBe(1);
    expect(matchCount('packages/frontend/src/app/api/**/route.ts')).toBeGreaterThan(100);
  });

  it('matches a separator-free pattern at any depth', () => {
    expect(gateGlobToRegExp('*.test.ts').test('tests/backend/x.test.ts')).toBe(true);
    expect(gateGlobToRegExp('*.test.ts').test('a/b/c.test.ts')).toBe(true);
    expect(gateGlobToRegExp('*.test.ts').test('a/b/c.ts')).toBe(false);
  });

  it('treats a trailing slash as "this directory and everything under it"', () => {
    expect(gateGlobToRegExp('tests/').test('tests/backend/x.ts')).toBe(true);
    expect(gateGlobToRegExp('packages/*/src/').test('packages/backend/src/lib/a.ts')).toBe(true);
    // `*` does not cross a separator; `**` does.
    expect(gateGlobToRegExp('packages/*/src/').test('packages/a/b/src/x.ts')).toBe(false);
    expect(gateGlobToRegExp('packages/**/src/').test('packages/a/b/src/x.ts')).toBe(true);
  });
});

describe('#2428 — every path a gate config names resolves to a non-empty file set', () => {
  const semgrepGlobs = extractSemgrepPathGlobs(
    readFileSync(path.join(REPO_ROOT, '.semgrep.yml'), 'utf-8'),
  );

  it('finds the paths blocks in .semgrep.yml at all (the parser is not vacuous)', () => {
    expect(semgrepGlobs.length).toBeGreaterThan(5);
    expect(semgrepGlobs.map(g => g.label)).toContain('api-route-without-with-api-handler paths.include');
  });

  it.each(semgrepGlobs.filter(g => g.glob !== 'node_modules/').map(g => [g.label, g.glob]))(
    '.semgrep.yml %s — `%s` matches at least one tracked file',
    (_label, glob) => {
      expect(matchCount(glob)).toBeGreaterThan(0);
    },
  );

  it('every depcruise root on the check:deps command line exists', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const roots = extractDepcruiseRoots(pkg.scripts['check:deps']);
    expect(roots.length).toBeGreaterThan(1);
    for (const root of roots) {
      expect(existsSync(path.join(REPO_ROOT, root)), root).toBe(true);
      expect(matchCount(`${root}/`), root).toBeGreaterThan(0);
    }
  });

  it('the semgrep image in CI is pinned, not floating', () => {
    const ci = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8');
    const image = /image:\s*(\S*semgrep\S*)/.exec(ci)?.[1];
    expect(image).toBeDefined();
    // A floating tag lets an upstream release change what gets scanned with no
    // commit in this repo — the Semgrepignore v2 flip would have emptied three
    // rules silently.
    expect(image).toMatch(/semgrep:\d+\.\d+\.\d+$/);
  });
});

describe('#2429 — every local check:* gate runs in CI', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const workflowDir = path.join(REPO_ROOT, '.github', 'workflows');
  const workflowText = readdirSync(workflowDir)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => readFileSync(path.join(workflowDir, f), 'utf-8'))
    .join('\n');

  const runsInCi = (name: string) =>
    new RegExp(`npm run ${name.replace(/:/g, '[:]')}(?![\\w:-])`).test(workflowText);

  const satisfied = (name: string, depth = 0): boolean => {
    if (runsInCi(name)) return true;
    if (depth > 2) return false;
    const members = [...(pkg.scripts[name] ?? '').matchAll(/npm run ([\w:-]+)/g)].map(m => m[1]);
    return members.length > 0 && members.every(m => satisfied(m, depth + 1));
  };

  const checkScripts = Object.keys(pkg.scripts).filter(n => n.startsWith('check:'));

  it('there are check:* scripts to check (the list is not vacuous)', () => {
    expect(checkScripts).toContain('check:backup-coverage');
    expect(checkScripts).toContain('check:arch');
  });

  it.each(checkScripts)('`%s` is reachable from .github/workflows/', name => {
    expect(satisfied(name)).toBe(true);
  });

  it('check:backup-coverage runs in CI directly — not only via check:arch', () => {
    // The regression this exists for: CI reimplemented check:arch as separate
    // jobs and dropped this one.
    expect(runsInCi('check:backup-coverage')).toBe(true);
  });

  it('every `npm run <script>` a workflow invokes exists in package.json', () => {
    const missing = [...workflowText.matchAll(/npm run ([\w:-]+)/g)]
      .map(m => m[1])
      .filter(name => !pkg.scripts[name]);
    expect(missing).toEqual([]);
  });
});

describe('#2428 — the exec-template-literal ratchet scans the backend, not just the frontend', () => {
  it('reports a measured count over BOTH source roots', () => {
    const out = execFileSync('npx', ['tsx', 'scripts/check-invariants.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const line = out.split('\n').find(l => l.includes('executor.exec template-literal call sites'));
    expect(line).toBeDefined();
    // Every `executor.exec` call site in the repo lives under the backend root;
    // walking the frontend alone measured none of them.
    expect(line).toContain('packages/backend/src');
    expect(line).toContain('packages/frontend/src');
  }, 120_000);
});

describe('#2427 — the invariants doc states nothing that is wrong at HEAD', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/ARCHITECTURE_INVARIANTS.md'), 'utf-8');

  it('every repo file path it names in backticks exists', () => {
    const cited = [...doc.matchAll(/`([\w./-]+\.(?:ts|tsx|cjs|mjs|json|css|md|yml))`/g)]
      .map(m => m[1])
      .filter(p => /^(packages|scripts|docs|tests|templates|tools|assists)\//.test(p));
    expect(cited.length).toBeGreaterThan(5);
    expect(cited.filter(p => !existsSync(path.join(REPO_ROOT, p)))).toEqual([]);
  });

  it('does not repeat the retired claim that install/runner.ts imports mustache directly', () => {
    // `git grep "from 'mustache'"` returns render.ts + one test, and has for a
    // long time — the doc claimed an exemption that no longer existed.
    const mustacheImporters = execFileSync('git', ['grep', '-l', "from 'mustache'"], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean)
      // This spec quotes the needle verbatim, so once it was committed
      // `git grep` started matching the spec itself and the gate went red on
      // its own text. Drop the self-match; it is an assertion, not an import.
      .filter(p => p !== 'tests/scripts/gate-config-truth.test.ts');
    expect(mustacheImporters).toEqual([
      'packages/backend/src/lib/template/render.ts',
      'tests/backend/template_consistency.test.ts',
    ]);
    expect(doc).not.toMatch(/still import `?mustache`? directly and are exempt/);
  });

  it('carries the generated threshold block rather than hand-typed measurements', () => {
    expect(doc).toContain('<!-- BEGIN GENERATED: thresholds — do not edit by hand -->');
    expect(doc).toContain('<!-- END GENERATED: thresholds -->');
    // The threshold the doc used to get wrong (it said 35/40; the constant is 0).
    const twinRow = doc
      .split('\n')
      .find(l => l.includes('DigitalTwinStore.getInstance()') && l.includes('TWIN_GETINSTANCE_MAX'));
    const constant = /const TWIN_GETINSTANCE_MAX = (\d+)/.exec(
      readFileSync(path.join(REPO_ROOT, 'scripts/check-invariants.ts'), 'utf-8'),
    )?.[1];
    expect(twinRow).toContain(`| ${constant} |`);
  });
});
