import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockProducer } = vi.hoisted(() => ({ mockProducer: { listServiceBackups: vi.fn() } }));
vi.mock('./producer', async (orig) => ({
  ...(await orig<typeof import('./producer')>()),
  listServiceBackups: mockProducer.listServiceBackups,
}));

import { selectOrphanBackups, listOrphanServiceBackups } from './orphanBackups';

const entry = (service: string) => ({ service, tarName: `${service}-20260615-0531.tar`, size: 1, stamp: '20260615-0531' });

describe('selectOrphanBackups (#1218 entry 2)', () => {
  it('returns backups for services that are not installed', () => {
    const nas = [entry('home-assistant'), entry('adguard'), entry('vaultwarden')];
    expect(selectOrphanBackups(nas, ['adguard']).map(b => b.service)).toEqual(['home-assistant', 'vaultwarden']);
  });

  it('returns empty when every backup is already installed', () => {
    expect(selectOrphanBackups([entry('adguard')], ['adguard', 'home-assistant'])).toEqual([]);
  });

  it('returns all of them on a fresh box (nothing installed)', () => {
    expect(selectOrphanBackups([entry('home-assistant'), entry('adguard')], [])).toHaveLength(2);
  });
});

describe('listOrphanServiceBackups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists NAS backups minus the installed services', async () => {
    mockProducer.listServiceBackups.mockResolvedValue([entry('home-assistant'), entry('adguard')]);
    const orphans = await listOrphanServiceBackups(['adguard']);
    expect(orphans.map(b => b.service)).toEqual(['home-assistant']);
  });
});
