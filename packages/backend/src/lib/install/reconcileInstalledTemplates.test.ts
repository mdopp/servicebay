import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2863 — `installedTemplates` drifted from the real service set because a
// delete dropped the unit and kept the record. The reconcile removes a record
// only when the service exists NOWHERE: no Quadlet unit, no trash entry.
let config: { installedTemplates?: Record<string, { schemaVersion: number; installedAt: string }> };

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => config),
  saveConfig: vi.fn(async (c: typeof config) => { config = c; }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { findInstalledTemplateDrift, reconcileInstalledTemplates } = await import('./reconcileInstalledTemplates');
const { saveConfig } = await import('@/lib/config');

const entry = () => ({ schemaVersion: 1, installedAt: '2026-01-01T00:00:00Z' });

// The box as measured on 2026-09-06: `media` runs, `hermes` is soft-deleted and
// restorable, the five others exist nowhere.
const QUADLETS = ['media', 'immich', 'nginx'];
const TRASHED = ['hermes'];

beforeEach(() => {
  config = {
    installedTemplates: {
      media: entry(), immich: entry(), hermes: entry(),
      ollama: entry(), 'asteroids-spike': entry(), 'asteroids-qwen2': entry(),
      'asteroids-dino': entry(), 'asteroids-dino-r8': entry(),
    },
  };
  vi.mocked(saveConfig).mockClear();
});

describe('findInstalledTemplateDrift', () => {
  it('flags only entries with neither a Quadlet unit nor a trash entry', () => {
    const drift = findInstalledTemplateDrift(Object.keys(config.installedTemplates!), QUADLETS, TRASHED);
    expect(drift.map(d => d.name).sort()).toEqual([
      'asteroids-dino', 'asteroids-dino-r8', 'asteroids-qwen2', 'asteroids-spike', 'ollama',
    ]);
  });

  it('leaves a soft-deleted (restorable) service alone', () => {
    const drift = findInstalledTemplateDrift(['hermes'], [], ['hermes']);
    expect(drift).toEqual([]);
  });

  it('leaves a live service alone even when it is also in the trash (a shadow entry)', () => {
    const drift = findInstalledTemplateDrift(['llama'], ['llama'], ['llama']);
    expect(drift).toEqual([]);
  });
});

describe('reconcileInstalledTemplates', () => {
  it('drops the orphans and keeps live + trashed services', async () => {
    const dropped = await reconcileInstalledTemplates({ quadletBaseNames: QUADLETS, trashedServices: TRASHED });
    expect(dropped.map(d => d.name)).toContain('ollama');
    expect(Object.keys(config.installedTemplates!).sort()).toEqual(['hermes', 'immich', 'media']);
  });

  it('never auto-creates a record for a unit that has none', async () => {
    config.installedTemplates = { media: entry() };
    await reconcileInstalledTemplates({ quadletBaseNames: ['media', 'unmanaged-thing'], trashedServices: [] });
    expect(Object.keys(config.installedTemplates!)).toEqual(['media']);
  });

  it('is a no-op with no write when nothing drifted', async () => {
    config.installedTemplates = { media: entry() };
    const dropped = await reconcileInstalledTemplates({ quadletBaseNames: ['media'], trashedServices: [] });
    expect(dropped).toEqual([]);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('does NOTHING when the node could not be read — an unreadable node is not an empty one', async () => {
    const dropped = await reconcileInstalledTemplates({ quadletBaseNames: null, trashedServices: [] });
    expect(dropped).toEqual([]);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(Object.keys(config.installedTemplates!)).toHaveLength(8);
  });
});
