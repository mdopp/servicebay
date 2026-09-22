/**
 * Registering a template source (#3035).
 *
 * The step that was missing between "I built a project" and "the box can
 * install it": the only path in was the cookie-only onboarding route, which
 * never adds an item at all, so a new project meant hand-editing `config.json`
 * on the box — which no session can do.
 *
 * What is pinned here is the part that makes the verb worth having rather than
 * just present:
 *
 *  - **It reports what the sync did, not that a line was written.** A source
 *    that is unreachable, private or carries no templates looks identical in
 *    the config to one that works.
 *  - **A failed sync does not silently drop the entry.** An operator may be
 *    registering a repo that is about to exist; deleting their entry behind
 *    their back would be its own surprise. The answer says which happened.
 *  - **A local path is refused.** "Add a source" must not become a way to read
 *    the box's filesystem through the template loader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  syncRegistries: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ getConfig: mocks.getConfig, saveConfig: mocks.saveConfig }));
vi.mock('@/lib/registry', () => ({ syncRegistries: mocks.syncRegistries }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { addTemplateSource, deriveSourceName, assertUsableRepoUrl, TemplateSourceError } from './templateSources';

const URL_ = 'https://github.com/mdopp/flutstunde.git';

function syncedOk(name = 'flutstunde') {
  mocks.syncRegistries.mockResolvedValue({
    requested: 1, synced: 1, failed: 0, skipped: 0,
    results: [{ name, url: URL_, status: 'synced' }],
  });
}

describe('deriveSourceName', () => {
  it.each([
    ['https://github.com/mdopp/flutstunde.git', 'flutstunde'],
    ['https://github.com/mdopp/flutstunde', 'flutstunde'],
    ['https://github.com/mdopp/flutstunde/', 'flutstunde'],
    ['git@github.com:mdopp/flutstunde.git', 'flutstunde'],
  ])('%s → %s', (url, expected) => {
    expect(deriveSourceName(url)).toBe(expected);
  });
});

describe('assertUsableRepoUrl', () => {
  it.each([
    'https://github.com/mdopp/x.git',
    'http://git.internal/x',
    'ssh://git@host/x.git',
    'git@github.com:mdopp/x.git',
  ])('accepts %s', (url) => {
    expect(() => assertUsableRepoUrl(url)).not.toThrow();
  });

  it('refuses a local path, and says where a self-written template goes instead', () => {
    // Otherwise "add a source" becomes a way to read the box's own filesystem
    // through the template loader.
    for (const bad of ['/mnt/data/secrets', 'file:///etc']) {
      expect(() => assertUsableRepoUrl(bad)).toThrow(TemplateSourceError);
      try { assertUsableRepoUrl(bad); } catch (e) {
        expect(String(e)).toContain('local-templates');
      }
    }
  });

  it('refuses anything git cannot clone', () => {
    expect(() => assertUsableRepoUrl('')).toThrow();
    expect(() => assertUsableRepoUrl('flutstunde')).toThrow(/not a repository URL/);
  });
});

describe('addTemplateSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({ registries: { enabled: false, items: [] } });
    syncedOk();
  });

  it('writes the entry, turns the mechanism on, and derives the name', async () => {
    const r = await addTemplateSource({ url: URL_ });
    expect(r).toMatchObject({ name: 'flutstunde', added: true, synced: true });
    const saved = mocks.saveConfig.mock.calls[0][0];
    // Registering a source IS the opt-in: an entry under `enabled: false`
    // would be a line that does nothing.
    expect(saved.registries.enabled).toBe(true);
    expect(saved.registries.items).toEqual([{ name: 'flutstunde', url: URL_ }]);
  });

  it('points at the verb that installs from it', async () => {
    const r = await addTemplateSource({ url: URL_ });
    expect(r.detail).toContain('--source flutstunde');
  });

  it('keeps the entry when the sync FAILS, and says so with the reason', async () => {
    mocks.syncRegistries.mockResolvedValue({
      requested: 1, synced: 0, failed: 1, skipped: 0,
      results: [{ name: 'flutstunde', url: URL_, status: 'failed', reason: 'Repository not found', advice: 'check contents: read' }],
    });
    const r = await addTemplateSource({ url: URL_ });
    expect(r.added).toBe(true);
    expect(r.synced).toBe(false);
    expect(r.detail).toContain('Repository not found');
    expect(r.detail).toContain('check contents: read');
    expect(r.detail).toContain('entry is kept');
    // It really was written — an operator may be adding a repo that is about
    // to exist, and dropping it behind their back would be its own surprise.
    expect(mocks.saveConfig).toHaveBeenCalled();
  });

  it('a sync that throws does not lose the registration either', async () => {
    mocks.syncRegistries.mockRejectedValue(new Error('git is gone'));
    const r = await addTemplateSource({ url: URL_ });
    expect(r.added).toBe(true);
    expect(r.synced).toBe(false);
    expect(r.detail).toContain('git is gone');
  });

  it('a sync that does not report on this source is not counted as success', async () => {
    mocks.syncRegistries.mockResolvedValue({ requested: 1, synced: 1, failed: 0, skipped: 0, results: [] });
    const r = await addTemplateSource({ url: URL_ });
    expect(r.synced).toBe(false);
    expect(r.detail).toContain('did not report');
  });

  it('does not duplicate an already-registered source, and says it was already there', async () => {
    mocks.getConfig.mockResolvedValue({ registries: { enabled: true, items: [{ name: 'flutstunde', url: URL_ }] } });
    const r = await addTemplateSource({ url: URL_ });
    expect(r.added).toBe(false);
    expect(r.detail).toContain('already registered');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('turns the mechanism back on for an existing entry that was disabled', async () => {
    mocks.getConfig.mockResolvedValue({ registries: { enabled: false, items: [{ name: 'flutstunde', url: URL_ }] } });
    await addTemplateSource({ url: URL_ });
    expect(mocks.saveConfig.mock.calls[0][0].registries.enabled).toBe(true);
  });

  it('carries a branch through when one is given', async () => {
    await addTemplateSource({ url: URL_, branch: 'main' });
    expect(mocks.saveConfig.mock.calls[0][0].registries.items[0]).toMatchObject({ branch: 'main' });
  });

  it('refuses a name that is not usable as one', async () => {
    await expect(addTemplateSource({ url: URL_, name: 'a b/c' })).rejects.toThrow(/not a usable source name/);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('reads the legacy array-shaped registries config without losing its entries', async () => {
    mocks.getConfig.mockResolvedValue({ registries: [{ name: 'old', url: 'https://example.invalid/old.git' }] });
    await addTemplateSource({ url: URL_ });
    const items = mocks.saveConfig.mock.calls[0][0].registries.items;
    expect(items.map((i: { name: string }) => i.name)).toEqual(['old', 'flutstunde']);
  });
});
