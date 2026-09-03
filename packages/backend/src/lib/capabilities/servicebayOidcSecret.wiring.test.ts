/**
 * #2417 — the two impure halves: the deploy-time rotation pre-flight, and the
 * post-deploy adoption of Authelia's secret into `config.oidc.clientSecret`.
 *
 * The pure decisions are covered in `servicebayOidcSecret.test.ts`. What these
 * assert is the wiring that makes "the SAME value ends up on both sides" true:
 * that the reconcile reads the file that was just written (rather than trusting
 * the render), that it actually persists, and that the failure paths degrade
 * the way the design assumes — because the whole lockout argument rests on them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const sendCommandMock = vi.fn();
const ensureAgentMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: (node: string) => ensureAgentMock(node) },
}));

const getConfigMock = vi.fn();
const updateConfigMock = vi.fn();
vi.mock('@/lib/config', () => ({
  getConfig: () => getConfigMock(),
  updateConfig: (patch: unknown) => updateConfigMock(patch),
}));

import {
  reconcileServicebayOidcSecret,
  assertServicebayOidcRotationSafe,
} from './servicebayOidcSecret';

const CONFIG_PATH = '/mnt/data/stacks/auth/authelia-config/configuration.yml';

const autheliaConfig = (sbSecret: string) => `
identity_providers:
  oidc:
    clients:
      - client_id: 'servicebay'
        client_secret: '${sbSecret}'
`;

const authFiles = (content: string) => [{ path: CONFIG_PATH, content }];

beforeEach(() => {
  sendCommandMock.mockReset();
  ensureAgentMock.mockReset();
  getConfigMock.mockReset();
  updateConfigMock.mockReset();
  ensureAgentMock.mockResolvedValue({ sendCommand: sendCommandMock });
  updateConfigMock.mockResolvedValue(undefined);
});

describe('reconcileServicebayOidcSecret', () => {
  it('adopts the secret from the file on disk into config.oidc.clientSecret', async () => {
    sendCommandMock.mockResolvedValue({ content: autheliaConfig('$plaintext$perBoxValue') });
    getConfigMock.mockResolvedValue({
      oidc: { enabled: true, issuer: 'https://auth.example.com', clientId: 'servicebay', clientSecret: 'stale' },
    });

    const r = await reconcileServicebayOidcSecret('Local', authFiles('irrelevant'));

    expect(r?.outcome).toBe('changed');
    expect(updateConfigMock).toHaveBeenCalledWith({
      oidc: expect.objectContaining({ clientSecret: 'perBoxValue', enabled: true }),
    });
  });

  it('reads the ON-DISK file, not the rendered content it was handed', async () => {
    // The whole safety argument is "ServiceBay follows the file". If this ever
    // adopted `extraFiles[].content` instead, a write that silently failed
    // would leave ServiceBay holding a secret Authelia never got.
    sendCommandMock.mockResolvedValue({ content: autheliaConfig('$plaintext$whatIsActuallyOnDisk') });
    getConfigMock.mockResolvedValue({ oidc: { enabled: true, issuer: 'i', clientId: 'servicebay', clientSecret: 'stale' } });

    await reconcileServicebayOidcSecret('Local', authFiles(autheliaConfig('$plaintext$whatWeRendered')));

    expect(sendCommandMock).toHaveBeenCalledWith('read_file', { path: CONFIG_PATH });
    expect(updateConfigMock).toHaveBeenCalledWith({
      oidc: expect.objectContaining({ clientSecret: 'whatIsActuallyOnDisk' }),
    });
  });

  it('is a no-op on the second run (idempotent — the convergence property)', async () => {
    sendCommandMock.mockResolvedValue({ content: autheliaConfig('$plaintext$settled') });
    getConfigMock.mockResolvedValue({ oidc: { enabled: true, issuer: 'i', clientId: 'servicebay', clientSecret: 'settled' } });

    const r = await reconcileServicebayOidcSecret('Local', authFiles('x'));

    expect(r?.outcome).toBe('aligned');
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('does nothing at all for a non-auth deploy', async () => {
    const r = await reconcileServicebayOidcSecret('Local', [{ path: '/mnt/data/stacks/immich/immich.env', content: 'X=1' }]);
    expect(r).toBeNull();
    expect(ensureAgentMock).not.toHaveBeenCalled();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('defaults the node to Local', async () => {
    sendCommandMock.mockResolvedValue({ content: autheliaConfig('$plaintext$abc12345') });
    getConfigMock.mockResolvedValue({});
    await reconcileServicebayOidcSecret(undefined, authFiles('x'));
    expect(ensureAgentMock).toHaveBeenCalledWith('Local');
  });

  it('never throws, and never clobbers, when the box is unreachable', async () => {
    // Degrading to "SSO button may be stale" is acceptable; throwing here would
    // fail an otherwise-successful deploy, and writing would be worse still.
    ensureAgentMock.mockRejectedValue(new Error('agent offline'));
    const r = await reconcileServicebayOidcSecret('Local', authFiles('x'));
    expect(r?.outcome).toBe('skipped');
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('leaves a working secret alone when the file is unreadable', async () => {
    sendCommandMock.mockRejectedValue(new Error('EACCES'));
    getConfigMock.mockResolvedValue({ oidc: { enabled: true, issuer: 'i', clientId: 'servicebay', clientSecret: 'working' } });
    const r = await reconcileServicebayOidcSecret('Local', authFiles('x'));
    expect(r?.outcome).toBe('skipped');
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('keeps the secret out of the message on the failure path too', async () => {
    ensureAgentMock.mockRejectedValue(new Error('agent offline'));
    const r = await reconcileServicebayOidcSecret('Local', authFiles('x'));
    expect(r?.message).not.toMatch(/plaintext\$/);
    expect(r?.message).toContain('local admin username/password');
  });
});

describe('assertServicebayOidcRotationSafe', () => {
  const rendered = autheliaConfig('$plaintext$newPerBoxValue');
  const onDisk = autheliaConfig('$plaintext$oldPublishedValue');

  it('THROWS when rotating on a box whose only door is SSO', async () => {
    getConfigMock.mockResolvedValue({ auth: {} });
    delete process.env.SERVICEBAY_PASSWORD;
    await expect(assertServicebayOidcRotationSafe(authFiles(rendered), onDisk))
      .rejects.toThrow(/Refusing to rotate/);
  });

  it('allows the rotation when a local admin password hash exists', async () => {
    getConfigMock.mockResolvedValue({ auth: { passwordHash: 'scrypt$abc' } });
    await expect(assertServicebayOidcRotationSafe(authFiles(rendered), onDisk)).resolves.toBeUndefined();
  });

  it('allows the rotation when only SERVICEBAY_PASSWORD is set', async () => {
    getConfigMock.mockResolvedValue({ auth: {} });
    process.env.SERVICEBAY_PASSWORD = 'bootstrap';
    try {
      await expect(assertServicebayOidcRotationSafe(authFiles(rendered), onDisk)).resolves.toBeUndefined();
    } finally {
      delete process.env.SERVICEBAY_PASSWORD;
    }
  });

  it('does not even read config on a fresh install — there is no login to break', async () => {
    getConfigMock.mockResolvedValue({ auth: {} });
    await expect(assertServicebayOidcRotationSafe(authFiles(rendered), null)).resolves.toBeUndefined();
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it('does not fire in the steady state (same secret re-rendered)', async () => {
    getConfigMock.mockResolvedValue({ auth: {} });
    await expect(assertServicebayOidcRotationSafe(authFiles(rendered), rendered)).resolves.toBeUndefined();
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it('does not fire for a non-auth deploy', async () => {
    getConfigMock.mockResolvedValue({ auth: {} });
    await expect(
      assertServicebayOidcRotationSafe([{ path: '/mnt/data/stacks/immich/immich.env', content: 'X=1' }], onDisk),
    ).resolves.toBeUndefined();
    expect(getConfigMock).not.toHaveBeenCalled();
  });
});

/**
 * Structural ratchet. Both halves are correct in isolation and useless if the
 * install path stops calling them — and the symptom of that (a working SSO
 * button that quietly still uses the published secret, or a rotation with no
 * break-glass check) is invisible to every behavioural test above. So assert
 * the call sites themselves, including their ORDER, which is the entire
 * failed-deploy-is-a-no-op argument.
 */
describe('install-path wiring (#2417)', () => {
  // #2742 split `install/runner.ts` into phase modules; the per-item deploy
  // sequence these two call sites bracket now lives in the kube-play phase.
  // The assertions are unchanged — only the file they read moved.
  const runner = fs.readFileSync(
    path.join(__dirname, '..', 'install', 'phases', 'kubePlay.ts'), 'utf-8',
  );

  it('runs the rotation pre-flight before the deploy is attempted', () => {
    expect(runner).toMatch(/assertServicebayOidcRotationSafe\(extraFiles, existingAutheliaConfig\)/);
    const preflightAt = runner.indexOf('assertServicebayOidcRotationSafe(extraFiles');
    const attemptAt = runner.indexOf('const attemptDeploy');
    expect(preflightAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(attemptAt);
  });

  it('reconciles ONLY after a successful deploy, never before', () => {
    const reconcileAt = runner.indexOf('reconcileServicebayOidcSecret(input.node, extraFiles)');
    const awaitAttemptAt = runner.indexOf('await attemptDeploy();');
    expect(reconcileAt).toBeGreaterThan(-1);
    // A reconcile that ran before/around the deploy would let ServiceBay's copy
    // lead the file — the ordering that CAN strand a box on a failed deploy.
    expect(reconcileAt).toBeGreaterThan(awaitAttemptAt);
  });

  it('feeds the pre-flight the config preserveAutheliaOidcClients already read', () => {
    // Not a second read_file, and not `null` — passing null would silently
    // disable the break-glass check by making every rotation look "fresh".
    expect(runner).toMatch(
      /const existingAutheliaConfig = await preserveAutheliaOidcClients\(jobId, input\.node, extraFiles\)/,
    );
  });
});
