/**
 * Kube-play (#2742) — the one phase that actually mutates the node.
 *
 * What is asserted here: the order the box-touching steps run in (the #2417
 * rotation pre-flight before the first attempt, the OIDC reconcile only after
 * a success), what does and does not travel on the wire (#2503: never a
 * script body), how the progress stream reaches the job log, and the retry
 * policy — a transient failure is retried, a 4xx is not, and neither one is
 * ever reported as a successful deploy (#2601).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeployContext } from './context';
import type { JobInputItem } from '../jobStore';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
const patchJobMock = vi.fn();
const apiFetchMock = vi.fn<(p: string, init?: RequestInit) => Promise<Response>>();
const isJobAbortedMock = vi.fn<(jobId: string) => boolean>();
vi.mock('./context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
  patchJob: (...args: unknown[]) => patchJobMock(...args),
  apiFetch: (...args: [string, RequestInit?]) => apiFetchMock(...args),
  isJobAborted: (jobId: string) => isJobAbortedMock(jobId),
}));

const assetTransportMock = vi.fn();
const loadPostDeployScriptMock = vi.fn<(name: string, source?: string) => Promise<string | undefined>>();
const preserveClientsMock = vi.fn<() => Promise<string | null>>();
const buildPostDeployEnvMock = vi.fn();
vi.mock('./assetTransport', () => ({
  runAssetTransportPhase: (...args: unknown[]) => assetTransportMock(...args),
  loadPostDeployScript: (name: string, source?: string) => loadPostDeployScriptMock(name, source),
  preserveAutheliaOidcClients: () => preserveClientsMock(),
  buildPostDeployEnv: (...args: unknown[]) => buildPostDeployEnvMock(...args),
}));

const migrationsMock = vi.fn();
vi.mock('./migrations', () => ({ runMigrationsPhase: (...args: unknown[]) => migrationsMock(...args) }));

const siblingsMock = vi.fn<(name: string) => string[]>();
vi.mock('@servicebay/backup-manifest', () => ({
  getSiblingBackupServices: (name: string) => siblingsMock(name),
}));

const wipeMock = vi.fn();
const autoRestoreMock = vi.fn();
vi.mock('@/lib/externalBackup/restore', () => ({
  wipeServiceForReinstall: (...args: unknown[]) => wipeMock(...args),
  autoRestoreServiceOnReinstall: (...args: unknown[]) => autoRestoreMock(...args),
}));

const assertRotationSafeMock = vi.fn();
const reconcileOidcMock = vi.fn();
vi.mock('@/lib/capabilities/servicebayOidcSecret', () => ({
  assertServicebayOidcRotationSafe: (...args: unknown[]) => assertRotationSafeMock(...args),
  reconcileServicebayOidcSecret: (...args: unknown[]) => reconcileOidcMock(...args),
}));

import { runKubePlayPhase } from './kubePlay';

const ctx = (): DeployContext => ({
  jobId: 'job1',
  input: {
    items: [{ name: 'media', checked: true }, { name: 'auth', checked: true }, { name: 'off', checked: false }],
    variables: [],
    templateSource: 'Built-in',
    host: 'servicebay.local',
  },
  scriptCredentials: [],
  deployed: [],
  reusedSecretNames: new Set<string>(),
});

const item = (over: Partial<JobInputItem> = {}): JobInputItem => ({
  name: 'media',
  checked: true,
  yaml: 'spec: {}\n',
  ...over,
});

/** An NDJSON progress stream, the shape /api/services?stream=1 emits. */
const streamed = (events: unknown[]) =>
  new Response(events.map(e => JSON.stringify(e)).join('\n') + '\n', { status: 200 });

const lines = () => logMock.mock.calls.map(c => c[1]);
const postBody = (call = 0) => JSON.parse(String((apiFetchMock.mock.calls[call][1] as RequestInit).body));

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  patchJobMock.mockReset().mockResolvedValue(null);
  apiFetchMock.mockReset().mockImplementation(async () => streamed([]));
  isJobAbortedMock.mockReset().mockReturnValue(false);
  assetTransportMock.mockReset().mockResolvedValue({
    yamlContent: 'rendered: pod\n',
    kubeContent: '[Kube]\n',
    extraFiles: [{ path: '/mnt/data/stacks/media/app.conf', content: 'k=v' }],
  });
  loadPostDeployScriptMock.mockReset().mockResolvedValue(undefined);
  preserveClientsMock.mockReset().mockResolvedValue(null);
  buildPostDeployEnvMock.mockReset().mockResolvedValue({ HOST: 'servicebay.local' });
  migrationsMock.mockReset().mockResolvedValue(undefined);
  siblingsMock.mockReset().mockReturnValue([]);
  wipeMock.mockReset().mockResolvedValue(undefined);
  autoRestoreMock.mockReset().mockResolvedValue(undefined);
  assertRotationSafeMock.mockReset().mockResolvedValue(undefined);
  reconcileOidcMock.mockReset().mockResolvedValue(null);
});

describe('runKubePlayPhase — an item with nothing to deploy', () => {
  it('says the manifest carries no spec instead of returning silently (#2601)', async () => {
    // Pre-fix this returned false with no log, so a run that deployed nothing
    // was indistinguishable from a successful install.
    const ok = await runKubePlayPhase(ctx(), item({ yaml: undefined }));
    expect(ok).toBe(false);
    expect(lines()).toEqual(['❌ media carries no template spec in this manifest — nothing was deployed for it.']);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('runKubePlayPhase — the successful deploy', () => {
  it('reports progress on the job and deploys, ending with the green line', async () => {
    const c = ctx();
    c.deployed.push({ name: 'auth' });

    const ok = await runKubePlayPhase(c, item());

    expect(ok).toBe(true);
    expect(patchJobMock).toHaveBeenCalledWith('job1', {
      progress: { currentItem: 'media', deployedNames: ['auth'], totalCount: 2 },
    });
    expect(lines()[0]).toBe('Installing media...');
    expect(lines().at(-1)).toBe('✅ media deployed (containers may still be starting in background).');
  });

  it('wipes and restores the service AND its sibling stores before the pod starts (#1594)', async () => {
    siblingsMock.mockReturnValue(['home-assistant-zwave']);
    const c = ctx();
    c.input.wipeMode = 'wipe-config';
    c.input.node = 'box2';

    await runKubePlayPhase(c, item({ name: 'home-assistant' }));

    expect(wipeMock.mock.calls.map(call => call[0])).toEqual(['home-assistant', 'home-assistant-zwave']);
    expect(wipeMock.mock.calls[0][1]).toEqual({ wipeMode: 'wipe-config', node: 'box2' });
    expect(autoRestoreMock.mock.calls.map(call => call[0])).toEqual(['home-assistant', 'home-assistant-zwave']);
  });

  it('POSTs the complete resolved artifact set — and never a script body (#2503/#2703)', async () => {
    loadPostDeployScriptMock.mockResolvedValue('#!/usr/bin/env python3\nprint("hi")\n');
    migrationsMock.mockResolvedValue([
      { filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2, content: 'BODY THAT MUST NOT SHIP' },
    ]);

    await runKubePlayPhase(ctx(), item());

    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/services?stream=1');
    const body = postBody();
    expect(body).toMatchObject({
      name: 'media',
      yamlFileName: 'media.yml',
      completeDelivery: true,
      templateSource: 'Built-in',
      postDeployEnv: { HOST: 'servicebay.local' },
      migrations: [{ filename: 'v1-to-v2.py', fromVersion: 1, toVersion: 2 }],
    });
    // The body travels by reference only — an arbitrary script on the wire
    // would be executable via /api/services.
    expect(JSON.stringify(body)).not.toContain('BODY THAT MUST NOT SHIP');
    expect(body).not.toHaveProperty('postDeployScript');
  });

  it('routes the deploy at the install node when there is one', async () => {
    const c = ctx();
    c.input.node = 'box2';
    await runKubePlayPhase(c, item());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/services?node=box2&stream=1');
  });

  it('omits postDeployEnv entirely when there is neither a script nor a migration', async () => {
    await runKubePlayPhase(ctx(), item());
    expect(postBody().postDeployEnv).toBeUndefined();
  });

  it('streams the route’s progress into the job log', async () => {
    apiFetchMock.mockResolvedValue(streamed([
      { type: 'progress', message: 'Writing media.yml' },
      { type: 'progress', message: 'Starting media.service' },
    ]));

    await runKubePlayPhase(ctx(), item());

    expect(lines()).toContain('Writing media.yml');
    expect(lines()).toContain('Starting media.service');
  });

  it('captures a __SB_CREDENTIAL__ marker and tags it with the owning template (#1626)', async () => {
    const c = ctx();
    apiFetchMock.mockResolvedValue(streamed([
      { type: 'progress', message: '__SB_CREDENTIAL__ ' + JSON.stringify({ label: 'Jellyfin admin', username: 'admin' }) },
      { type: 'progress', message: '__SB_CREDENTIAL__ not json at all' },
    ]));

    await runKubePlayPhase(c, item());

    expect(c.scriptCredentials).toEqual([{ label: 'Jellyfin admin', username: 'admin', template: 'media' }]);
    // The markers are consumed, never echoed into the operator's log.
    expect(lines().some(l => l.includes('__SB_CREDENTIAL__'))).toBe(false);
  });

  it('runs the #2417 rotation pre-flight BEFORE the first attempt, and the reconcile only after success', async () => {
    reconcileOidcMock.mockResolvedValue({ outcome: 'changed', message: 'adopted the on-disk secret' });
    const order: string[] = [];
    assertRotationSafeMock.mockImplementation(async () => { order.push('assert'); });
    apiFetchMock.mockImplementation(async () => { order.push('deploy'); return streamed([]); });
    reconcileOidcMock.mockImplementation(async () => { order.push('reconcile'); return { outcome: 'changed', message: 'adopted the on-disk secret' }; });

    await runKubePlayPhase(ctx(), item({ name: 'auth' }));

    expect(order).toEqual(['assert', 'deploy', 'reconcile']);
    expect(lines()).toContain('🔑 adopted the on-disk secret');
  });

  it('surfaces a skipped OIDC reconcile as a warning, not a failure', async () => {
    reconcileOidcMock.mockResolvedValue({ outcome: 'skipped', message: 'box unreachable' });
    const ok = await runKubePlayPhase(ctx(), item({ name: 'auth' }));
    expect(ok).toBe(true);
    expect(lines()).toContain('⚠️ box unreachable');
  });

  it('aborts with the box untouched when the rotation would lock the operator out', async () => {
    assertRotationSafeMock.mockRejectedValue(new Error('refusing to rotate the only door'));

    await expect(runKubePlayPhase(ctx(), item({ name: 'auth' })))
      .rejects.toThrow('refusing to rotate the only door');

    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('runKubePlayPhase — failure and retry policy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const drive = async (p: Promise<boolean>) => {
    await vi.advanceTimersByTimeAsync(10_000);
    return p;
  };

  it('retries a transient failure and reports which attempt landed it', async () => {
    apiFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'agent busy' }), { status: 503 }))
      .mockResolvedValue(streamed([]));

    const ok = await drive(runKubePlayPhase(ctx(), item()));

    expect(ok).toBe(true);
    expect(lines()).toContain('⏳ media attempt 1/3 failed (agent busy); retrying in 1s…');
    expect(lines().at(-1)).toBe('✅ media deployed on attempt 2/3.');
  });

  it('gives up after three attempts and states the cost', async () => {
    apiFetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'agent busy' }), { status: 503 }));

    const ok = await drive(runKubePlayPhase(ctx(), item()));

    expect(ok).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    expect(lines().at(-1)).toBe('❌ Failed to install media after 3 attempt(s): agent busy');
  });

  it('does not retry a 4xx — the request will never become valid', async () => {
    apiFetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'template not found' }), { status: 404 }));

    const ok = await drive(runKubePlayPhase(ctx(), item()));

    expect(ok).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(lines().at(-1)).toBe('❌ Failed to install media template not found');
  });

  it('does retry a 429 and a 408 — those are transient by definition', async () => {
    apiFetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 408 }))
      .mockResolvedValue(streamed([]));

    expect(await drive(runKubePlayPhase(ctx(), item()))).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('labels a transport failure as a network error', async () => {
    apiFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const ok = await drive(runKubePlayPhase(ctx(), item()));
    expect(ok).toBe(false);
    expect(lines().at(-1)).toBe('❌ Failed to install media after 3 attempt(s): network: ECONNREFUSED');
  });

  it('fails the deploy when the stream itself reports an error event', async () => {
    apiFetchMock.mockImplementation(async () => streamed([
      { type: 'progress', message: 'Writing media.yml' },
      { type: 'error', message: 'kube play exited 125' },
    ]));

    const ok = await drive(runKubePlayPhase(ctx(), item()));

    expect(ok).toBe(false);
    expect(lines().at(-1)).toBe('❌ Failed to install media after 3 attempt(s): kube play exited 125');
    // The reconcile must not run for a deploy that never landed.
    expect(reconcileOidcMock).not.toHaveBeenCalled();
  });

  it('stops before the first attempt once the operator aborts', async () => {
    isJobAbortedMock.mockReturnValue(true);
    const ok = await drive(runKubePlayPhase(ctx(), item()));
    expect(ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
