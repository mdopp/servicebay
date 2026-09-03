/**
 * Post-deploy (#2742) — everything that runs once the pods are on the box.
 *
 * The phase owns no job status: the runner does. So the contract asserted
 * here is (a) the ORDER, which is load-bearing — the NPM admin heal has to
 * precede proxy-host + portal provisioning, and the settle-wait has to
 * precede the portal provision or it fires at containers that aren't up yet
 * — (b) that `aborted` is raised only by the operator cancelling the
 * credentials prompt, and (c) that every other step degrades to a note.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeployContext } from './context';
import type { JobInput } from '../jobStore';
import type { Credential } from '@/lib/stackInstall/credentialsManifest';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
const patchJobMock = vi.fn();
const apiFetchMock = vi.fn<(p: string, init?: RequestInit) => Promise<Response>>();
const isJobAbortedMock = vi.fn<(jobId: string) => boolean>();
const appendJobWarningMock = vi.fn();
vi.mock('./context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
  patchJob: (...args: unknown[]) => patchJobMock(...args),
  apiFetch: (...args: [string, RequestInit?]) => apiFetchMock(...args),
  isJobAborted: (jobId: string) => isJobAbortedMock(jobId),
  appendJobWarning: (...args: unknown[]) => appendJobWarningMock(...args),
}));

const settleWaitMock = vi.fn();
vi.mock('./readiness', () => ({ settleWait: (...args: unknown[]) => settleWaitMock(...args) }));

const bootstrapHealthMock = vi.fn();
vi.mock('@/lib/health/serviceHealthBootstrap', () => ({
  bootstrapServiceHealth: (node: string) => bootstrapHealthMock(node),
}));

const bootstrapNpmAdminMock = vi.fn();
vi.mock('@/lib/stackInstall/postInstall', () => ({
  bootstrapNpmAdmin: (opts: unknown) => bootstrapNpmAdminMock(opts),
}));

const waitForCredentialsMock = vi.fn();
vi.mock('../credentialResolver', () => ({
  waitForCredentials: (jobId: string) => waitForCredentialsMock(jobId),
}));

const getConfigMock = vi.fn();
const saveConfigMock = vi.fn();
vi.mock('@/lib/config', () => ({
  getConfig: () => getConfigMock(),
  saveConfig: (cfg: unknown) => saveConfigMock(cfg),
}));

const sendCommandMock = vi.fn();
const ensureAgentMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (node: string) => ensureAgentMock(node) },
}));

const emitMock = vi.fn();
vi.mock('@/lib/capabilities/bus', () => ({ getCapabilityBus: () => ({ emit: emitMock }) }));

const getTemplateYamlMock = vi.fn();
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: (name: string, source?: string) => getTemplateYamlMock(name, source),
}));

const parseManifestMock = vi.fn();
vi.mock('@/lib/template/contract', () => ({
  parseTemplateManifest: (yaml: string) => parseManifestMock(yaml),
}));

const emitWithRetryMock = vi.fn();
const recordHandlerFailureMock = vi.fn();
vi.mock('../handlerFailures', () => ({
  MAX_EMIT_ATTEMPTS: 3,
  emitFeatureInstalledWithRetry: (opts: { emit: () => unknown }) => emitWithRetryMock(opts),
  recordHandlerFailure: (f: unknown) => recordHandlerFailureMock(f),
}));

const npmAdminCredStatusMock = vi.fn();
const rekeyNpmAdminMock = vi.fn();
vi.mock('@/lib/reverseProxy/npmAdminRekey', () => ({
  npmAdminCredStatus: (node: string) => npmAdminCredStatusMock(node),
  rekeyNpmAdmin: (node: string) => rekeyNpmAdminMock(node),
}));

const ensureProxyHostsMock = vi.fn();
const ensureOidcClientsMock = vi.fn();
const ensureHermesApiKeyMock = vi.fn();
vi.mock('../postInstallDispatcher', () => ({
  ensureProxyHosts: (...args: unknown[]) => ensureProxyHostsMock(...args),
  ensureOidcClients: (...args: unknown[]) => ensureOidcClientsMock(...args),
  ensureHermesApiKey: (...args: unknown[]) => ensureHermesApiKeyMock(...args),
}));

const buildCredentialsManifestMock = vi.fn();
const mergeCredentialsMock = vi.fn();
vi.mock('@/lib/stackInstall/credentialsManifest', () => ({
  buildCredentialsManifest: (opts: unknown) => buildCredentialsManifestMock(opts),
  mergeCredentials: (...args: unknown[]) => mergeCredentialsMock(...args),
}));

const provisionPortalMock = vi.fn();
vi.mock('@/lib/stackInstall/portalProvision', () => ({
  provisionPortalWithRetries: (onLog: (l: string) => void) => provisionPortalMock(onLog),
}));

const repointResolverMock = vi.fn();
vi.mock('@/lib/router/boxResolverDns', () => ({
  repointBoxResolverToAdguard: (node: string) => repointResolverMock(node),
}));

import { runPostDeployPhase } from './postDeploy';

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [{ name: 'media', checked: true }],
  variables: [],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

const ctx = (over: Partial<JobInput> = {}, deployed: string[] = ['media']): DeployContext => ({
  jobId: 'job1',
  input: input(over),
  scriptCredentials: [],
  deployed: deployed.map(name => ({ name })),
  reusedSecretNames: new Set<string>(),
});

/** An install where nginx was freshly deployed — the only path that can pause. */
const nginxCtx = (over: Partial<JobInput> = {}) => ctx({
  items: [{ name: 'nginx', checked: true }],
  variables: [
    { name: 'NGINX_ADMIN_EMAIL', value: 'wizard@box' },
    { name: 'NGINX_ADMIN_PASSWORD', value: 'wizard-pw' },
  ],
  ...over,
}, ['nginx']);

const lines = () => logMock.mock.calls.map(c => c[1]);

const cred = (service: string, username: string): Credential => ({
  service,
  url: 'http://servicebay.local',
  username,
  password: 'pw',
  importance: 'critical',
});

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  patchJobMock.mockReset().mockResolvedValue(null);
  apiFetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  isJobAbortedMock.mockReset().mockReturnValue(false);
  appendJobWarningMock.mockReset().mockResolvedValue(undefined);
  settleWaitMock.mockReset().mockResolvedValue(undefined);
  bootstrapHealthMock.mockReset().mockResolvedValue(undefined);
  bootstrapNpmAdminMock.mockReset().mockResolvedValue('ok');
  waitForCredentialsMock.mockReset().mockResolvedValue(null);
  getConfigMock.mockReset().mockResolvedValue({});
  saveConfigMock.mockReset().mockResolvedValue(undefined);
  sendCommandMock.mockReset().mockResolvedValue({ stdout: '' });
  ensureAgentMock.mockReset().mockResolvedValue({ sendCommand: sendCommandMock });
  emitMock.mockReset().mockResolvedValue([]);
  getTemplateYamlMock.mockReset().mockResolvedValue('kind: Pod\n');
  parseManifestMock.mockReset().mockReturnValue({ ok: true, manifest: { name: 'media' } });
  emitWithRetryMock.mockReset().mockResolvedValue({ failures: [] });
  recordHandlerFailureMock.mockReset().mockResolvedValue(undefined);
  npmAdminCredStatusMock.mockReset().mockResolvedValue('ok');
  rekeyNpmAdminMock.mockReset().mockResolvedValue({ ok: true, message: 're-keyed' });
  ensureProxyHostsMock.mockReset().mockResolvedValue(undefined);
  ensureOidcClientsMock.mockReset().mockResolvedValue(undefined);
  ensureHermesApiKeyMock.mockReset().mockResolvedValue(undefined);
  buildCredentialsManifestMock.mockReset().mockReturnValue([]);
  mergeCredentialsMock.mockReset().mockReturnValue([]);
  provisionPortalMock.mockReset().mockResolvedValue(undefined);
  repointResolverMock.mockReset().mockResolvedValue({ result: 'ok', detail: 'resolver re-pointed' });
});

describe('runPostDeployPhase — the order the steps have to run in', () => {
  it('heals NPM admin before provisioning, and settles before the portal', async () => {
    const order: string[] = [];
    npmAdminCredStatusMock.mockImplementation(async () => { order.push('npm-heal-check'); return 'ok'; });
    ensureProxyHostsMock.mockImplementation(async () => { order.push('proxy-hosts'); });
    ensureOidcClientsMock.mockImplementation(async () => { order.push('oidc-clients'); });
    ensureHermesApiKeyMock.mockImplementation(async () => { order.push('hermes-key'); });
    settleWaitMock.mockImplementation(async () => { order.push('settle'); });
    provisionPortalMock.mockImplementation(async () => { order.push('portal'); });
    repointResolverMock.mockImplementation(async () => { order.push('resolver'); return { result: 'ok', detail: 'd' }; });

    const result = await runPostDeployPhase(ctx());

    expect(result).toEqual({ aborted: false });
    expect(order).toEqual([
      'npm-heal-check', 'proxy-hosts', 'oidc-clients', 'hermes-key', 'settle', 'portal', 'resolver',
    ]);
  });

  it('registers the deployed services with the health poller first', async () => {
    const c = ctx({ node: 'box2' });
    await runPostDeployPhase(c);
    expect(bootstrapHealthMock).toHaveBeenCalledWith('box2');
    expect(settleWaitMock).toHaveBeenCalledWith('job1', c.deployed, 'box2');
  });

  it('notes a failed health registration and carries on', async () => {
    bootstrapHealthMock.mockRejectedValue(new Error('poller down'));
    await runPostDeployPhase(ctx());
    expect(lines()).toContain("(note) couldn't refresh service-health registrations: poller down");
  });

  it('treats only NEWLY deployed items as newly deployed', async () => {
    // An already-installed dependency satisfier rides ctx.deployed but must
    // not re-fire its capability events or be reported as new.
    const c = ctx({
      items: [{ name: 'media', checked: true }, { name: 'auth', checked: true, alreadyInstalled: true }],
    }, ['media', 'auth']);

    await runPostDeployPhase(c);

    expect(getTemplateYamlMock).toHaveBeenCalledTimes(1);
    expect(getTemplateYamlMock).toHaveBeenCalledWith('media', 'Built-in');
    expect(ensureOidcClientsMock).toHaveBeenCalledWith('job1', ['media'], c.input.variables);
  });
});

describe('the NPM bootstrap + credentials prompt', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const run = async (c: DeployContext) => {
    const p = runPostDeployPhase(c);
    await vi.advanceTimersByTimeAsync(60_000);
    return p;
  };

  it('never runs for an install that did not deploy nginx', async () => {
    await run(ctx());
    expect(bootstrapNpmAdminMock).not.toHaveBeenCalled();
  });

  it('does nothing more when the wizard credentials bootstrap cleanly', async () => {
    await run(nginxCtx());
    expect(bootstrapNpmAdminMock).toHaveBeenCalledTimes(1);
    expect(waitForCredentialsMock).not.toHaveBeenCalled();
  });

  it('wipes the stale admin DB — certs preserved — and skips the prompt when the retry lands (#704)', async () => {
    bootstrapNpmAdminMock.mockResolvedValueOnce('needs_credentials').mockResolvedValueOnce('ok');
    getConfigMock.mockResolvedValue({ templateSettings: { DATA_DIR: '/srv/stacks' } });

    await run(nginxCtx());

    const cmd = String(sendCommandMock.mock.calls[0][1].command);
    expect(cmd).toContain('rm -rf "/srv/stacks/nginx-proxy-manager/data"');
    expect(cmd).not.toContain('letsencrypt');
    expect(bootstrapNpmAdminMock.mock.calls[1][0]).toMatchObject({ phase: 'retry' });
    expect(waitForCredentialsMock).not.toHaveBeenCalled();
    expect(lines()[0]).toContain('letsencrypt/ certs preserved');
  });

  it('skips the heal on wipe-all — that dir was already cleared by the per-service wipe', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');

    await run(nginxCtx({ wipeMode: 'wipe-all' }));

    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(waitForCredentialsMock).toHaveBeenCalledWith('job1');
  });

  it('prompts with the SAVED credentials, not the ones NPM just rejected', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');
    getConfigMock.mockResolvedValue({ reverseProxy: { npm: { email: 'saved@box', password: 'saved-pw' } } });

    await run(nginxCtx({ wipeMode: 'wipe-all' }));

    expect(patchJobMock).toHaveBeenCalledWith('job1', {
      phase: 'needs_credentials',
      needsCredentials: { fallback: { email: 'saved@box', password: 'saved-pw' } },
    });
  });

  it('falls back to the wizard values when config holds no NPM credentials', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');
    await run(nginxCtx({ wipeMode: 'wipe-all' }));
    expect(patchJobMock).toHaveBeenCalledWith('job1', {
      phase: 'needs_credentials',
      needsCredentials: { fallback: { email: 'wizard@box', password: 'wizard-pw' } },
    });
  });

  it('persists what the operator typed and re-points the in-memory variables at it', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');
    waitForCredentialsMock.mockResolvedValue({ email: 'typed@box', password: 'typed-pw' });
    const c = nginxCtx({ wipeMode: 'wipe-all' });

    const result = await run(c);

    expect(result).toEqual({ aborted: false });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/system/nginx/credentials', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String((apiFetchMock.mock.calls[0][1] as RequestInit).body)))
      .toEqual({ email: 'typed@box', password: 'typed-pw' });
    expect(c.input.variables.map(v => v.value)).toEqual(['typed@box', 'typed-pw']);
    expect(patchJobMock).toHaveBeenCalledWith('job1', { phase: 'running', needsCredentials: undefined });
    expect(lines()).toContain('Saved NPM credentials for future installs.');
  });

  it('continues with a warning when the operator skips the prompt', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');
    waitForCredentialsMock.mockResolvedValue(null);

    const result = await run(nginxCtx({ wipeMode: 'wipe-all' }));

    expect(result).toEqual({ aborted: false });
    expect(lines()).toContain('⚠️ NPM credentials skipped — proxy routes may not be configured.');
    expect(settleWaitMock).toHaveBeenCalled();
  });

  it('is the ONE step that can end the run — an abort at the prompt stops everything after it', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');
    isJobAbortedMock.mockReturnValue(true);

    const result = await run(nginxCtx({ wipeMode: 'wipe-all' }));

    expect(result).toEqual({ aborted: true });
    expect(settleWaitMock).not.toHaveBeenCalled();
    expect(provisionPortalMock).not.toHaveBeenCalled();
  });

  it('falls back to the prompt when the self-heal itself throws', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');
    ensureAgentMock.mockRejectedValue(new Error('agent offline'));

    await run(nginxCtx());

    expect(lines().some(l => l.startsWith('⚠️ NPM self-heal failed (agent offline)'))).toBe(true);
    expect(waitForCredentialsMock).toHaveBeenCalled();
  });

  it('says so when NPM is still rejecting after the data wipe', async () => {
    bootstrapNpmAdminMock.mockResolvedValue('needs_credentials');

    await run(nginxCtx());

    expect(lines()).toContain('⚠️ NPM still rejecting credentials after data-wipe retry; falling back to the credentials prompt.');
  });
});

describe('the per-template capability events (#632/#2160)', () => {
  it('emits feature.installed with the parsed manifest and this run’s variables', async () => {
    const c = ctx();
    await runPostDeployPhase(c);

    expect(emitWithRetryMock).toHaveBeenCalledTimes(1);
    // Fire the emit the phase handed over, to prove what it would publish.
    await emitWithRetryMock.mock.calls[0][0].emit();
    expect(emitMock).toHaveBeenCalledWith({
      kind: 'feature.installed',
      template: 'media',
      manifest: { name: 'media' },
      variables: c.input.variables,
    });
  });

  it('logs the retry line the bounded retry asks for', async () => {
    emitWithRetryMock.mockImplementation(async (opts: { onRetry: (a: number, c: number) => Promise<void> }) => {
      await opts.onRetry(0, 2);
      return { failures: [] };
    });

    await runPostDeployPhase(ctx());

    expect(lines()).toContain('↻ Retrying 2 recoverable handler failure(s) for media (attempt 1/3)…');
  });

  it('marks the run non-green and records a standing finding for a failure that survived retries', async () => {
    // Log-and-forget was the #2160 bug: SSO/proxy for the service is dead and
    // the install still reports green.
    emitWithRetryMock.mockResolvedValue({
      failures: [
        { handler: 'authelia-oidc', result: { ok: false, message: 'auth pod restarting' } },
        { handler: 'npm-proxy', result: { ok: true } },
      ],
    });

    await runPostDeployPhase(ctx());

    expect(lines().some(l => l.includes('⚠️ authelia-oidc (media): auth pod restarting — capability registration did NOT complete'))).toBe(true);
    expect(appendJobWarningMock).toHaveBeenCalledWith('job1', 'media: authelia-oidc — auth pod restarting');
    expect(recordHandlerFailureMock).toHaveBeenCalledWith({
      kind: 'capability',
      service: 'media',
      message: 'authelia-oidc: auth pod restarting',
    });
  });

  it('skips — with a note — a template whose YAML is gone or does not parse', async () => {
    getTemplateYamlMock.mockResolvedValueOnce(null);
    await runPostDeployPhase(ctx());
    expect(lines()).toContain('(note) skipped capability emit for media: template.yml not found');

    logMock.mockClear();
    parseManifestMock.mockReturnValue({ ok: false, errors: ['bad annotation', 'no containers'] });
    await runPostDeployPhase(ctx());
    expect(lines()).toContain('(note) skipped capability emit for media: bad annotation; no containers');
  });

  it('notes an emit that threw and keeps going', async () => {
    emitWithRetryMock.mockRejectedValue(new Error('bus offline'));
    await runPostDeployPhase(ctx());
    expect(lines()).toContain('(note) capability emit failed for media: bus offline');
    expect(ensureProxyHostsMock).toHaveBeenCalled();
  });
});

describe('the NPM admin reconcile (#1268)', () => {
  it('re-keys in place when NPM rejects or is missing the stored credentials', async () => {
    npmAdminCredStatusMock.mockResolvedValue('rejected');

    await runPostDeployPhase(ctx({ node: 'box2' }));

    expect(rekeyNpmAdminMock).toHaveBeenCalledWith('box2');
    expect(lines().some(l => l.includes('re-keying in place (proxy routes preserved)'))).toBe(true);
    expect(lines()).toContain('✅ re-keyed');
  });

  it('reports a failed re-key without failing the install', async () => {
    npmAdminCredStatusMock.mockResolvedValue('no-creds');
    rekeyNpmAdminMock.mockResolvedValue({ ok: false, message: 'NPM API refused' });

    const result = await runPostDeployPhase(ctx());

    expect(lines()).toContain('⚠️ NPM API refused');
    expect(result).toEqual({ aborted: false });
  });

  it('is a cheap no-op when NPM is not reachable at all', async () => {
    npmAdminCredStatusMock.mockResolvedValue('unknown');
    await runPostDeployPhase(ctx());
    expect(rekeyNpmAdminMock).not.toHaveBeenCalled();
  });

  it('notes a probe that threw', async () => {
    npmAdminCredStatusMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await runPostDeployPhase(ctx());
    expect(lines()).toContain('(note) NPM admin reconcile skipped: connect ECONNREFUSED');
  });
});

describe('the credentials manifest', () => {
  it('patches the job and merges into the persistent install manifest', async () => {
    const built = [cred('Jellyfin', 'admin')];
    const scriptCred = cred('Immich', 'ops');
    buildCredentialsManifestMock.mockReturnValue(built);
    mergeCredentialsMock.mockReturnValue([...built, scriptCred]);
    getConfigMock.mockResolvedValue({ installManifest: { credentials: [{ label: 'old' }] } });
    const c = ctx();
    c.scriptCredentials.push(scriptCred);

    await runPostDeployPhase(c);

    expect(buildCredentialsManifestMock).toHaveBeenCalledWith({ variables: c.input.variables, host: 'servicebay.local' });
    expect(patchJobMock).toHaveBeenCalledWith('job1', { credentialsManifest: [...built, scriptCred] });
    expect(mergeCredentialsMock).toHaveBeenCalledWith([{ label: 'old' }], [...built, scriptCred], ['media']);
    expect(saveConfigMock.mock.calls[0][0]).toMatchObject({
      installManifest: { credentials: [...built, scriptCred] },
    });
    expect(lines()).toContain('Saved 2 credential(s) to the install manifest.');
  });

  it('tells a headless caller the passwords exist only on the box (#2560)', async () => {
    buildCredentialsManifestMock.mockReturnValue([cred('Jellyfin', 'admin')]);
    await runPostDeployPhase(ctx());
    expect(lines().some(l => l.startsWith('1 password(s) exist only on this box.'))).toBe(true);
  });

  it('says nothing extra when the run produced no credentials', async () => {
    await runPostDeployPhase(ctx());
    expect(lines().some(l => l.includes('exist only on this box'))).toBe(false);
  });

  it('notes a failed persist rather than failing the install', async () => {
    saveConfigMock.mockRejectedValue(new Error('config locked'));
    const result = await runPostDeployPhase(ctx());
    expect(lines()).toContain("(note) couldn't persist the credentials manifest: config locked");
    expect(result).toEqual({ aborted: false });
  });
});

describe('portal provisioning + the box resolver re-point (#707/#1675)', () => {
  it('always provisions the portal and streams its lines into the job log', async () => {
    provisionPortalMock.mockImplementation(async (onLog: (l: string) => void) => { onLog('created apex rewrite'); });

    await runPostDeployPhase(ctx());

    expect(lines()).toContain('Provisioning AdGuard DNS rewrites + portal routing...');
    expect(lines()).toContain('created apex rewrite');
  });

  it('confirms the resolver re-point with the detail the router reported', async () => {
    await runPostDeployPhase(ctx({ node: 'box2' }));
    expect(repointResolverMock).toHaveBeenCalledWith('box2');
    expect(lines()).toContain('✅ resolver re-pointed');
  });

  it('notes a skipped or failed re-point', async () => {
    repointResolverMock.mockResolvedValue({ result: 'skipped', detail: 'AdGuard not installed' });
    await runPostDeployPhase(ctx());
    expect(lines()).toContain('(note) box resolver re-point skipped/failed: AdGuard not installed');
  });

  it('notes a re-point that threw', async () => {
    repointResolverMock.mockRejectedValue(new Error('router unreachable'));
    const result = await runPostDeployPhase(ctx());
    expect(lines()).toContain('(note) box resolver re-point failed: router unreachable');
    expect(result).toEqual({ aborted: false });
  });
});
