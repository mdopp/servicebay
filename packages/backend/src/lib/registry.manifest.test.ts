/**
 * Manifest-aware registry resolution (#1050 scaffolding).
 *
 * A registry MAY ship a `servicebay.json` at its root declaring where
 * its templates and stacks live. Registries without a manifest keep
 * using the legacy `templates/<name>/` / `stacks/<name>/` convention,
 * so existing `mdopp/servicebay` and `mdopp/servicebay-templates`
 * keep working untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

// REGISTRIES_DIR is computed from CONTAINER_CONFIG_DIR at module load.
// vi.hoisted runs before the test file's `import`s so the env var is in
// place by the time registry.ts evaluates its top-level constants.
const TEST_ROOT = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path');
  const root = _path.join(_os.tmpdir(), `sb-registry-manifest-${process.pid}`);
  process.env.CONTAINER_CONFIG_DIR = root;
  return root;
});

// Mock config so getRegistries returns the test registries without
// pulling in the on-disk config.json the real getConfig wants.
const mockConfigState = { registries: { enabled: true, items: [] as Array<{ name: string; url: string }> } };
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState),
}));

import {
  getTemplates,
  getReadme,
  getTemplateYaml,
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
  // Drop the in-process manifest cache so tests reusing a registry
  // name see the disk content they just seeded, not a stale cached
  // manifest from a prior case.
  _resetRegistryManifestCacheForTests();
});

describe('legacy layout (no manifest)', () => {
  it('finds templates under templates/<name>/', async () => {
    await seed('legacy-reg', {
      'templates/foo/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: foo\n  annotations:\n    servicebay.label: "foo"\n    servicebay.ports: "8080/tcp"\n    servicebay.schema-version: "1"\n',
      'templates/foo/README.md': 'foo readme',
    });
    mockConfigState.registries.items.push({ name: 'legacy-reg', url: 'http://example/legacy.git' });

    const templates = await getTemplates();
    const foo = templates.find(t => t.name === 'foo' && t.source === 'legacy-reg');
    expect(foo).toBeDefined();
    expect(foo!.type).toBe('template');

    const readme = await getReadme('foo', 'template', 'legacy-reg');
    expect(readme).toBe('foo readme');
  });
});

describe('manifest layout (servicebay.json present)', () => {
  it('resolves a template declared at a custom path', async () => {
    // OSCAR-shaped layout: servicebay-template/ at root, declared via manifest.
    await seed('oscar', {
      'servicebay.json': JSON.stringify({
        templates: [{ name: 'oscar-household', path: 'servicebay-template' }],
      }),
      'servicebay-template/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: oscar-household\n  annotations:\n    servicebay.label: "OSCAR Household"\n    servicebay.ports: "10700/tcp"\n    servicebay.schema-version: "1"\n',
      'servicebay-template/README.md': 'oscar household readme',
    });
    mockConfigState.registries.items.push({ name: 'oscar', url: 'http://example/oscar.git' });

    const templates = await getTemplates();
    const oh = templates.find(t => t.name === 'oscar-household' && t.source === 'oscar');
    expect(oh).toBeDefined();
    expect(oh!.path).toBe(path.join(REG_DIR, 'oscar', 'servicebay-template'));

    const readme = await getReadme('oscar-household', 'template', 'oscar');
    expect(readme).toBe('oscar household readme');

    const yaml = await getTemplateYaml('oscar-household', 'oscar');
    expect(yaml).toContain('name: oscar-household');
  });

  it('does NOT find the same template under the legacy templates/<name>/ path when manifest declares only the custom path', async () => {
    // Mixed-state guard: a registry author who renames the dir but
    // forgets to update the manifest shouldn't end up exposing both
    // shapes. Manifest entries are authoritative when present.
    await seed('oscar', {
      'servicebay.json': JSON.stringify({
        templates: [{ name: 'oscar-household', path: 'servicebay-template' }],
      }),
      'servicebay-template/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: oscar-household\n  annotations:\n    servicebay.label: "OSCAR Household"\n    servicebay.ports: "10700/tcp"\n    servicebay.schema-version: "1"\n',
      // A leftover legacy path that should NOT be picked up since the
      // manifest names a different location.
      'templates/oscar-household/README.md': 'leftover from before the move',
    });
    mockConfigState.registries.items.push({ name: 'oscar', url: 'http://example/oscar.git' });

    const readme = await getReadme('oscar-household', 'template', 'oscar');
    // README from the manifest-declared path, not the legacy one
    expect(readme).not.toBe('leftover from before the move');
  });

  it('falls back to scanning stacks/ when manifest declares only templates', async () => {
    // A registry can ship a manifest for templates only and let stacks
    // keep using the legacy convention.
    await seed('mixed', {
      'servicebay.json': JSON.stringify({
        templates: [{ name: 'foo', path: 'foo-dir' }],
      }),
      'foo-dir/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: foo\n  annotations:\n    servicebay.label: "foo"\n    servicebay.ports: "1/tcp"\n    servicebay.schema-version: "1"\n',
      'stacks/legacy-stack/README.md': 'stack readme',
    });
    mockConfigState.registries.items.push({ name: 'mixed', url: 'http://example/mixed.git' });

    const templates = await getTemplates();
    const foo = templates.find(t => t.name === 'foo' && t.source === 'mixed');
    const legacyStack = templates.find(t => t.name === 'legacy-stack' && t.source === 'mixed');
    expect(foo).toBeDefined();
    expect(legacyStack).toBeDefined();
    expect(legacyStack!.type).toBe('stack');
  });

  it('skips a manifest entry that points at a missing directory without crashing the registry', async () => {
    // Stale manifest survival: declaring a path that doesn't exist on
    // disk (sparse-checkout glitch, half-applied rename) must NOT take
    // down enumeration of the other registries.
    await seed('oscar', {
      'servicebay.json': JSON.stringify({
        templates: [
          { name: 'oscar-household', path: 'servicebay-template' },
          { name: 'ghost', path: 'never-existed' },
        ],
      }),
      'servicebay-template/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: oscar-household\n  annotations:\n    servicebay.label: "OSCAR Household"\n    servicebay.ports: "10700/tcp"\n    servicebay.schema-version: "1"\n',
    });
    mockConfigState.registries.items.push({ name: 'oscar', url: 'http://example/oscar.git' });

    const templates = await getTemplates();
    const oh = templates.find(t => t.name === 'oscar-household' && t.source === 'oscar');
    const ghost = templates.find(t => t.name === 'ghost' && t.source === 'oscar');
    expect(oh).toBeDefined();
    expect(ghost).toBeUndefined();
  });
});

describe('path-injection barrier (CodeQL js/path-injection, #2257)', () => {
  it('rejects a traversal item name against a registry source', async () => {
    // Plant a sensitive file above the registry root.
    const secretPath = path.join(REG_DIR, 'secret.txt');
    await fs.writeFile(secretPath, 'TOP SECRET');
    await seed('legacy-reg', {
      'templates/foo/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: foo\n',
      'templates/foo/README.md': 'foo readme',
    });
    mockConfigState.registries.items.push({ name: 'legacy-reg', url: 'http://example/legacy.git' });

    // A crafted item name that would resolve outside the registry root must
    // fail closed to null, never returning the secret's contents.
    for (const evil of ['../../secret', '../secret', '..', '.', 'a/b', 'a\\b', 'foo/../../secret']) {
      expect(await getReadme(evil, 'template', 'legacy-reg')).not.toBe('TOP SECRET');
      expect(await getTemplateYaml(evil, 'legacy-reg')).toBeNull();
    }
    // The legitimate name still resolves.
    expect(await getReadme('foo', 'template', 'legacy-reg')).toBe('foo readme');
  });

  it('rejects a traversal registry (source) name', async () => {
    const secretPath = path.join(REG_DIR, 'secret.txt');
    await fs.writeFile(secretPath, 'TOP SECRET');
    // A source (registry name) that tries to climb out of REGISTRIES_DIR must
    // not read the planted file, regardless of the item name.
    for (const evilSource of ['../', '..', 'a/b']) {
      expect(await getReadme('secret', 'template', evilSource)).not.toBe('TOP SECRET');
      expect(await getReadme('../secret', 'template', evilSource)).not.toBe('TOP SECRET');
    }
  });

  it('rejects a manifest entry.path that escapes the registry root', async () => {
    // Plant a secret above the registry root; a manifest whose entry.path
    // climbs out (../../secret) must not expose it as a readable template.
    const secretDir = path.join(REG_DIR, 'escaped');
    await fs.mkdir(secretDir, { recursive: true });
    await fs.writeFile(path.join(secretDir, 'template.yml'), 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: evil\n');
    await fs.writeFile(path.join(secretDir, 'README.md'), 'ESCAPED SECRET');
    await seed('escaper', {
      'servicebay.json': JSON.stringify({
        templates: [{ name: 'evil', path: '../escaped' }],
      }),
    });
    mockConfigState.registries.items.push({ name: 'escaper', url: 'http://example/escaper.git' });

    // The escaping entry must not read the file outside the registry root.
    expect(await getReadme('evil', 'template', 'escaper')).not.toBe('ESCAPED SECRET');
  });

  it('resolves a legitimate multi-segment manifest entry.path', async () => {
    // A path with an internal separator (stacks/household-shape) is allowed
    // as long as it stays inside the registry root.
    await seed('nested', {
      'servicebay.json': JSON.stringify({
        templates: [{ name: 'deep', path: 'sub/deep-dir' }],
      }),
      'sub/deep-dir/template.yml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: deep\n  annotations:\n    servicebay.label: "deep"\n    servicebay.ports: "1/tcp"\n    servicebay.schema-version: "1"\n',
      'sub/deep-dir/README.md': 'deep readme',
    });
    mockConfigState.registries.items.push({ name: 'nested', url: 'http://example/nested.git' });

    expect(await getReadme('deep', 'template', 'nested')).toBe('deep readme');
  });

  it('rejects a traversal name against the built-in fallback (no source)', async () => {
    // With no source and no registries, a traversal `name` funnels to the
    // built-in TEMPLATES_PATH join, which the barrier constrains — the read
    // must fail closed rather than climbing out of the bundled templates dir.
    mockConfigState.registries.items = [];
    for (const evil of ['../../../../etc/passwd', '../secret', '..', 'a/b']) {
      // No throw, and no content from outside the built-in tree.
      const readme = await getReadme(evil, 'template');
      expect(readme).toBeNull();
      expect(await getTemplateYaml(evil)).toBeNull();
    }
  });
});
