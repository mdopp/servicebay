import { describe, it, expect } from 'vitest';
import {
  isPathMandated,
  PATH_MANDATED_PATHS,
  durableStateEffects,
  gateDecision,
  parseAddedLines,
  type ChangedFile,
} from './autoloop-seal';

describe('isPathMandated', () => {
  it('matches install/deploy path files (this session: #2296 runner.ts)', () => {
    expect(isPathMandated('packages/backend/src/lib/install/runner.ts')).toBe(true);
    expect(isPathMandated('packages/backend/src/lib/config.ts')).toBe(true);
    expect(isPathMandated('packages/backend/src/lib/systemBackup.ts')).toBe(true);
  });

  it('matches the NPM-render + proxy-gate files this session proved need verify', () => {
    // #2278/#2281 forward-auth render + proxy gate — absent from the old builder.md list.
    expect(isPathMandated('packages/backend/src/lib/stackInstall/forwardAuth.ts')).toBe(true);
    expect(isPathMandated('packages/backend/src/lib/portal/provisioner.ts')).toBe(true);
    expect(isPathMandated('packages/frontend/src/proxy.ts')).toBe(true);
  });

  it('matches the /napi companion surface (mutating device routes — #2313)', () => {
    expect(isPathMandated('packages/frontend/src/app/napi/services/[name]/upgrade/route.ts')).toBe(true);
    expect(isPathMandated('packages/frontend/src/app/napi/services/[name]/operate/route.ts')).toBe(true);
    expect(isPathMandated('packages/frontend/src/app/napi/upgrades/route.ts')).toBe(true);
  });

  it('matches user-facing surfaces (portal / dashboard / the wizard file)', () => {
    expect(isPathMandated('packages/frontend/src/app/portal/PortalGrid.tsx')).toBe(true);
    expect(isPathMandated('packages/frontend/src/app/(dashboard)/settings/page.tsx')).toBe(true);
    expect(isPathMandated('packages/frontend/src/components/OnboardingWizard.tsx')).toBe(true);
  });

  it('does NOT match unrelated / pure-logic files', () => {
    expect(isPathMandated('packages/backend/src/lib/auth/apiTokens.ts')).toBe(false);
    expect(isPathMandated('packages/backend/src/lib/stackInstall/nginxScratchValidate.ts')).toBe(true); // stackInstall/ IS mandated
    expect(isPathMandated('scripts/autoloop-seal.ts')).toBe(false);
    expect(isPathMandated('docs/ARCHITECTURE_INVARIANTS.md')).toBe(false);
    expect(isPathMandated('packages/frontend/src/hooks/useServiceActions.tsx')).toBe(false);
  });

  it('exact-matches file entries, prefix-matches directory entries', () => {
    // proxy.ts is an exact file entry — a sibling must NOT match.
    expect(isPathMandated('packages/frontend/src/proxyOther.ts')).toBe(false);
    // config.ts exact — config.helper.ts must NOT match.
    expect(isPathMandated('packages/backend/src/lib/configLoader.ts')).toBe(false);
  });

  it('every directory entry ends with a slash and every list entry is under packages/', () => {
    for (const p of PATH_MANDATED_PATHS) {
      expect(p.startsWith('packages/')).toBe(true);
      // a heuristic guard: entries without an extension must be directories (trailing /)
      const last = p.split('/').pop() ?? '';
      if (!last.includes('.')) expect(p.endsWith('/')).toBe(true);
    }
  });
});

/**
 * The EFFECT axis (#2700). The gate used to key on *place* only, so identical
 * work got different verdicts depending on which folder it landed in. These
 * cases are the transfer of the reversibility axis already used by the
 * permission ladder (apiScope.ts / docs/SCOPE_AUDIT.md) onto the release gate.
 */
describe('durable-state effects — the gate keys on what the change DOES', () => {
  /** The real file list of the claude-dev schema 2→3 bump (commit b1ed6997):
   *  a data migration on every installed copy of the service. NOT ONE of these
   *  paths is in PATH_MANDATED_PATHS — that is the whole defect. */
  const claudeDevSchemaBump: ChangedFile[] = [
    { path: '.github/workflows/claude-dev-image.yml' },
    { path: 'templates/claude-dev/CHANGELOG.md' },
    { path: 'templates/claude-dev/Dockerfile' },
    { path: 'templates/claude-dev/README.md' },
    { path: 'templates/claude-dev/config-ui/public/index.html' },
    { path: 'templates/claude-dev/config-ui/server.mjs' },
    { path: 'templates/claude-dev/docker-entrypoint.sh' },
    { path: 'templates/claude-dev/migrations/v2-to-v3.py' },
    { path: 'templates/claude-dev/template.yml', addedLines: ['    servicebay.schema-version: "3"'] },
    { path: 'templates/claude-dev/variables.json' },
    { path: 'tests/backend/claude_dev_config_ui.test.ts' },
    { path: 'tests/templates/claude_dev_entrypoint_test.sh' },
  ];

  it('the place gate is BLIND to the claude-dev schema bump (the defect, pinned)', () => {
    // No path removal needed to reproduce the acceptance case: none of the
    // migration's files was ever in the directory list to begin with.
    expect(claudeDevSchemaBump.map(c => c.path).filter(isPathMandated)).toEqual([]);
  });

  it('but the effect gate trips on it — migration script AND the schema-version bump', () => {
    const gate = gateDecision(claudeDevSchemaBump);
    expect(gate.pathMandated).toEqual([]);
    expect(gate.boxVerifyOwed).toBe(true);
    expect(gate.effects.map(e => `${e.kind} @ ${e.path}`)).toEqual([
      'template-schema-migration @ templates/claude-dev/migrations/v2-to-v3.py',
      'template-schema-migration @ templates/claude-dev/template.yml',
    ]);
    expect(gate.detail).toContain('durable-state effect');
  });

  it('names a template upgrade script by what it is, in any template', () => {
    for (const f of [
      'templates/auth/migrations/v3-to-v4.py',
      'templates/immich/migrations/v2-to-v3.py',
      'templates/some-future-service/migrations/v9-to-v10.sh',
    ]) {
      expect(durableStateEffects([{ path: f }])).toHaveLength(1);
    }
    // a template file that is NOT an upgrade script stays clear
    expect(durableStateEffects([{ path: 'templates/auth/README.md' }])).toEqual([]);
    expect(durableStateEffects([{ path: 'templates/auth/post-deploy.py' }])).toEqual([]);
  });

  it('trips on a saved-secrets store write', () => {
    const effects = durableStateEffects([
      { path: 'packages/backend/src/lib/secrets.ts', addedLines: ['  const key = regenerateSecretKey();'] },
    ]);
    expect(effects.map(e => e.kind)).toEqual(['secret-store-write']);
    // the on-disk envelope is the other half of the same store
    expect(
      durableStateEffects([{ path: 'packages/backend/src/lib/somewhereElse.ts', addedLines: ["const PREFIX = 'enc:';"] }]).map(e => e.kind),
    ).toEqual(['secret-store-write']);
  });

  it('trips on an installed-manifest write, wherever it lives', () => {
    for (const line of [
      '  config.installedTemplates = next;',
      '      this.installedTemplates = next;',
      '  config.installedTemplates[name].schemaVersion = version;',
      '  delete config.installedTemplates[name];',
    ]) {
      expect(durableStateEffects([{ path: 'packages/backend/src/lib/anywhere.ts', addedLines: [line] }]).map(e => e.kind)).toEqual([
        'installed-manifest-write',
      ]);
    }
    // a read is not a write — reversibility is the axis, not the identifier
    expect(
      durableStateEffects([{ path: 'packages/backend/src/lib/anywhere.ts', addedLines: ['  const t = config.installedTemplates ?? {};'] }]),
    ).toEqual([]);
  });

  it('tests, prose and the gate itself describe an effect, they do not have one', () => {
    expect(
      durableStateEffects([
        { path: 'tests/backend/foo.test.ts', addedLines: ['config.installedTemplates = next;'] },
        { path: 'packages/backend/src/lib/config.race.test.ts', addedLines: ["const PREFIX = 'enc:';"] },
        { path: 'templates/claude-dev/migrations/__pycache__/v2-to-v3.py', addedLines: [] },
        // docs quoting a marker are prose, not a migration
        { path: 'docs/SCOPE_AUDIT.md', addedLines: ['| `servicebay.schema-version` | a template schema bump |'] },
        // and the gate's own source spells out every marker it looks for
        { path: 'scripts/autoloop-seal.ts', addedLines: ['  re: /servicebay\\.schema-version/,'] },
      ]),
    ).toEqual([]);
  });

  it('a change with neither place nor effect owes nothing', () => {
    const gate = gateDecision([
      { path: 'docs/ARCHITECTURE_INVARIANTS.md', addedLines: ['- a new invariant'] },
      { path: 'scripts/autoloop-seal.ts', addedLines: ['const x = 1;'] },
    ]);
    expect(gate.boxVerifyOwed).toBe(false);
    expect(gate.detail).toBe('');
  });

  it('the place gate still stands on its own — both axes, not a replacement', () => {
    const gate = gateDecision([{ path: 'packages/backend/src/lib/install/runner.ts', addedLines: ['const x = 1;'] }]);
    expect(gate.pathMandated).toEqual(['packages/backend/src/lib/install/runner.ts']);
    expect(gate.effects).toEqual([]);
    expect(gate.boxVerifyOwed).toBe(true);
  });
});

describe('parseAddedLines', () => {
  it('keys added lines by file and ignores hunk/rename noise', () => {
    const diff = [
      'diff --git a/templates/claude-dev/template.yml b/templates/claude-dev/template.yml',
      'index 111..222 100644',
      '--- a/templates/claude-dev/template.yml',
      '+++ b/templates/claude-dev/template.yml',
      '@@ -18 +18 @@',
      '-    servicebay.schema-version: "2"',
      '+    servicebay.schema-version: "3"',
      'diff --git a/templates/claude-dev/migrations/v2-to-v3.py b/templates/claude-dev/migrations/v2-to-v3.py',
      'new file mode 100755',
      '--- /dev/null',
      '+++ b/templates/claude-dev/migrations/v2-to-v3.py',
      '@@ -0,0 +1 @@',
      '+import os',
    ].join('\n');
    const added = parseAddedLines(diff);
    expect(added.get('templates/claude-dev/template.yml')).toEqual(['    servicebay.schema-version: "3"']);
    expect(added.get('templates/claude-dev/migrations/v2-to-v3.py')).toEqual(['import os']);
  });

  it('a deletion-only diff yields no added lines (degrades to the path rules)', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n');
    expect([...parseAddedLines(diff).keys()]).toEqual([]);
  });
});
