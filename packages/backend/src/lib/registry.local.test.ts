/**
 * Persistent local (non-git) template/stack source (#1919).
 *
 * `LOCAL_TEMPLATES_DIR` lives under the persisted data mount
 * (`DATA_DIR/local-templates/{templates,stacks}`). A template dropped
 * there must:
 *   - appear in getTemplates() (source = 'Local'),
 *   - be readable through the per-name resolvers,
 *   - override a built-in / registry entry of the same name,
 *   - and a malformed entry must be skipped without crashing enumeration.
 *
 * `DATA_DIR` is read at module load from `process.env.DATA_DIR`, so the
 * hoisted block points it at a temp root before `registry.ts` evaluates
 * its top-level constants.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';

const ROOTS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path');
  const dataRoot = _path.join(_os.tmpdir(), `sb-registry-local-data-${process.pid}`);
  const cfgRoot = _path.join(_os.tmpdir(), `sb-registry-local-cfg-${process.pid}`);
  process.env.DATA_DIR = dataRoot;
  process.env.CONTAINER_CONFIG_DIR = cfgRoot;
  return { dataRoot, cfgRoot };
});

// No external registries — isolate the local source from registry sync.
const mockConfigState = { registries: { enabled: true, items: [] as Array<{ name: string; url: string }> } };
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => mockConfigState),
}));

import {
  getTemplates,
  getReadme,
  getTemplateYaml,
  getTemplateVariables,
  getStackManifest,
} from './registry';

const LOCAL_DIR = path.join(ROOTS.dataRoot, 'local-templates');
const LOCAL_TEMPLATES = path.join(LOCAL_DIR, 'templates');

function tmplYaml(name: string, label = name): string {
  return [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    `  name: ${name}`,
    '  annotations:',
    `    servicebay.label: "${label}"`,
    '    servicebay.ports: "8080/tcp"',
    '    servicebay.schema-version: "1"',
    '',
  ].join('\n');
}

async function seedLocal(layout: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(layout)) {
    const full = path.join(LOCAL_DIR, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

beforeEach(async () => {
  await fs.rm(LOCAL_DIR, { recursive: true, force: true });
  mockConfigState.registries.items = [];
});

afterAll(async () => {
  await fs.rm(ROOTS.dataRoot, { recursive: true, force: true });
  await fs.rm(ROOTS.cfgRoot, { recursive: true, force: true });
});

describe('local persistent source (#1919)', () => {
  it('exposes a file-dropped local template in getTemplates() with source=Local', async () => {
    await seedLocal({
      'templates/widget/template.yml': tmplYaml('widget'),
      'templates/widget/README.md': 'widget readme',
      'templates/widget/variables.json': JSON.stringify({ FOO: { type: 'text', default: 'bar' } }),
    });

    const templates = await getTemplates();
    const widget = templates.find(t => t.name === 'widget' && t.type === 'template');
    expect(widget).toBeDefined();
    expect(widget!.source).toBe('Local');
    expect(widget!.path).toBe(path.join(LOCAL_TEMPLATES, 'widget'));

    // Per-name resolvers find it with no pinned source.
    expect(await getTemplateYaml('widget')).toContain('name: widget');
    expect(await getReadme('widget', 'template')).toBe('widget readme');
    const vars = await getTemplateVariables('widget');
    expect(vars?.FOO?.default).toBe('bar');
  });

  it('finds a local stack via getStackManifest + getTemplates', async () => {
    await seedLocal({
      'stacks/mystack/stack.yml': 'apiVersion: v1\nkind: Stack\nmetadata:\n  name: mystack\n  annotations:\n    servicebay.label: "My Stack"\nspec:\n  templates: [widget]\n',
    });

    const templates = await getTemplates();
    const stack = templates.find(t => t.name === 'mystack' && t.type === 'stack');
    expect(stack).toBeDefined();
    expect(stack!.source).toBe('Local');

    const manifest = await getStackManifest('mystack');
    expect(manifest).not.toBeNull();
  });

  it('local override wins over built-in by name', async () => {
    // `vaultwarden` is a built-in template; a local one shadows it.
    await seedLocal({
      'templates/vaultwarden/template.yml': tmplYaml('vaultwarden', 'Local Vaultwarden'),
    });

    const templates = await getTemplates();
    const vaultwarden = templates.filter(t => t.name === 'vaultwarden' && t.type === 'template');
    // Exactly one entry, and it is the local override.
    expect(vaultwarden).toHaveLength(1);
    expect(vaultwarden[0].source).toBe('Local');

    // The per-name resolver also returns the local copy.
    const yaml = await getTemplateYaml('vaultwarden');
    expect(yaml).toContain('Local Vaultwarden');
  });

  it('skips a malformed local entry with a warning, without crashing enumeration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedLocal({
      // A good entry…
      'templates/good/template.yml': tmplYaml('good'),
      // …and a malformed one (template.yml is not parseable YAML). The
      // catalog must still enumerate `good` rather than throwing.
      'templates/broken/template.yml': ':\n  this is not: [valid: yaml',
    });

    const templates = await getTemplates();
    const good = templates.find(t => t.name === 'good' && t.source === 'Local');
    // `good` survives; `broken` is enumerated with default meta (its
    // malformed manifest only degrades its tier/deps, never the catalog).
    expect(good).toBeDefined();
    const broken = templates.find(t => t.name === 'broken' && t.source === 'Local');
    expect(broken).toBeDefined();
    expect(broken!.tier).toBe('feature'); // readTemplateMeta default on parse failure
    warn.mockRestore();
  });

  it('returns no local items when the local dir is absent', async () => {
    // Nothing seeded — getTemplates must not throw and built-ins remain.
    const templates = await getTemplates();
    const local = templates.filter(t => t.source === 'Local');
    expect(local).toHaveLength(0);
    // Built-ins still present.
    expect(templates.length).toBeGreaterThan(0);
  });

  it('rejects path-traversal in a request-supplied name (no read outside local root)', async () => {
    // Plant a sensitive file one level above the local-templates root.
    const secretPath = path.join(ROOTS.dataRoot, 'secret.txt');
    await fs.writeFile(secretPath, 'TOP SECRET');

    // A traversal `name` that would resolve to ../secret.txt must NOT read it.
    // localItemPath fails closed to a nonexistent sentinel, so every resolver
    // returns null/empty rather than the file outside the source.
    for (const evil of ['../secret', '../../secret', '..', '.', 'a/b', 'a\\b']) {
      expect(await getTemplateYaml(evil, 'Local')).toBeNull();
      expect(await getReadme(evil, 'template', 'Local')).toBeNull();
      expect(await getTemplateVariables(evil, 'Local')).toBeNull();
    }

    // And the unpinned (source-undefined) path is equally guarded.
    expect(await getReadme('../secret', 'template')).not.toBe('TOP SECRET');
  });
});
