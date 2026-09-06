/**
 * Migration-script resolution across registry sources (#2855).
 *
 * The reported failure: `install_template llama` aborted with
 * "Migration chain for llama is incomplete: no script for v1→v2 (have none)"
 * while `templates/llama/migrations/v1-to-v2.py` was demonstrably present in
 * the freshly-refreshed `solbay` git clone.
 *
 * Cause: the MCP `install_template` tool records `templateSource: 'Built-in'`
 * when the caller omits it (it passes `undefined` to `assembleManifest`, so
 * the *yaml* resolves by walking every registry, but the JobInput it saves
 * pins `'Built-in'`). `getTemplateMigrationScripts` was the one template
 * artifact reader with NO cross-source fallback — `'Built-in'` scanned only
 * the bundled `templates/` directory, found nothing, and reported "have none"
 * for a script sitting on disk in a registry clone. `readTemplateFile`
 * (post-deploy / user-guide / CHANGELOG) has had exactly this fallback since
 * #818; the migration reader's own docstring claimed the same semantics but
 * never implemented them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

// REGISTRIES_DIR is computed from CONTAINER_CONFIG_DIR at module load, so the
// env var has to be in place before registry.ts evaluates its top-level
// constants. `vi.hoisted` runs before this file's `import`s.
const TEST_ROOT = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path');
  const root = _path.join(_os.tmpdir(), `sb-registry-migrations-${process.pid}`);
  process.env.CONTAINER_CONFIG_DIR = root;
  return root;
});

const mockConfigState = { registries: { enabled: true, items: [] as Array<{ name: string; url: string }> } };
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState),
}));

import { getTemplateMigrationScripts, _resetRegistryManifestCacheForTests } from './registry';
import { selectMigrationChain } from './stackInstall/migrations';
import { logger } from './logger';

const REG_DIR = path.join(TEST_ROOT, 'registries');

/** The shape the solarisbay llama migration actually ships. */
const V1_TO_V2 = '#!/usr/bin/env python3\nimport sys\n\n\ndef main():\n    return 0\n\n\nsys.exit(main())\n';

async function seed(regName: string, layout: Record<string, string>): Promise<void> {
  const regRoot = path.join(REG_DIR, regName);
  for (const [relPath, content] of Object.entries(layout)) {
    const full = path.join(regRoot, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

/** A git-backed registry clone carrying llama at schema-version 2 plus its
 *  v1→v2 migration — i.e. the exact on-disk state the operator verified. */
async function seedLlamaRegistry(regName: string): Promise<void> {
  await seed(regName, {
    'templates/llama/template.yml':
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: llama\n  annotations:\n' +
      '    servicebay.label: "AI Engine (llama.cpp)"\n    servicebay.schema-version: "2"\n',
    'templates/llama/migrations/v1-to-v2.py': V1_TO_V2,
  });
  mockConfigState.registries.items.push({ name: regName, url: `http://example/${regName}.git` });
}

/** Every message the fallback logged — the "which registry matched" evidence
 *  the fix must leave behind, so it never widens the search silently. */
const infoLines: string[] = [];

beforeEach(async () => {
  await fs.rm(REG_DIR, { recursive: true, force: true });
  await fs.mkdir(REG_DIR, { recursive: true });
  mockConfigState.registries.items = [];
  _resetRegistryManifestCacheForTests();
  infoLines.length = 0;
  vi.spyOn(logger, 'info').mockImplementation((tag: string, message: string) => {
    infoLines.push(`${tag} ${message}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedFallbacks(): string {
  return infoLines.join('\n');
}

describe('getTemplateMigrationScripts — source fallback (#2855)', () => {
  it("finds a registry migration when the install record pins the defaulted 'Built-in' source", async () => {
    await seedLlamaRegistry('solbay');

    const scripts = await getTemplateMigrationScripts('llama', 'Built-in');

    expect(scripts.map(s => s.filename)).toEqual(['v1-to-v2.py']);
    expect(scripts[0].fromVersion).toBe(1);
    expect(scripts[0].toVersion).toBe(2);
    expect(scripts[0].content).toBe(V1_TO_V2);

    // Installed record at schema 1, catalog at schema 2 → the chain the
    // deploy asks for must be complete, not "have none".
    const chain = selectMigrationChain(1, 2, scripts);
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(chain.chain.map(s => s.filename)).toEqual(['v1-to-v2.py']);

    expect(loggedFallbacks()).toContain('solbay');
  });

  it('falls back when the pinned source name does not match the registry that carries the template', async () => {
    await seedLlamaRegistry('solbay');

    // A display name / stale registry name that maps to no clone directory.
    const scripts = await getTemplateMigrationScripts('llama', 'solarisbay');

    expect(scripts.map(s => s.filename)).toEqual(['v1-to-v2.py']);
    expect(selectMigrationChain(1, 2, scripts).ok).toBe(true);
    // Never widen silently — the log names the source that missed and the
    // registry that answered.
    const logged = loggedFallbacks();
    expect(logged).toContain('solarisbay');
    expect(logged).toContain('solbay');
  });

  it('uses the pinned registry without falling back when it carries the scripts', async () => {
    await seedLlamaRegistry('solbay');
    // A second registry that would also answer — it must not be consulted.
    await seed('other-reg', { 'templates/llama/migrations/v1-to-v2.py': '# wrong one\n' });
    mockConfigState.registries.items.push({ name: 'other-reg', url: 'http://example/other.git' });

    const scripts = await getTemplateMigrationScripts('llama', 'solbay');

    expect(scripts.map(s => s.filename)).toEqual(['v1-to-v2.py']);
    expect(scripts[0].content).toBe(V1_TO_V2);
    expect(loggedFallbacks()).toBe('');
  });

  it('walks every registry when no source is pinned (unchanged)', async () => {
    await seedLlamaRegistry('solbay');

    const scripts = await getTemplateMigrationScripts('llama');

    expect(scripts.map(s => s.filename)).toEqual(['v1-to-v2.py']);
    expect(loggedFallbacks()).toBe('');
  });

  it('returns an empty chain-friendly list when no source carries the template', async () => {
    await seed('empty-reg', { 'templates/other/template.yml': 'apiVersion: v1\n' });
    mockConfigState.registries.items.push({ name: 'empty-reg', url: 'http://example/empty.git' });

    expect(await getTemplateMigrationScripts('llama', 'Built-in')).toEqual([]);
    expect(loggedFallbacks()).toBe('');
  });
});
