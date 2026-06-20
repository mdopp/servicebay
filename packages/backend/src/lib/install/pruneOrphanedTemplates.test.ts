import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory config + a controllable template-manifest resolver.
let config: { installedTemplates?: Record<string, { schemaVersion: number; installedAt: string }> };
const manifests = new Set<string>(); // names that DO have a manifest

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => config),
  saveConfig: vi.fn(async (c: typeof config) => { config = c; }),
}));
vi.mock('@/lib/registry', () => ({
  getTemplateVariables: vi.fn(async (name: string) => (manifests.has(name) ? { SOME_VAR: {} } : null)),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { findOrphanedTemplates, pruneOrphanedTemplates } = await import('./pruneOrphanedTemplates');

const entry = () => ({ schemaVersion: 1, installedAt: '2026-01-01T00:00:00Z' });

beforeEach(() => {
  manifests.clear();
  config = {
    installedTemplates: {
      immich: entry(),   // has manifest + container → keep
      solaris: entry(),  // NO manifest but HAS containers → keep
      hermes: entry(),   // NO manifest, NO container → ORPHAN
      solbay: entry(),   // NO manifest, NO container → ORPHAN
    },
  };
  manifests.add('immich');
});

const RUNNING = ['immich-immich-server', 'immich-redis', 'solaris-chat', 'solaris-tts', 'nginx-nginx-proxy-manager'];

describe('findOrphanedTemplates', () => {
  it('flags manifest-less + container-less entries only', async () => {
    const orphans = await findOrphanedTemplates(RUNNING);
    expect(orphans.map(o => o.name).sort()).toEqual(['hermes', 'solbay']);
  });

  it('keeps a manifest-less template that still has running containers (solaris)', async () => {
    const orphans = await findOrphanedTemplates(RUNNING);
    expect(orphans.find(o => o.name === 'solaris')).toBeUndefined();
  });

  it('keeps an entry whose manifest exists even with no container', async () => {
    manifests.add('hermes'); // pretend the manifest is back
    const orphans = await findOrphanedTemplates([]);
    expect(orphans.find(o => o.name === 'hermes')).toBeUndefined();
  });

  it('is a pure read — does not mutate config', async () => {
    await findOrphanedTemplates(RUNNING);
    expect(Object.keys(config.installedTemplates!).sort()).toEqual(['hermes', 'immich', 'solaris', 'solbay']);
  });
});

describe('pruneOrphanedTemplates', () => {
  it('removes only the orphans, leaving live + manifested entries', async () => {
    const pruned = await pruneOrphanedTemplates(RUNNING);
    expect(pruned.map(o => o.name).sort()).toEqual(['hermes', 'solbay']);
    expect(Object.keys(config.installedTemplates!).sort()).toEqual(['immich', 'solaris']);
  });

  it('is a no-op (no write) when nothing is orphaned', async () => {
    const { saveConfig } = await import('@/lib/config');
    manifests.add('hermes'); manifests.add('solbay');
    config.installedTemplates = { immich: entry(), hermes: entry(), solbay: entry() };
    manifests.add('immich');
    vi.mocked(saveConfig).mockClear();
    const pruned = await pruneOrphanedTemplates(RUNNING);
    expect(pruned).toEqual([]);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
