/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));
vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: vi.fn(),
  getTemplateChangelog: vi.fn(),
}));

import { GET } from '@/app/api/system/templates/upgrades-pending/route';
import { getConfig } from '@/lib/config';
import { getTemplateYaml, getTemplateChangelog } from '@/lib/registry';

/**
 * Coverage for #510's aggregated upgrades-pending endpoint. The
 * per-template `/api/system/templates/[name]/upgrade-preview` route
 * already has its own integration tests; this file only verifies
 * that the aggregator filters + composes the right summaries.
 */

const sampleChangelog = `# Sample

## v4 (breaking)

Did something interesting.

## v3

Did something small.

## v2

initial fix.

## v1

initial.
`;

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/system/templates/upgrades-pending');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/system/templates/upgrades-pending', () => {
  it('returns only templates whose installed version is older than the registry', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        'file-share': { schemaVersion: 2, installedAt: '' },
        adguard: { schemaVersion: 2, installedAt: '' },
        nginx: { schemaVersion: 1, installedAt: '' },
      },
      autoUpdate: { enabled: false, schedule: '' },
    } as any);

    vi.mocked(getTemplateYaml).mockImplementation(async (name: string) => {
      if (name === 'file-share') return 'metadata:\n  annotations:\n    servicebay.schema-version: "4"\n';
      if (name === 'adguard') return 'metadata:\n  annotations:\n    servicebay.schema-version: "2"\n'; // same — no upgrade
      if (name === 'nginx') return 'metadata:\n  annotations:\n    servicebay.schema-version: "1"\n'; // same — no upgrade
      return null;
    });
    vi.mocked(getTemplateChangelog).mockResolvedValue(sampleChangelog);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].name).toBe('file-share');
    expect(data.pending[0].installedVersion).toBe(2);
    expect(data.pending[0].currentVersion).toBe(4);
    expect(data.pending[0].sectionHeaders).toContain('v4 (breaking)');
    expect(data.pending[0].sectionHeaders).toContain('v3');
    expect(data.hasBreakingChange).toBe(true);
  });

  it('returns an entry with empty sectionHeaders when version bumped but changelog has no matching section', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { foo: { schemaVersion: 2, installedAt: '' } },
      autoUpdate: { enabled: false, schedule: '' },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue('metadata:\n  annotations:\n    servicebay.schema-version: "3"\n');
    vi.mocked(getTemplateChangelog).mockResolvedValue('');

    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].sectionHeaders).toEqual([]);
    expect(data.hasBreakingChange).toBe(false);
  });

  it('returns an empty array when nothing is deployed', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {},
      autoUpdate: { enabled: false, schedule: '' },
    } as any);
    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.pending).toEqual([]);
    expect(data.hasBreakingChange).toBe(false);
  });

  it('skips templates whose yaml could not be read instead of failing the whole call', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        good: { schemaVersion: 1, installedAt: '' },
        broken: { schemaVersion: 1, installedAt: '' },
      },
      autoUpdate: { enabled: false, schedule: '' },
    } as any);
    vi.mocked(getTemplateYaml).mockImplementation(async (name: string) => {
      if (name === 'broken') throw new Error('disk read failure');
      return 'metadata:\n  annotations:\n    servicebay.schema-version: "2"\n';
    });
    vi.mocked(getTemplateChangelog).mockResolvedValue(sampleChangelog);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pending.map((p: { name: string }) => p.name)).toEqual(['good']);
  });
});
