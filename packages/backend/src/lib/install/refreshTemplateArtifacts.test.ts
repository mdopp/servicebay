/**
 * #2530 — `install_template` dropped a new env-var block when the variable
 * name was reused across two containers of one pod.
 *
 * The reported cause ("something dedupes env entries by variable NAME across
 * the whole pod") does not exist: `renderPodYaml` emits every occurrence.
 * The real cause is staleness — `assembleManifest` reads `template.yml` when
 * the MANIFEST is built, while the registry pull (#1806) runs later, at the
 * start of the deploy. So the spec that gets rendered is always one sync
 * behind, and a reinstall replaying a saved manifest can be far further behind.
 * The first test below pins the renderer's innocence; the rest cover the fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTemplateYaml = vi.fn<(n: string, s?: string) => Promise<string | null>>();
const getTemplateConfigFiles = vi.fn<(n: string, s?: string) => Promise<{ filename: string; content: string; targetPath?: string }[]>>();
const getTemplateAssetFiles = vi.fn<(n: string, s?: string) => Promise<{ filename: string; content: string; targetPath?: string; renderContent?: boolean }[]>>();
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: (n: string, s?: string) => getTemplateYaml(n, s),
  getTemplateVariables: vi.fn(async () => ({})),
  getTemplateConfigFiles: (n: string, s?: string) => getTemplateConfigFiles(n, s),
  getTemplateAssetFiles: (n: string, s?: string) => getTemplateAssetFiles(n, s),
  getTemplateSettingsSchema: vi.fn(async () => ({})),
}));
vi.mock('@/lib/config', () => ({ getConfig: vi.fn(async () => ({})) }));
vi.mock('./savedSecrets', () => ({
  loadSavedSecrets: () => ({}),
  persistSingleSecret: async () => true,
}));

import { refreshTemplateArtifacts } from './manifestAssembler';
import { renderPodYaml } from '@/lib/template/render';
import type { JobInputItem } from './jobStore';

/** The reported shape: one variable NAME declared in two containers of one
 *  pod. `chat` is the container the entry was newly added to. */
const FRESH_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: solaris
spec:
  containers:
  - name: chat
    image: example/chat:latest
    env:
    - name: DEFAULT_UID
      value: "{{DEFAULT_UID}}"
    # The same speaker-ID flag the gatekeeper runs on.
    - name: SOLARIS_SPEAKER_ID_ENABLED
      value: "{{SOLARIS_SPEAKER_ID_ENABLED}}"
    - name: SKILLS_DIR
      value: "/data/skills"
  - name: gatekeeper
    image: example/gatekeeper:latest
    env:
    - name: SOLARIS_SPEAKER_ID_ENABLED
      value: "{{SOLARIS_SPEAKER_ID_ENABLED}}"
`;

/** The same template as it stood before the entry was added to `chat` —
 *  i.e. what a manifest assembled before the registry sync still carries. */
const STALE_YAML = FRESH_YAML
  .replace(/    # The same speaker-ID flag the gatekeeper runs on\.\n    - name: SOLARIS_SPEAKER_ID_ENABLED\n      value: "\{\{SOLARIS_SPEAKER_ID_ENABLED\}\}"\n/, '');

function item(partial: Partial<JobInputItem> = {}): JobInputItem {
  return { name: 'solaris', checked: true, yaml: STALE_YAML, ...partial };
}

/** Names of the containers whose `env:` block carries `varName`. */
function containersWithEnv(yaml: string, varName: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s*name:\s*(\S+)\s*$/.exec(line);
    if (m && /^\s{2}-\s/.test(line)) current = m[1];
    else if (m && m[1] === varName) out.push(current);
  }
  return out;
}

beforeEach(() => {
  getTemplateYaml.mockReset();
  getTemplateConfigFiles.mockReset();
  getTemplateConfigFiles.mockResolvedValue([]);
  getTemplateAssetFiles.mockReset();
  getTemplateAssetFiles.mockResolvedValue([]);
});

describe('renderPodYaml is not the culprit (#2530 premise check)', () => {
  it('renders a reused variable name in BOTH containers of one pod', () => {
    const out = renderPodYaml(FRESH_YAML, { DEFAULT_UID: '1000', SOLARIS_SPEAKER_ID_ENABLED: 'false' });
    expect(containersWithEnv(out, 'SOLARIS_SPEAKER_ID_ENABLED')).toEqual(['chat', 'gatekeeper']);
  });

  it('drops the entry when handed the STALE template — the actual failure', () => {
    const out = renderPodYaml(STALE_YAML, { DEFAULT_UID: '1000', SOLARIS_SPEAKER_ID_ENABLED: 'false' });
    expect(containersWithEnv(out, 'SOLARIS_SPEAKER_ID_ENABLED')).toEqual(['gatekeeper']);
  });
});

describe('refreshTemplateArtifacts (#2530)', () => {
  it('re-reads the registry spec so BOTH containers render the reused variable', async () => {
    getTemplateYaml.mockResolvedValue(FRESH_YAML);
    const items = [item()];

    const result = await refreshTemplateArtifacts(items, 'Solaris');

    expect(result).toEqual({ updated: ['solaris'], unresolved: [] });
    const rendered = renderPodYaml(items[0].yaml!, { DEFAULT_UID: '1000', SOLARIS_SPEAKER_ID_ENABLED: 'false' });
    expect(containersWithEnv(rendered, 'SOLARIS_SPEAKER_ID_ENABLED')).toEqual(['chat', 'gatekeeper']);
    expect(rendered).toContain('value: "false"');
  });

  it('reports nothing updated when the registry spec already matches', async () => {
    getTemplateYaml.mockResolvedValue(STALE_YAML);
    const items = [item()];
    expect(await refreshTemplateArtifacts(items, 'Solaris')).toEqual({ updated: [], unresolved: [] });
  });

  it('refreshes the config/asset files alongside the yaml', async () => {
    getTemplateYaml.mockResolvedValue(FRESH_YAML);
    getTemplateConfigFiles.mockResolvedValue([{ filename: 'app.conf', content: 'new body' }]);
    getTemplateAssetFiles.mockResolvedValue([
      { filename: 'skills/x.md', content: 'asset', renderContent: false },
    ]);
    const items = [item({ configFiles: [{ filename: 'app.conf', content: 'stale body' }] })];

    await refreshTemplateArtifacts(items, 'Solaris');

    expect(items[0].configFiles).toEqual([
      { filename: 'app.conf', content: 'new body', targetPath: undefined, renderContent: undefined },
      { filename: 'skills/x.md', content: 'asset', targetPath: undefined, renderContent: false },
    ]);
  });

  it('drops config files the template no longer ships', async () => {
    getTemplateYaml.mockResolvedValue(FRESH_YAML);
    const items = [item({ configFiles: [{ filename: 'gone.conf', content: 'stale' }] })];
    await refreshTemplateArtifacts(items, 'Solaris');
    expect(items[0].configFiles).toBeUndefined();
  });

  it('refreshes the declared install-time dependencies too', async () => {
    getTemplateYaml.mockResolvedValue(
      FRESH_YAML.replace('  name: solaris', '  name: solaris\n  annotations:\n    servicebay.dependencies: "auth,nginx"'),
    );
    const items = [item({ dependencies: ['nginx'] })];
    await refreshTemplateArtifacts(items, 'Solaris');
    expect(items[0].dependencies).toEqual(['auth', 'nginx']);
  });

  it('falls back to walking every source when the pinned source has nothing', async () => {
    // The MCP install_template path records the DEFAULTED 'Built-in' source on
    // the JobInput even for an external-registry template — resolving against
    // it alone would find nothing and strand the stale spec.
    getTemplateYaml.mockImplementation(async (_n, s) => (s === undefined ? FRESH_YAML : null));
    const items = [item()];

    const result = await refreshTemplateArtifacts(items, 'Built-in');

    expect(result.unresolved).toEqual([]);
    expect(items[0].yaml).toBe(FRESH_YAML);
  });

  it('reports an unresolvable template instead of silently deploying the stale spec', async () => {
    getTemplateYaml.mockResolvedValue(null);
    const items = [item()];

    const result = await refreshTemplateArtifacts(items, 'Solaris');

    expect(result).toEqual({ updated: [], unresolved: ['solaris'] });
    // The manifest's own spec is kept — a known-good previous value, not a
    // substituted default — and the caller logs the condition.
    expect(items[0].yaml).toBe(STALE_YAML);
  });

  it('never hands a spec to an item the assembler deliberately skipped', async () => {
    // `alreadyInstalled` items carry no yaml — giving them one here would make
    // the runner deploy a service this run never intended to touch.
    getTemplateYaml.mockResolvedValue(FRESH_YAML);
    const items = [item({ yaml: undefined, alreadyInstalled: true })];

    await refreshTemplateArtifacts(items, 'Solaris');

    expect(items[0].yaml).toBeUndefined();
    expect(getTemplateYaml).not.toHaveBeenCalled();
  });

  it('skips unchecked items', async () => {
    getTemplateYaml.mockResolvedValue(FRESH_YAML);
    const items = [item({ checked: false })];
    await refreshTemplateArtifacts(items, 'Solaris');
    expect(items[0].yaml).toBe(STALE_YAML);
  });
});
