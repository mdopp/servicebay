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
  extractTemplateVolumes,
  uncoveredVolumes,
  unknownGateManifests,
  unknownVolumeManifests,
  shippedTemplateNames,
  TemplateScanError,
  EPHEMERAL_VOLUME_KINDS,
} from '../../scripts/check-backup-coverage';
import {
  SERVICE_BACKUP_MANIFESTS,
  getBackupGate,
} from '../../packages/backend/src/lib/externalBackup/serviceManifest';
import { SERVICE_BACKUP_MANIFESTS as WORKER_MANIFESTS } from '../../packages/backup-worker/src/engine/serviceManifest';

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
      'kind: Pod',
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
    const { volumes } = extractTemplateVolumes('probe', yaml);
    // The device is not a volume at all; the other two are candidates.
    expect(volumes.map(v => v.raw)).toEqual(['{{MEDIA_ROOT}}', '{{DATA_DIR}}/adguard/conf']);
    // `adguard/conf` is manifest-covered; the off-pattern variable is not.
    expect(uncoveredVolumes(volumes).map(v => v.raw)).toEqual(['{{MEDIA_ROOT}}']);
  });

  it('leaves the volumes the real templates ship covered (no false positives)', () => {
    expect(realTemplateScan.volumes.length).toBeGreaterThan(10);
    expect(uncoveredVolumes(realTemplateScan.volumes)).toEqual([]);
  });
});

/** Every shipped template, scanned exactly as the gate scans it. */
const realTemplateScan = (() => {
  const templatesDir = path.join(REPO_ROOT, 'templates');
  const volumes = [];
  const unclassified = [];
  for (const e of readdirSync(templatesDir, { withFileTypes: true })) {
    const f = path.join(templatesDir, e.name, 'template.yml');
    if (!e.isDirectory() || !existsSync(f)) continue;
    const scan = extractTemplateVolumes(e.name, readFileSync(f, 'utf-8'));
    volumes.push(...scan.volumes);
    unclassified.push(...scan.unclassified);
  }
  return { volumes, unclassified };
})();

describe('#2596 — the coverage gate can SEE a podman named volume, and fails on an uncovered one', () => {
  /**
   * The fourth way a gate lies, and the worst: it reports green about a question
   * it never asked. The pre-fix scan grepped `hostPath:` blocks, so a template
   * that kept real config in a `PersistentVolumeClaim` did not come out
   * "uncovered" — it never entered the check. `file-share`'s syncthing-config
   * PVC (Syncthing's device identity + folder shares) sat outside the contract
   * that way while `check:backup-coverage` printed ✓.
   */
  const PVC_YAML = [
    'kind: Pod',
    'spec:',
    '  volumes:',
    '    - name: syncthing-config',
    '      persistentVolumeClaim:',
    '        claimName: file-share-syncthing-config',
    '    - name: rogue-config',
    '      persistentVolumeClaim:',
    '        claimName: some-template-unbacked-config',
  ].join('\n');

  it('extracts PersistentVolumeClaim volumes, not just hostPath ones', () => {
    const { volumes } = extractTemplateVolumes('probe', PVC_YAML);
    expect(volumes.map(v => [v.kind, v.key])).toEqual([
      ['persistentVolumeClaim', 'file-share-syncthing-config'],
      ['persistentVolumeClaim', 'some-template-unbacked-config'],
    ]);
  });

  it('FAILS on a volume-held path that no manifest covers (the mutation this gate exists for)', () => {
    const { volumes } = extractTemplateVolumes('probe', PVC_YAML);
    // The covered one is the real manifest's claim; the other is a template
    // reaching for a PVC without deciding anything — exactly what used to pass.
    expect(uncoveredVolumes(volumes).map(v => v.key)).toEqual(['some-template-unbacked-config']);
  });

  it('named-volume coverage is EXACT, not prefix-based (a volume is atomic)', () => {
    // `file-share-syncthing-config` is covered; a sibling volume sharing its
    // prefix is a different volume and must NOT ride along on that match.
    const yaml = [
      'kind: Pod',
      'spec:',
      '  volumes:',
      '    - name: c',
      '      persistentVolumeClaim:',
      '        claimName: file-share-syncthing-config-extra',
    ].join('\n');
    const { volumes } = extractTemplateVolumes('probe', yaml);
    expect(uncoveredVolumes(volumes)).toHaveLength(1);
  });

  it("file-share's syncthing PVC is covered at HEAD — and by a manifest, not by a skip", () => {
    const pvcs = realTemplateScan.volumes.filter(v => v.kind === 'persistentVolumeClaim');
    // The gate actually looked at it (the pre-fix scan found zero PVCs).
    expect(pvcs.map(v => v.key)).toContain('file-share-syncthing-config');
    expect(uncoveredVolumes(pvcs)).toEqual([]);
    const syncthing = SERVICE_BACKUP_MANIFESTS.find(m => m.service === 'syncthing');
    expect(syncthing?.volume).toBe('file-share-syncthing-config');
    expect(syncthing?.include).toContain('config.xml');
    // The device ID is derived from the certificate — config.xml alone would
    // still cost every paired peer a manual re-trust.
    expect(syncthing?.include).toEqual(expect.arrayContaining(['cert.pem', 'key.pem']));
  });

  it('drops the syncthing manifest → the PVC goes uncovered (mutation-verified)', () => {
    // Prove the green above is earned. `uncoveredVolumes` reads the real
    // manifest list, so mutate the input instead: a claim name nothing covers
    // is the same shape as the syncthing entry not being there.
    const { volumes } = extractTemplateVolumes(
      'probe',
      PVC_YAML.replace('file-share-syncthing-config', 'file-share-syncthing-config-UNMANIFESTED'),
    );
    expect(uncoveredVolumes(volumes)).toHaveLength(2);
  });

  it('a manifest volume that no template declares is a defect, like a dead gate', () => {
    const manifests = [
      { service: 'syncthing', gateOn: 'file-share', volume: 'file-share-syncthing-config', include: ['config.xml'], exclude: [] },
      { service: 'ghost', gateOn: 'file-share', volume: 'no-such-volume', include: ['x'], exclude: [] },
      // `volume` + `dataSubdir` name two different storage locations — one of
      // the two would silently be a lie, so the pair is rejected outright.
      { service: 'both', gateOn: 'file-share', volume: 'file-share-syncthing-config', dataSubdir: 'x', include: ['x'], exclude: [] },
    ];
    expect(unknownVolumeManifests(manifests, ['file-share-syncthing-config'])).toEqual([
      { service: 'ghost', volume: 'no-such-volume' },
      { service: 'both', volume: 'file-share-syncthing-config' },
    ]);
  });

  it('every manifest `volume` at HEAD names a claim a template really declares', () => {
    const claims = realTemplateScan.volumes
      .filter(v => v.kind === 'persistentVolumeClaim')
      .map(v => v.key);
    expect(unknownVolumeManifests(SERVICE_BACKUP_MANIFESTS, claims)).toEqual([]);
  });

  it('a volume kind the gate does not know is an ERROR, never a silent skip', () => {
    const yaml = [
      'kind: Pod',
      'spec:',
      '  volumes:',
      '    - name: mystery',
      '      csi:',
      '        driver: something.example.com',
      '    - name: scratch',
      '      emptyDir: {}',
    ].join('\n');
    const { volumes, unclassified } = extractTemplateVolumes('probe', yaml);
    expect(volumes).toEqual([]);
    // emptyDir is enumerated as stateless WITH a reason; `csi` is not, so it is
    // reported rather than dropped — the gate never guesses that it is safe.
    expect(EPHEMERAL_VOLUME_KINDS).toHaveProperty('emptyDir');
    expect(unclassified.map(u => u.kind)).toEqual(['csi']);
  });

  it('the real templates leave nothing unclassified (the enumeration is complete)', () => {
    expect(realTemplateScan.unclassified).toEqual([]);
    // …and the scan is not vacuous: it saw both storage kinds.
    const kinds = new Set(realTemplateScan.volumes.map(v => v.kind));
    expect([...kinds].sort()).toEqual(['hostPath', 'persistentVolumeClaim']);
  });

  it('a template.yml that will not parse FAILS the gate instead of contributing zero volumes', () => {
    // The "scans nothing" failure shape, template-sized: the old line scan
    // simply found no `hostPath:` lines in a broken file and moved on.
    expect(() => extractTemplateVolumes('probe', 'kind: Pod\nspec:\n  volumes:\n  - name: a\n   bad: [')).toThrow(TemplateScanError);
    expect(() => extractTemplateVolumes('probe', 'kind: ConfigMap\ndata: {}')).toThrow(/no .kind: Pod. document/);
    expect(() => extractTemplateVolumes('probe', 'kind: Pod\nspec:\n  volumes: not-a-list')).toThrow(TemplateScanError);
  });

  it('reads a volume that a mustache section makes conditional (always visible)', () => {
    // A volume only some installs get is still a volume that must be covered,
    // so the section markers are stripped rather than evaluated.
    const yaml = [
      'kind: Pod',
      'spec:',
      '  volumes:',
      '  {{#ZWAVE_DEVICE}}',
      '    - name: stick',
      '      hostPath:',
      '        path: {{ZWAVE_DEVICE}}',
      '  {{/ZWAVE_DEVICE}}',
      '    - name: conf',
      '      hostPath:',
      '        path: {{DATA_DIR}}/adguard/conf',
    ].join('\n');
    const { volumes, unclassified } = extractTemplateVolumes('probe', yaml);
    expect(unclassified).toEqual([]);
    // The stick is a device (exempt by name); the conf dir round-tripped back
    // to its `{{DATA_DIR}}` spelling rather than staying a scan token.
    expect(volumes.map(v => v.raw)).toEqual(['{{DATA_DIR}}/adguard/conf']);
  });
});

describe('#2595 — a backup manifest gating on a name no template has is build-breaking', () => {
  /**
   * The third way a gate lies, alongside "scans nothing" and "runs nowhere":
   * it scans and runs, but the thing it protects opted itself out. A manifest
   * entry activates on an `installedTemplates` KEY, so an entry whose
   * `gateOn ?? service` matches no template name is dormant on every box
   * forever — and looked exactly like a template that merely wasn't installed.
   * That is how authelia / lldap / jellyfin went un-backed-up while the nightly
   * run logged "8/8 services backed up" against a shrunken denominator.
   */
  const templateNames = shippedTemplateNames();

  it('finds the shipped templates at all (the gate is not vacuous)', () => {
    expect(templateNames.length).toBeGreaterThan(5);
    expect(templateNames).toEqual(expect.arrayContaining(['auth', 'media', 'file-share']));
  });

  it('every manifest entry at HEAD gates on a template this repo ships', () => {
    expect(unknownGateManifests(SERVICE_BACKUP_MANIFESTS, templateNames)).toEqual([]);
  });

  it('the worker mirror gates identically — a divergence is the same defect', () => {
    // The worker's copy is what actually SELECTS services for the nightly run
    // (backupWorker/service.ts imports it, not the backend copy), so a gate that
    // is right here and wrong there still loses the backup.
    // Storage location too (#2596): a `volume` set on one side only would make
    // the worker read a stacks path while the gate believes the named volume is
    // covered — the same lie, one level down.
    const shape = (m: { service: string; gateOn?: string; volume?: string; dataSubdir?: string }) =>
      [m.service, m.gateOn ?? m.service, m.volume ?? null, m.dataSubdir ?? null];
    expect(WORKER_MANIFESTS.map(shape)).toEqual(SERVICE_BACKUP_MANIFESTS.map(shape));
  });

  it('the three #2595 entries resolve to the templates that own their data dirs', () => {
    const gateOf = (service: string) =>
      getBackupGate(SERVICE_BACKUP_MANIFESTS.find(m => m.service === service)!);
    // Multi-app templates: `auth` ships authelia + lldap, `media` ships jellyfin.
    expect(gateOf('authelia')).toBe('auth');
    expect(gateOf('lldap')).toBe('auth');
    expect(gateOf('jellyfin')).toBe('media');
    // The sibling-store precedent that was always right stays right.
    expect(gateOf('home-assistant-zwave')).toBe('home-assistant');
    // A single-app template still gates on its own name.
    expect(gateOf('adguard')).toBe('adguard');
  });

  it('flags a permanently-inactive entry but NOT a merely-uninstalled one', () => {
    // The distinction the runtime cannot make. `radicale` here is a real
    // template that a given box may simply not have installed — not a defect.
    const manifests = [
      { service: 'radicale', include: ['collections'], exclude: [] },
      { service: 'jellyfin', dataSubdir: 'media/jellyfin-config', include: ['config'], exclude: [] },
      { service: 'ghost', gateOn: 'nowhere', include: ['x'], exclude: [] },
    ];
    expect(unknownGateManifests(manifests, ['auth', 'media', 'radicale'])).toEqual([
      // jellyfin defaulted its gate to its own name — the exact pre-fix bug.
      { service: 'jellyfin', gate: 'jellyfin', explicit: false },
      // an explicit gateOn pointing nowhere is the same class of defect.
      { service: 'ghost', gate: 'nowhere', explicit: true },
    ]);
  });

  it('would have failed on the pre-fix manifests (the bug is actually caught)', () => {
    const preFix = SERVICE_BACKUP_MANIFESTS.map(m =>
      ['authelia', 'lldap', 'jellyfin'].includes(m.service) ? { ...m, gateOn: undefined } : m,
    );
    expect(unknownGateManifests(preFix, templateNames).map(g => g.service))
      .toEqual(['authelia', 'lldap', 'jellyfin']);
  });

  it('neither retired entry came back under a DEAD gate', () => {
    // Both were removed in #2595 because their gate named no template. `hermes`
    // is the retired Solaris name and stays gone. `syncthing` came back in
    // #2596 — but only because it now gates on the template that actually ships
    // it and reads the podman volume its config really lives in. Re-adding
    // either under its own name would fail the gate above.
    const names = SERVICE_BACKUP_MANIFESTS.map(m => m.service);
    expect(names).not.toContain('hermes');
    expect(existsSync(path.join(REPO_ROOT, 'templates', 'hermes'))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, 'templates', 'syncthing'))).toBe(false);
    const syncthing = SERVICE_BACKUP_MANIFESTS.find(m => m.service === 'syncthing');
    expect(getBackupGate(syncthing!)).toBe('file-share');
    expect(syncthing?.dataSubdir).toBeUndefined(); // it has no DATA_DIR path at all
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
