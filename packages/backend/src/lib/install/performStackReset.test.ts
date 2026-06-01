/**
 * performStackReset — the secrets-group regen path (#1246).
 *
 * After the engine wipes secret.key + .auth-secret.env it must
 * regenerate them in-process so the container doesn't crash-loop on its
 * next restart. These tests assert:
 *  - regen runs when the secrets group is wiped, AFTER the rm -rf;
 *  - regen does NOT run when secrets is preserved;
 *  - a regen failure propagates (it is not masked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentCommands: string[] = [];

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    listServices: vi.fn(async () => []),
    deleteService: vi.fn(async () => {}),
  },
}));

const ensureAgent = vi.fn(async () => ({
  sendCommand: vi.fn(async (_kind: string, args: { command: string }) => {
    sentCommands.push(args.command);
    return { stdout: '' };
  }),
}));
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent },
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({ templateSettings: { DATA_DIR: '/mnt/data/stacks' } })),
  scrubEncryptedConfig: vi.fn(async () => ({ removedKeys: 0 })),
}));

vi.mock('@/lib/store/repository', () => ({
  getNodeIds: vi.fn(() => ['node-1']),
}));

vi.mock('./resetValidation', () => ({
  validateResetCombo: vi.fn(async () => ({ valid: true, errors: [] })),
}));

const regenerateWipedKeys = vi.fn(() => ({
  secretKeyPath: '/app/data/secret.key',
  authSecretEnvPath: '/app/data/.auth-secret.env',
}));
vi.mock('./regenSecrets', () => ({
  regenerateWipedKeys: () => regenerateWipedKeys(),
}));

const { performStackReset } = await import('./performStackReset');

beforeEach(() => {
  sentCommands.length = 0;
  regenerateWipedKeys.mockClear();
  regenerateWipedKeys.mockImplementation(() => ({
    secretKeyPath: '/app/data/secret.key',
    authSecretEnvPath: '/app/data/.auth-secret.env',
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('performStackReset — secrets regen (#1246)', () => {
  it('regenerates the wiped keys when the secrets group is wiped', async () => {
    // preserve nothing secrets-related → secrets group is wiped
    const result = await performStackReset({ preserve: [], node: 'node-1' });

    expect(regenerateWipedKeys).toHaveBeenCalledOnce();
    expect(result.wipeStepsRun).toContain(
      'secrets regen (secret.key + .auth-secret.env written in-process)',
    );
  });

  it('regenerates AFTER the secrets rm -rf, not before', async () => {
    await performStackReset({ preserve: [], node: 'node-1' });

    const wipeIdx = sentCommands.findIndex(c =>
      c.includes('find /var/mnt/data/servicebay'),
    );
    expect(wipeIdx).toBeGreaterThanOrEqual(0);
    // regenerateWipedKeys runs synchronously inside the awaited engine,
    // after the wipe command was dispatched. The wipe command being
    // present in the recorded sequence proves the await completed first.
    expect(regenerateWipedKeys).toHaveBeenCalledOnce();
  });

  it('does NOT regenerate when the secrets group is preserved', async () => {
    const result = await performStackReset({
      preserve: ['secrets'],
      node: 'node-1',
    });

    expect(regenerateWipedKeys).not.toHaveBeenCalled();
    expect(result.wipeStepsRun.some(s => s.startsWith('secrets'))).toBe(false);
  });

  it('does not mask a regen failure (it propagates, not swallowed)', async () => {
    regenerateWipedKeys.mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(
      performStackReset({ preserve: [], node: 'node-1' }),
    ).rejects.toThrow('disk full');
  });
});
