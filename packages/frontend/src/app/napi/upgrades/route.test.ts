/**
 * GET /napi/upgrades — token-gated unified template + image upgrade feed
 * (#2252). Deny #1, allow read #2/#4, and the {name,kind,current,available}
 * merge of getPendingTemplateUpgrades + getInstalledImageUpdates (updateAvailable
 * images only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getPendingTemplateUpgrades: vi.fn(),
  getInstalledImageUpdates: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/templateUpgrades', () => ({
  getPendingTemplateUpgrades: mocks.getPendingTemplateUpgrades,
}));
vi.mock('@/lib/imageDigest', () => ({ getInstalledImageUpdates: mocks.getInstalledImageUpdates }));
vi.mock('@/lib/auth/apiTokens', () => ({ verifyToken: mocks.verifyToken }));

import { GET } from './route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:5888/napi/upgrades', { method: 'GET', headers });
}

describe('GET /napi/upgrades — token-gated unified upgrade feed', () => {
  beforeEach(() => {
    mocks.getPendingTemplateUpgrades.mockReset();
    mocks.getInstalledImageUpdates.mockReset();
    mocks.verifyToken.mockReset();
  });

  it('NO token → 401, never fans out (acceptance #1)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.getPendingTemplateUpgrades).not.toHaveBeenCalled();
    expect(mocks.getInstalledImageUpdates).not.toHaveBeenCalled();
  });

  it('read Bearer → 200 + merged template+image upgrades, image only when available (#2, #4)', async () => {
    mocks.verifyToken.mockResolvedValue({ name: 'device', scopes: ['read'] });
    mocks.getPendingTemplateUpgrades.mockResolvedValue([
      { name: 'immich', installedVersion: 3, currentVersion: 5, hasBreakingChange: false, sectionHeaders: [] },
    ]);
    mocks.getInstalledImageUpdates.mockResolvedValue([
      { service: 'vault', runningDigest: 'sha256:aaaaaaabbbb', registryDigest: 'sha256:ccccccddddd', updateAvailable: true },
      { service: 'skip', runningDigest: 'sha256:x', registryDigest: 'sha256:x', updateAvailable: false },
    ]);
    const res = await GET(req({ authorization: 'Bearer sb_read' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upgrades).toEqual([
      { name: 'immich', kind: 'template', current: 'v3', available: 'v5' },
      { name: 'vault', kind: 'image', current: 'aaaaaaa', available: 'ccccccd' },
    ]);
  });
});
