import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  gateGlobToRegExp,
  extractSemgrepPathGlobs,
  extractDepcruiseRoots,
  extractCiRunText,
} from '../../scripts/check-invariants';
import {
  toCoverageKey,
  extractHostPathVolumes,
  uncoveredVolumes,
} from '../../scripts/check-backup-coverage';

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

/** The gate's own "is this script invoked here" test, over an arbitrary text. */
const runsInText = (text: string, name: string) =>
  new RegExp(`npm run ${name.replace(/:/g, '[:]')}(?![\\w:-])`).test(text);

/**
 * The gate's aggregator rule: a script is covered when it is invoked directly,
 * or when every `npm run` it chains is itself covered.
 */
const isSatisfied = (
  text: string,
  scripts: Record<string, string>,
  name: string,
  depth = 0,
): boolean => {
  if (runsInText(text, name)) return true;
  if (depth > 2) return false;
  const members = [...(scripts[name] ?? '').matchAll(/npm run ([\w:-]+)/g)].map(m => m[1]);
  return members.length > 0 && members.every(m => isSatisfied(text, scripts, m, depth + 1));
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
  // Only what Actions executes — #2466. The gate itself uses the same
  // extractor, so this spec can't drift from the script it pins.
  const workflowText = readdirSync(workflowDir)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => extractCiRunText(readFileSync(path.join(workflowDir, f), 'utf-8')))
    .join('\n');

  const runsInCi = (name: string) => runsInText(workflowText, name);

  const satisfied = (name: string, depth = 0): boolean =>
    isSatisfied(workflowText, pkg.scripts, name, depth);

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

describe('#2466 — the ci-runs-every-check-script gate sees only text Actions executes', () => {
  const WITH_STEP = [
    'jobs:',
    '  arch:',
    '    steps:',
    '      # #2429: this is the only gate between a new volume and data loss.',
    '      - run: npm run check:foo',
  ].join('\n');

  // The exact regression shape: the real step deleted in a refactor, its
  // descriptive comment left behind next to where it used to be.
  const COMMENT_ONLY = [
    'jobs:',
    '  arch:',
    '    steps:',
    '      # dropped in a refactor, but still described here: npm run check:foo',
    '      - run: npm run typecheck',
  ].join('\n');

  const scripts = { 'check:foo': 'tsx scripts/foo.ts', typecheck: 'tsc --noEmit' };

  it('a comment mentioning the script does NOT satisfy the gate', () => {
    // Pre-fix, the gate matched the raw file text and this passed.
    expect(COMMENT_ONLY).toContain('npm run check:foo');
    expect(runsInText(extractCiRunText(COMMENT_ONLY), 'check:foo')).toBe(false);
    expect(isSatisfied(extractCiRunText(COMMENT_ONLY), scripts, 'check:foo')).toBe(false);
  });

  it('a real run step DOES satisfy it (no false positive)', () => {
    expect(runsInText(extractCiRunText(WITH_STEP), 'check:foo')).toBe(true);
    expect(isSatisfied(extractCiRunText(WITH_STEP), scripts, 'check:foo')).toBe(true);
  });

  it('reads a `run: |` block, and drops shell comments inside it', () => {
    const yaml = [
      '      - name: gates',
      '        run: |',
      '          npm run check:one',
      '',
      '          # npm run check:two   <- commented out, not executed',
      '          npm run check:three',
      '      - run: npm run check:four',
    ].join('\n');
    const text = extractCiRunText(yaml);
    expect(runsInText(text, 'check:one')).toBe(true);
    expect(runsInText(text, 'check:three')).toBe(true);
    expect(runsInText(text, 'check:four')).toBe(true);
    expect(runsInText(text, 'check:two')).toBe(false);
  });

  it('does not treat a `defaults:` → `run:` mapping as a command', () => {
    const yaml = ['defaults:', '  run:', '    shell: bash', '    working-directory: ./x'].join('\n');
    expect(extractCiRunText(yaml).trim()).toBe('');
  });

  it('unquotes an inline scalar and stops a block at the next key', () => {
    expect(extractCiRunText('        run: "npm run check:q"')).toBe('npm run check:q');
    const yaml = ['      - run: |', '          npm run check:a', '        env:', '          X: 1'].join('\n');
    expect(extractCiRunText(yaml)).toBe('npm run check:a');
  });

  it('the real workflows still expose npm commands to the gate (extractor not blind)', () => {
    // The fail-closed guard in checkCiRunsEveryCheckScript pins this too; if the
    // extractor ever parses nothing, every check:* would report uncovered.
    const workflowDir = path.join(REPO_ROOT, '.github', 'workflows');
    const executed = readdirSync(workflowDir)
      .filter(f => /\.ya?ml$/.test(f))
      .map(f => extractCiRunText(readFileSync(path.join(workflowDir, f), 'utf-8')))
      .join('\n');
    expect([...executed.matchAll(/npm run ([\w:-]+)/g)].length).toBeGreaterThan(5);
    // …and the prose that names a script without running it is gone from view.
    expect(executed).not.toContain('chained from');
  });
});

describe('#2465 — backup-coverage fails closed on volume variables of any name', () => {
  it('flags a bare {{VAR}} hostPath whose name is off the _PATH/_DIR pattern', () => {
    // Pre-fix these returned null and were dropped before the coverage check —
    // not reported as uncovered, invisible.
    expect(toCoverageKey('{{MEDIA_ROOT}}')).toBe('MEDIA_ROOT');
    expect(toCoverageKey('{{PHOTOS}}')).toBe('PHOTOS');
    expect(toCoverageKey('{{JELLYFIN_MEDIA_PATH}}')).toBe('JELLYFIN_MEDIA_PATH');
  });

  it('exempts only the explicit non-volume patterns', () => {
    expect(toCoverageKey('{{ZWAVE_DEVICE}}')).toBeNull();
    expect(toCoverageKey('{{USB_DEVICES}}')).toBeNull();
    expect(toCoverageKey('{{DOCKER_SOCKET}}')).toBeNull();
    expect(toCoverageKey('{{HTTP_PORT}}')).toBeNull();
    expect(toCoverageKey('{{DATA_DIR}}')).toBeNull(); // the root, not a leaf volume
    expect(toCoverageKey('/run/dbus')).toBeNull(); // absolute host path, not our contract
    expect(toCoverageKey('{{DATA_DIR}}/adguard/work/')).toBe('adguard/work');
  });

  it('an off-pattern uncovered volume reaches the uncovered list end to end', () => {
    const yaml = [
      'spec:',
      '  volumes:',
      '    - name: media',
      '      hostPath:',
      '        path: {{MEDIA_ROOT}}',
      '        type: DirectoryOrCreate',
      '    - name: zwave',
      '      hostPath:',
      '        path: {{ZWAVE_DEVICE}}',
      '    - name: conf',
      '      hostPath:',
      '        path: {{DATA_DIR}}/adguard/conf',
    ].join('\n');
    const vols = extractHostPathVolumes('probe', yaml);
    // The device is not a volume at all; the other two are candidates.
    expect(vols.map(v => v.raw)).toEqual(['{{MEDIA_ROOT}}', '{{DATA_DIR}}/adguard/conf']);
    // `adguard/conf` is manifest-covered; the off-pattern variable is not.
    expect(uncoveredVolumes(vols).map(v => v.raw)).toEqual(['{{MEDIA_ROOT}}']);
  });

  it('leaves the volumes the real templates ship covered (no false positives)', () => {
    const templatesDir = path.join(REPO_ROOT, 'templates');
    const vols = readdirSync(templatesDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .flatMap(e => {
        const f = path.join(templatesDir, e.name, 'template.yml');
        return existsSync(f) ? extractHostPathVolumes(e.name, readFileSync(f, 'utf-8')) : [];
      });
    expect(vols.length).toBeGreaterThan(10);
    expect(uncoveredVolumes(vols)).toEqual([]);
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
