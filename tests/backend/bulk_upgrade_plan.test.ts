/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'test', expires: new Date(Date.now() + 60_000) })),
}));
vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: vi.fn(),
  getTemplateChangelog: vi.fn(),
  getTemplateMigrationScripts: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { planBulkTemplateUpgrade } from '@/lib/install/bulkUpgradePlan';
import { POST } from '@/app/api/system/templates/bulk-upgrade-plan/route';
import { getConfig } from '@/lib/config';
import {
  getTemplateYaml,
  getTemplateChangelog,
  getTemplateMigrationScripts,
} from '@/lib/registry';

/**
 * #2602 — the bulk-upgrade PLAN. This is the preview an operator sees before
 * anything is deployed, so what it must get right is: who is in, in what
 * order, and — the half #2601 taught — who *cannot* roll out at all.
 */

function yamlFor(opts: { version: number; deps?: string; tier?: string }): string {
  const lines = [
    'metadata:',
    '  annotations:',
    `    servicebay.schema-version: "${opts.version}"`,
  ];
  if (opts.deps) lines.push(`    servicebay.dependencies: "${opts.deps}"`);
  if (opts.tier) lines.push(`    servicebay.tier: "${opts.tier}"`);
  return lines.join('\n') + '\n';
}

function migration(from: number, to: number) {
  return { filename: `v${from}-to-v${to}.py`, fromVersion: from, toVersion: to, content: '# noop\n' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTemplateChangelog).mockResolvedValue('');
  vi.mocked(getTemplateMigrationScripts).mockResolvedValue([]);
});

describe('planBulkTemplateUpgrade', () => {
  it('lists exactly the services whose installed version is behind the shipped template', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        media: { schemaVersion: 7, installedAt: '' },
        nginx: { schemaVersion: 3, installedAt: '' },
        auth: { schemaVersion: 5, installedAt: '' },
      },
    } as any);
    vi.mocked(getTemplateYaml).mockImplementation(async (name: string) => {
      if (name === 'media') return yamlFor({ version: 8 });
      if (name === 'nginx') return yamlFor({ version: 3 });   // current
      if (name === 'auth') return yamlFor({ version: 6 });
      return null;
    });
    vi.mocked(getTemplateMigrationScripts).mockImplementation(async (name: string) => (
      name === 'media' ? [migration(7, 8)] : [migration(5, 6)]
    ));

    const plan = await planBulkTemplateUpgrade();

    expect(plan.order.map(o => o.name).sort()).toEqual(['auth', 'media']);
    expect(plan.excluded).toEqual([]);
    // nginx is current — it takes part only as a dependency satisfier.
    expect(plan.satisfiers).toEqual(['nginx']);
  });

  it('orders the run by dependencies, not by the order the caller asked for', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        media: { schemaVersion: 1, installedAt: '' },
        auth: { schemaVersion: 1, installedAt: '' },
      },
    } as any);
    vi.mocked(getTemplateYaml).mockImplementation(async (name: string) => (
      name === 'media'
        ? yamlFor({ version: 2, deps: 'auth' })
        : yamlFor({ version: 2, tier: 'infrastructure' })
    ));
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([migration(1, 2)]);

    // Ask for them in the WRONG order on purpose.
    const plan = await planBulkTemplateUpgrade(['media', 'auth']);

    expect(plan.order.map(o => o.name)).toEqual(['auth', 'media']);
    expect(plan.order[1].dependencies).toEqual(['auth']);
  });

  it('excludes a service whose migration chain has a hole, and says which hop is missing', async () => {
    // This is #2601's exact shape: media recorded at v7, template shipped at
    // v8, no v7-to-v8 script. The runner refuses mid-deploy; the preview must
    // refuse BEFORE the run, or one bad chain aborts the whole batch.
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        media: { schemaVersion: 7, installedAt: '' },
        immich: { schemaVersion: 1, installedAt: '' },
      },
    } as any);
    vi.mocked(getTemplateYaml).mockImplementation(async (name: string) => (
      name === 'media' ? yamlFor({ version: 8 }) : yamlFor({ version: 2 })
    ));
    vi.mocked(getTemplateMigrationScripts).mockImplementation(async (name: string) => (
      name === 'media'
        ? [migration(1, 2), migration(3, 4)]  // nothing for 7 -> 8
        : [migration(1, 2)]
    ));

    const plan = await planBulkTemplateUpgrade();

    expect(plan.order.map(o => o.name)).toEqual(['immich']);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0].name).toBe('media');
    expect(plan.excluded[0].excludedReason).toContain('no script for v7→v8');
    // The healthy service is still runnable — one hole must not void the run.
    expect(plan.order[0].migrations.map(m => m.filename)).toEqual(['v1-to-v2.py']);
  });

  it('reports the migration scripts each service will actually run', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { immich: { schemaVersion: 1, installedAt: '' } },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue(yamlFor({ version: 4 }));
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([
      migration(3, 4), migration(1, 2), migration(2, 3),
    ]);

    const plan = await planBulkTemplateUpgrade();

    expect(plan.order[0].migrations.map(m => m.filename)).toEqual([
      'v1-to-v2.py', 'v2-to-v3.py', 'v3-to-v4.py',
    ]);
  });

  it('a schema bump with no migration script is a normal, runnable upgrade', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { beets: { schemaVersion: 2, installedAt: '' } },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue(yamlFor({ version: 3 }));
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([migration(2, 3)]);

    const plan = await planBulkTemplateUpgrade();
    expect(plan.excluded).toEqual([]);
    expect(plan.order.map(o => o.name)).toEqual(['beets']);
  });

  it('honours the caller selection instead of upgrading everything behind', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        media: { schemaVersion: 1, installedAt: '' },
        immich: { schemaVersion: 1, installedAt: '' },
      },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue(yamlFor({ version: 2 }));
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([migration(1, 2)]);

    const plan = await planBulkTemplateUpgrade(['immich']);

    expect(plan.order.map(o => o.name)).toEqual(['immich']);
    // The one left out stays a satisfier — it is installed, just not upgraded.
    expect(plan.satisfiers).toContain('media');
  });

  it('flags a breaking selection so the caller can gate the run on an acknowledgement', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { auth: { schemaVersion: 1, installedAt: '' } },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue(yamlFor({ version: 2 }));
    vi.mocked(getTemplateChangelog).mockResolvedValue('## v2 (breaking)\n\nrewires SSO.\n');
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([migration(1, 2)]);

    const plan = await planBulkTemplateUpgrade();
    expect(plan.hasBreakingChange).toBe(true);
    expect(plan.order[0].sectionHeaders).toContain('v2 (breaking)');
  });

  it('drops a service whose dependency is not installed rather than voiding the whole plan', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: {
        hermes: { schemaVersion: 1, installedAt: '' },
        immich: { schemaVersion: 1, installedAt: '' },
      },
    } as any);
    vi.mocked(getTemplateYaml).mockImplementation(async (name: string) => (
      name === 'hermes'
        ? yamlFor({ version: 2, deps: 'home-assistant' })  // not installed
        : yamlFor({ version: 2 })
    ));
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([migration(1, 2)]);

    const plan = await planBulkTemplateUpgrade();

    expect(plan.order.map(o => o.name)).toEqual(['immich']);
    expect(plan.excluded.map(e => e.name)).toEqual(['hermes']);
    expect(plan.excluded[0].excludedReason).toContain('home-assistant');
  });

  it('excludes a template that no registry can resolve instead of throwing', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { ghost: { schemaVersion: 1, installedAt: '' } },
    } as any);
    // upgrades-pending resolves it (first read), the plan's own read fails.
    let call = 0;
    vi.mocked(getTemplateYaml).mockImplementation(async () => {
      call += 1;
      return call === 1 ? yamlFor({ version: 2 }) : null;
    });

    const plan = await planBulkTemplateUpgrade();

    expect(plan.order).toEqual([]);
    expect(plan.excluded[0].name).toBe('ghost');
    expect(plan.excluded[0].excludedReason).toContain('registry');
  });

  it('is empty and harmless when nothing is behind', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { nginx: { schemaVersion: 3, installedAt: '' } },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue(yamlFor({ version: 3 }));

    const plan = await planBulkTemplateUpgrade();
    expect(plan.order).toEqual([]);
    expect(plan.excluded).toEqual([]);
    expect(plan.hasBreakingChange).toBe(false);
  });
});

describe('POST /api/system/templates/bulk-upgrade-plan', () => {
  function makeRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/system/templates/bulk-upgrade-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns the plan without deploying anything', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      installedTemplates: { immich: { schemaVersion: 1, installedAt: '' } },
    } as any);
    vi.mocked(getTemplateYaml).mockResolvedValue(yamlFor({ version: 2 }));
    vi.mocked(getTemplateMigrationScripts).mockResolvedValue([migration(1, 2)]);

    const res = await POST(makeRequest({ names: ['immich'] }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.order.map((o: { name: string }) => o.name)).toEqual(['immich']);
  });

  it('rejects a name that could never be a template', async () => {
    const res = await POST(makeRequest({ names: ['../../etc/passwd'] }));
    expect(res.status).toBe(400);
  });
});
