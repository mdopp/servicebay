/**
 * #2784 — every converted list getter drops the ONE malformed row and keeps
 * the rest, instead of throwing/emptying the whole list.
 *
 * Each case feeds the getter a response with N good rows plus one row that
 * fails the row schema (usually a required field the backend emitted before
 * it existed — the batch-10 Health-tab repro shape) and asserts the good
 * rows still arrive. The helper's own behaviour (counts, the warn line, the
 * non-array throw) is covered in `lenient.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '@/lib/logger-client';
import { getHealthChecks, getHealthCheckHistory, getNodeServices, getNodeSystemServices, getExternalLinks, getStacks } from './dashboards';
import { fetchServiceSummaries } from './services';
import { fetchNetworkGraph } from './network';
import { fetchPendingTemplateUpgrades, fetchTemplateUpgradePreview } from './install';
import {
  fetchBootStatus,
  fetchAccessRequests,
  fetchApiTokens,
  fetchApprovals,
  fetchSystemCredentials,
  fetchSambaUsers,
  fetchMcpAudit,
  bulkRevokeApiTokens,
} from './settings';
import { runSystemDiagnose, fetchStorageLayout } from './system';
import {
  listImportDevices,
  fetchDiskImportStatus,
  fetchDiskImportTree,
  listImportProfiles,
} from './diskImport';
import { fetchAssistsList, fetchAssistHistory } from './assists';

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })),
  );
}

beforeEach(() => vi.spyOn(logger, 'warn').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- dashboards.ts ---------------------------------------------------------

const GOOD_CHECK = {
  id: 'c1',
  name: 'Jellyfin',
  type: 'http',
  target: 'https://example.invalid',
  interval: 60,
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  status: 'ok',
  lastRun: null,
  lastResult: null,
  history: [],
};

describe('getHealthChecks — the batch-10 repro', () => {
  it('renders the rows that parse when one row is missing interval/enabled/created_at', async () => {
    // Exactly the row shape that emptied the Health tab in batch 10.
    stubFetch([
      GOOD_CHECK,
      { id: 'c2', name: 'partial', type: 'ping', target: 'box', status: 'ok', lastRun: null, lastResult: null, history: [] },
      { ...GOOD_CHECK, id: 'c3', name: 'Nextcloud' },
    ]);
    const checks = await getHealthChecks();
    expect(checks.map(c => c.id)).toEqual(['c1', 'c3']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('getHealthCheckHistory', () => {
  it('drops the malformed history row, keeps the rest', async () => {
    stubFetch([
      { status: 'ok', latency: 12, timestamp: 't1' },
      { status: 'maybe', latency: 3, timestamp: 't2' },
      { status: 'fail', latency: 40, timestamp: 't3' },
    ]);
    expect((await getHealthCheckHistory('c1')).map(h => h.timestamp)).toEqual(['t1', 't3']);
  });
});

describe('getNodeServices / getNodeSystemServices / getExternalLinks / getStacks', () => {
  it('getNodeServices keeps the named rows', async () => {
    stubFetch([{ name: 'media' }, { noName: true }, { name: 'photos' }]);
    expect((await getNodeServices('Local')).map(s => s.name)).toEqual(['media', 'photos']);
  });

  it('getNodeSystemServices keeps the unit rows', async () => {
    stubFetch([{ unit: 'a.service' }, {}, { unit: 'b.service' }]);
    expect((await getNodeSystemServices('Local')).map(s => s.unit)).toEqual(['a.service', 'b.service']);
  });

  it('getExternalLinks keeps the named links', async () => {
    stubFetch([{ name: 'router' }, { url: 'no-name' }, { name: 'nas' }]);
    expect((await getExternalLinks()).map(l => l.name)).toEqual(['router', 'nas']);
  });

  it('getStacks keeps the parseable stacks', async () => {
    stubFetch({ stacks: [{ name: 'solaris' }, { manifest: null }, { name: 'media' }] });
    expect((await getStacks()).stacks.map(s => s.name)).toEqual(['solaris', 'media']);
  });
});

// --- services.ts -----------------------------------------------------------

describe('fetchServiceSummaries', () => {
  it('drops the row whose name is not a string', async () => {
    stubFetch([{ name: 'media', active: true }, { name: 42 }, { name: 'photos' }]);
    expect((await fetchServiceSummaries()).map(s => s.name)).toEqual(['media', 'photos']);
  });
});

// --- network.ts ------------------------------------------------------------

describe('fetchNetworkGraph', () => {
  it('drops the id-less node and edge instead of collapsing the graph', async () => {
    stubFetch({
      nodes: [{ id: 'n1' }, { label: 'no id' }, { id: 'n2' }],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }, { source: 'n1' }],
    });
    const graph = await fetchNetworkGraph();
    expect(graph.nodes.map(n => n.id)).toEqual(['n1', 'n2']);
    expect(graph.edges.map(e => e.id)).toEqual(['e1']);
  });
});

// --- install.ts ------------------------------------------------------------

const GOOD_UPGRADE = {
  name: 'jellyfin',
  installedVersion: 1,
  currentVersion: 2,
  hasBreakingChange: false,
  sectionHeaders: [],
};

describe('fetchPendingTemplateUpgrades / fetchTemplateUpgradePreview', () => {
  it('keeps the pending upgrades that parse', async () => {
    stubFetch({
      pending: [GOOD_UPGRADE, { name: 'broken' }, { ...GOOD_UPGRADE, name: 'nextcloud' }],
      hasBreakingChange: false,
    });
    const res = await fetchPendingTemplateUpgrades();
    expect(res.pending.map(p => p.name)).toEqual(['jellyfin', 'nextcloud']);
  });

  it('keeps the changelog sections that parse', async () => {
    stubFetch({
      installedVersion: 1,
      currentVersion: 3,
      hasUpgrade: true,
      hasBreakingChange: false,
      sections: [
        { version: 2, breaking: false, body: 'two' },
        { version: 'three', breaking: false, body: 'bad' },
        { version: 3, breaking: true, body: 'three' },
      ],
    });
    const res = await fetchTemplateUpgradePreview('jellyfin');
    expect(res.sections.map(s => s.version)).toEqual([2, 3]);
  });
});

// --- settings.ts -----------------------------------------------------------

const GOOD_BOOT = { bootNum: '0001', name: 'usb', active: true, description: 'USB', current: false };

describe('settings list getters', () => {
  it('fetchBootStatus keeps the parseable entries and candidates', async () => {
    stubFetch({
      entries: [GOOD_BOOT, { bootNum: '0002' }],
      candidates: [{ ...GOOD_BOOT, bootNum: '0003' }, {}],
      bootNext: null,
      bootCurrent: null,
      bootOrder: [],
    });
    const status = await fetchBootStatus();
    expect(status.entries.map(e => e.bootNum)).toEqual(['0001']);
    expect(status.candidates.map(e => e.bootNum)).toEqual(['0003']);
  });

  it('fetchAccessRequests keeps the parseable requests', async () => {
    stubFetch({
      requests: [
        { id: 'r1', requestedAt: 't', name: 'A', email: 'a@example.invalid', status: 'pending' },
        { id: 'r2', requestedAt: 't', name: 'B', status: 'pending' },
      ],
    });
    expect((await fetchAccessRequests()).requests.map(r => r.id)).toEqual(['r1']);
  });

  it('fetchApiTokens keeps the parseable tokens', async () => {
    stubFetch({
      tokens: [
        { id: 't1', name: 'cli', scopes: [], prefix: 'sb_a', createdAt: 't', createdBy: 'me' },
        { id: 't2', name: 'legacy', scopes: [], prefix: 'sb_b', createdAt: 't' },
      ],
    });
    expect((await fetchApiTokens()).tokens.map(t => t.id)).toEqual(['t1']);
  });

  it('fetchApprovals keeps the parseable approvals', async () => {
    stubFetch({
      approvals: [
        { id: 'a1', service: 's', title: 'T', description: null, payload: {}, node: 'Local', created_at: 't', status: 'pending' },
        { id: 'a2', service: 's', title: 'T', description: null, payload: {}, node: 'Local', created_at: 't' },
      ],
    });
    expect((await fetchApprovals()).approvals.map(a => a.id)).toEqual(['a1']);
  });

  it('fetchSystemCredentials keeps the parseable credentials and proxy hosts', async () => {
    stubFetch({
      manifest: {
        savedAt: 't',
        credentials: [
          { service: 's1', url: 'https://a.invalid', username: 'u', secured: true },
          { service: 's2', url: 'https://b.invalid', username: 'u' },
        ],
      },
      proxyHosts: [{ domain: 'a.invalid', service: 's1' }, { domain: 'b.invalid' }],
      publicDomain: null,
    });
    const res = await fetchSystemCredentials();
    expect(res.manifest?.credentials.map(c => c.service)).toEqual(['s1']);
    expect(res.proxyHosts.map(h => h.domain)).toEqual(['a.invalid']);
  });

  it('fetchSambaUsers keeps the parseable users', async () => {
    stubFetch({
      ok: true,
      users: [{ id: 'u1', presentInSamba: true }, { id: 'u2' }],
      added: [],
      removed: [],
    });
    expect((await fetchSambaUsers()).users.map(u => u.id)).toEqual(['u1']);
  });

  it('fetchMcpAudit keeps the parseable audit entries', async () => {
    stubFetch({
      entries: [
        { ts: 't1', tool: 'list_services', outcome: 'ok', durationMs: 4 },
        { ts: 't2', tool: 'diagnose', outcome: 'ok' },
      ],
    });
    expect((await fetchMcpAudit()).entries?.map(e => e.ts)).toEqual(['t1']);
  });

  it('bulkRevokeApiTokens keeps the parseable per-token results', async () => {
    stubFetch({ requested: 2, revoked: 1, results: [{ id: 'a', ok: true }, { ok: false }] });
    expect((await bulkRevokeApiTokens(['a', 'b'])).results.map(r => r.id)).toEqual(['a']);
  });
});

// --- system.ts -------------------------------------------------------------

describe('system list getters', () => {
  it('runSystemDiagnose keeps the parseable probes', async () => {
    stubFetch({
      node: 'Local',
      probes: [
        { id: 'p1', label: 'DNS', status: 'ok', detail: 'fine' },
        { id: 'p2', label: 'Proxy' },
      ],
    });
    expect((await runSystemDiagnose()).probes.map(p => p.id)).toEqual(['p1']);
  });

  it('fetchStorageLayout keeps the parseable raids and drives', async () => {
    stubFetch({
      raids: [
        { device: '/dev/md0', label: 'data', fstype: 'ext4', size: '8T', mountpoint: '/mnt/data', degraded: false },
        { device: '/dev/md1' },
      ],
      drives: [{ name: 'sda', path: '/dev/sda', type: 'disk', size: '4T' }, { name: 'sdb' }],
    });
    const layout = await fetchStorageLayout('Local');
    expect(layout.raids?.map(r => r.device)).toEqual(['/dev/md0']);
    expect(layout.drives?.map(d => d.name)).toEqual(['sda']);
  });
});

// --- diskImport.ts ---------------------------------------------------------

const GOOD_REVIEW_NODE = {
  dir: '/photos',
  files: 2,
  bytes: 10,
  categories: [],
  explicit: {},
  resolved: { disposition: 'copy', mode: 'flat', owner: 'me', anchor: '/' },
  preview: '/mnt/photos',
};

describe('diskImport list getters', () => {
  it('listImportDevices drops the malformed device instead of emptying the picker', async () => {
    stubFetch({ ok: true, devices: [{ path: '/dev/sdb1', display: 'USB' }, { path: '/dev/sdc1' }] });
    expect((await listImportDevices()).map(d => d.path)).toEqual(['/dev/sdb1']);
  });

  it('fetchDiskImportStatus keeps the parseable category rollups', async () => {
    stubFetch({
      ok: true,
      runId: 'r1',
      running: true,
      status: {
        phase: 'scan',
        step: 'walk',
        mode: 'dry-run',
        scanned: 1,
        planned: 1,
        applied: 0,
        conflicts: 0,
        categories: [
          { category: 'photos', files: 1, bytes: 2, copy: 1, skipDupe: 0, conflict: 0 },
          { category: 42 },
        ],
        error: null,
      },
    });
    const res = await fetchDiskImportStatus();
    expect(res.status?.categories?.map(c => c.category)).toEqual(['photos']);
  });

  it('fetchDiskImportTree keeps the parseable tree nodes and owners', async () => {
    stubFetch({
      ok: true,
      tree: [GOOD_REVIEW_NODE, { dir: '/broken' }],
      owners: [{ id: 'o1', label: 'Me' }, { id: 'o2' }],
      dispositions: [],
      mountBase: '/mnt',
    });
    const res = await fetchDiskImportTree();
    expect(res.tree.map(t => t.dir)).toEqual(['/photos']);
    expect(res.owners.map(o => o.id)).toEqual(['o1']);
  });

  it('listImportProfiles keeps the parseable presets', async () => {
    stubFetch({ ok: true, profiles: [{ name: 'p1', rules: {}, savedAt: 1 }, { rules: {} }] });
    expect((await listImportProfiles()).map(p => p.name)).toEqual(['p1']);
  });
});

// --- assists.ts ------------------------------------------------------------

describe('assists list getters', () => {
  it('fetchAssistsList keeps the parseable catalog entries', async () => {
    stubFetch({
      assists: [
        { id: 'a1', title: 'T', whenToUse: 'w', kind: 'guide', tags: [], source: 'Built-in' },
        { id: 'a2', title: 'T' },
      ],
    });
    expect((await fetchAssistsList()).assists.map(a => a.id)).toEqual(['a1']);
  });

  it('fetchAssistHistory keeps the parseable history rows', async () => {
    stubFetch({
      id: 'a1',
      history: [
        { version: 2, author: 'me', timestamp: 't', message: 'm' },
        { version: 1, author: 'me' },
      ],
    });
    expect((await fetchAssistHistory('a1')).history.map(h => h.version)).toEqual([2]);
  });

});
