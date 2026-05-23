/**
 * Integration test for the `merge_unmanaged_bundle` MCP tool (ARCH-14, #846).
 *
 * Exercises the tool handler end-to-end:
 *   1. Seeds the digital twin with an unmanaged bundle.
 *   2. Mocks `mergeServices` (the real one shells out to podman + writes to
 *      the Quadlet dir) so the test stays in-process.
 *   3. Calls `mergeUnmanagedBundleHandler` and asserts the contract.
 *
 * Scope wiring (mutate + DESTRUCTIVE + MUTATING) is covered separately by
 * `mcp_token_scopes.test.ts`; this spec focuses on the data flow:
 * twin lookup → DiscoveredService mapping → mergeServices call → response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DigitalTwinStore } from '../store/twin';
import { mergeUnmanagedBundleHandler, TOOL_SCOPES } from './server';
import type { ServiceBundle } from '../unmanaged/bundleShared';

// Mock the merge pipeline + node-connection lookup so the handler runs
// without touching podman, systemd, or the filesystem.
vi.mock('../migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../migration')>();
  return {
    ...actual,
    mergeServices: vi.fn(),
  };
});
vi.mock('../nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes')>();
  return {
    ...actual,
    getNodeConnection: vi.fn().mockResolvedValue(undefined),
  };
});

import { mergeServices } from '../migration';
const mockedMergeServices = vi.mocked(mergeServices);

function seedBundle(nodeName: string, bundle: ServiceBundle) {
  const store = DigitalTwinStore.getInstance();
  if (!store.nodes[nodeName]) store.registerNode(nodeName);
  store.nodes[nodeName].unmanagedBundles = [bundle];
}

function makeBundle(overrides: Partial<ServiceBundle> = {}): ServiceBundle {
  return {
    id: 'bundle-1',
    displayName: 'wordpress + mysql',
    derivedName: 'wordpress',
    nodeName: 'Local',
    severity: 'warning',
    hints: ['compose-managed pair'],
    validations: [],
    services: [
      {
        serviceName: 'wordpress.service',
        containerNames: ['wp'],
        containerIds: ['c-wp'],
        unitFile: '/etc/systemd/system/wordpress.service',
        sourcePath: '/etc/systemd/system/wordpress.service',
        status: 'unmanaged',
        type: 'container',
        nodeName: 'Local',
        discoveryHints: ['compose'],
      },
      {
        serviceName: 'mysql.service',
        containerNames: ['mysql'],
        containerIds: ['c-mysql'],
        unitFile: '/etc/systemd/system/mysql.service',
        sourcePath: '/etc/systemd/system/mysql.service',
        status: 'unmanaged',
        type: 'container',
        nodeName: 'Local',
        discoveryHints: ['compose'],
      },
    ],
    containers: [],
    ports: [],
    assets: [],
    graph: [],
    ...overrides,
  };
}

describe('mergeUnmanagedBundleHandler (ARCH-14, #846)', () => {
  beforeEach(() => {
    mockedMergeServices.mockReset();
    // Wipe twin between tests so seeds don't leak.
    const store = DigitalTwinStore.getInstance();
    store.nodes = {};
  });

  it('returns an error when the bundle id is not in the twin', async () => {
    const result = await mergeUnmanagedBundleHandler({
      bundleId: 'does-not-exist',
      newName: 'foo',
      nodeName: 'Local',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No unmanaged bundle "does-not-exist"');
    expect(mockedMergeServices).not.toHaveBeenCalled();
  });

  it('refuses bundles with fewer than 2 services (nothing to merge)', async () => {
    const single = makeBundle({ services: [makeBundle().services[0]] });
    seedBundle('Local', single);
    const result = await mergeUnmanagedBundleHandler({
      bundleId: single.id,
      newName: 'foo',
      nodeName: 'Local',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fewer than 2 services');
    expect(mockedMergeServices).not.toHaveBeenCalled();
  });

  it('dryRun returns the migration plan without applying', async () => {
    seedBundle('Local', makeBundle());
    mockedMergeServices.mockResolvedValue({
      filesToCreate: ['/x/foo.kube', '/x/foo.yml'],
      filesToBackup: [],
      servicesToStop: ['wordpress.service', 'mysql.service'],
      targetName: 'foo',
      backupDir: '/var/lib/sb/backups',
      backupArchive: '/var/lib/sb/backups/foo-*.tar.gz',
      stackPreview: 'apiVersion: v1\nkind: Pod\n',
      validations: [],
      fileMappings: [],
    });

    const result = await mergeUnmanagedBundleHandler({
      bundleId: 'bundle-1',
      newName: 'foo',
      nodeName: 'Local',
      dryRun: true,
    });

    expect(result.isError).toBeUndefined();
    expect(mockedMergeServices).toHaveBeenCalledTimes(1);
    // Verify the dryRun flag was forwarded.
    expect(mockedMergeServices.mock.calls[0][2]).toMatchObject({ dryRun: true, initiator: 'mcp' });
    const payload = JSON.parse(result.content[0].text) as { dryRun: boolean; plan: { targetName: string } };
    expect(payload.dryRun).toBe(true);
    expect(payload.plan.targetName).toBe('foo');
  });

  it('non-dryRun executes the merge and returns the mergedServices list', async () => {
    seedBundle('Local', makeBundle());
    mockedMergeServices.mockResolvedValue(undefined as unknown as void);

    const result = await mergeUnmanagedBundleHandler({
      bundleId: 'bundle-1',
      newName: 'foo',
      nodeName: 'Local',
    });

    expect(result.isError).toBeUndefined();
    expect(mockedMergeServices).toHaveBeenCalledTimes(1);
    expect(mockedMergeServices.mock.calls[0][2]).toMatchObject({ dryRun: false, initiator: 'mcp' });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; newName: string; mergedServices: string[] };
    expect(payload.ok).toBe(true);
    expect(payload.newName).toBe('foo');
    expect(payload.mergedServices).toEqual(['wordpress.service', 'mysql.service']);
  });

  it('maps BundleServiceRef → DiscoveredService with the expected shape', async () => {
    seedBundle('Local', makeBundle());
    mockedMergeServices.mockResolvedValue(undefined as unknown as void);

    await mergeUnmanagedBundleHandler({
      bundleId: 'bundle-1',
      newName: 'foo',
      nodeName: 'Local',
    });

    const [services] = mockedMergeServices.mock.calls[0];
    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({
      serviceName: 'wordpress.service',
      containerIds: ['c-wp'],
      status: 'unmanaged',
      type: 'container',
      nodeName: 'Local',
    });
    // Optional fields propagate.
    expect(services[0].unitFile).toBe('/etc/systemd/system/wordpress.service');
    expect(services[0].sourcePath).toBe('/etc/systemd/system/wordpress.service');
  });

  it('wires the destructive-tool scope', () => {
    // Pin the safety-gate wiring so a future refactor that drops the scope
    // entry fails this spec rather than silently downgrading the gate.
    expect(TOOL_SCOPES.merge_unmanaged_bundle).toBe('mutate');
    expect(TOOL_SCOPES.get_unmanaged_bundles).toBe('read');
  });
});
