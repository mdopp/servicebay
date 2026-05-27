/**
 * Template asset-file discovery (#1156).
 *
 * A template that ships a `skills/` subdirectory under its template
 * dir gets each file packaged as a `TemplateConfigFile` with
 * `renderContent: false` and `targetPath` set to
 * `{{DATA_DIR}}/<template-name>/skills/<relpath>`. The install runner
 * concatenates these alongside the regular `.mustache` config files
 * and the existing `extraFiles` transport ships them to the agent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

// REGISTRIES_DIR is computed from CONTAINER_CONFIG_DIR at module load;
// set it before importing registry.ts. Same pattern as
// registry.manifest.test.ts.
const TEST_ROOT = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path');
  const root = _path.join(_os.tmpdir(), `sb-registry-assets-${process.pid}`);
  process.env.CONTAINER_CONFIG_DIR = root;
  return root;
});

const mockConfigState = { registries: { enabled: true, items: [] as Array<{ name: string; url: string }> } };
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState),
}));

import {
  getTemplateAssetFiles,
  _resetRegistryManifestCacheForTests,
} from './registry';

const REG_DIR = path.join(TEST_ROOT, 'registries');

async function seed(regName: string, layout: Record<string, string>): Promise<void> {
  const regRoot = path.join(REG_DIR, regName);
  for (const [relPath, content] of Object.entries(layout)) {
    const full = path.join(regRoot, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

beforeEach(async () => {
  await fs.rm(REG_DIR, { recursive: true, force: true });
  await fs.mkdir(REG_DIR, { recursive: true });
  mockConfigState.registries.items = [];
  _resetRegistryManifestCacheForTests();
});

describe('getTemplateAssetFiles', () => {
  it('returns an empty list for a template with no skills/ dir', async () => {
    await seed('oscar', {
      'templates/oscar-household/template.yml': 'apiVersion: v1\nkind: Pod\n',
    });
    const out = await getTemplateAssetFiles('oscar-household', 'oscar');
    expect(out).toEqual([]);
  });

  it('walks skills/ recursively and emits one entry per file', async () => {
    await seed('oscar', {
      'templates/oscar-household/template.yml': 'apiVersion: v1\nkind: Pod\n',
      'templates/oscar-household/skills/audit-query/SKILL.md': '# audit-query\n',
      'templates/oscar-household/skills/audit-query/helper.py': 'print("hi")\n',
      'templates/oscar-household/skills/status/SKILL.md': '# status\n',
    });
    const out = await getTemplateAssetFiles('oscar-household', 'oscar');
    const byName = Object.fromEntries(out.map(f => [f.filename, f]));
    expect(Object.keys(byName).sort()).toEqual([
      path.join('skills', 'audit-query', 'SKILL.md'),
      path.join('skills', 'audit-query', 'helper.py'),
      path.join('skills', 'status', 'SKILL.md'),
    ]);
    expect(byName[path.join('skills', 'audit-query', 'SKILL.md')].content).toBe('# audit-query\n');
  });

  it('sets renderContent: false on every entry (assets ship verbatim)', async () => {
    await seed('oscar', {
      'templates/oscar-household/skills/audit-query/SKILL.md': '# audit-query — `{{cost}}` is documentation, not a placeholder\n',
    });
    const out = await getTemplateAssetFiles('oscar-household', 'oscar');
    expect(out).toHaveLength(1);
    expect(out[0].renderContent).toBe(false);
  });

  it('resolves targetPath to {{DATA_DIR}}/<template>/skills/<relpath>', async () => {
    await seed('oscar', {
      'templates/oscar-household/skills/dynamic-skills/SKILL.md': 'x',
    });
    const out = await getTemplateAssetFiles('oscar-household', 'oscar');
    expect(out[0].targetPath).toBe('{{DATA_DIR}}/oscar-household/skills/dynamic-skills/SKILL.md');
  });

  it('ignores dotfiles and dot-directories', async () => {
    await seed('oscar', {
      'templates/oscar-household/skills/.hidden/SKILL.md': 'should be skipped',
      'templates/oscar-household/skills/status/.gitkeep': 'should also be skipped',
      'templates/oscar-household/skills/status/SKILL.md': 'kept',
    });
    const out = await getTemplateAssetFiles('oscar-household', 'oscar');
    const names = out.map(f => f.filename);
    expect(names).toEqual([path.join('skills', 'status', 'SKILL.md')]);
  });

  it('walks each configured registry and returns the first match', async () => {
    await seed('first', {
      'templates/foo/template.yml': 'apiVersion: v1\nkind: Pod\n',
    });
    await seed('second', {
      'templates/foo/template.yml': 'apiVersion: v1\nkind: Pod\n',
      'templates/foo/skills/only-here/SKILL.md': 'found in second',
    });
    mockConfigState.registries.items.push({ name: 'first', url: 'http://x/first.git' });
    mockConfigState.registries.items.push({ name: 'second', url: 'http://x/second.git' });

    const out = await getTemplateAssetFiles('foo');
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('found in second');
  });

  it('respects a pinned source — only that registry is consulted', async () => {
    await seed('first', {
      'templates/foo/skills/x/SKILL.md': 'in first',
    });
    await seed('second', {
      'templates/foo/skills/x/SKILL.md': 'in second',
    });
    mockConfigState.registries.items.push({ name: 'first', url: 'http://x/first.git' });
    mockConfigState.registries.items.push({ name: 'second', url: 'http://x/second.git' });

    const fromFirst = await getTemplateAssetFiles('foo', 'first');
    expect(fromFirst[0].content).toBe('in first');
    const fromSecond = await getTemplateAssetFiles('foo', 'second');
    expect(fromSecond[0].content).toBe('in second');
  });
});
