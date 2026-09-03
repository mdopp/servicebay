/**
 * Finalize (#2742) — the three writes only a finished run may make. Each one
 * is best-effort: the phase runs AFTER the terminal verdict is patched, so a
 * failure here must never turn a successful install into a failed one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeployContext } from './context';
import type { JobInput } from '../jobStore';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
vi.mock('./context', () => ({
  log: (jobId: string, line: string) => logMock(jobId, line),
}));

const getConfigMock = vi.fn();
const saveConfigMock = vi.fn();
vi.mock('@/lib/config', () => ({
  getConfig: () => getConfigMock(),
  saveConfig: (cfg: unknown) => saveConfigMock(cfg),
}));

const persistSecretsMock = vi.fn();
vi.mock('../savedSecrets', () => ({
  persistInstalledSecrets: (vars: unknown, cfg: unknown) => persistSecretsMock(vars, cfg),
}));

const persistVariablesMock = vi.fn();
vi.mock('../savedVariables', () => ({
  persistInstalledVariables: (vars: unknown, cfg: unknown) => persistVariablesMock(vars, cfg),
}));

import { runFinalizePhase } from './finalize';

const input = (): JobInput => ({
  items: [{ name: 'auth', checked: true }],
  variables: [{ name: 'LLDAP_ADMIN_PASSWORD', value: 's3cret' }],
  templateSource: 'Built-in',
  host: 'servicebay.local',
});

const ctx = (): DeployContext => ({
  jobId: 'job1',
  input: input(),
  scriptCredentials: [],
  deployed: [{ name: 'auth' }],
  reusedSecretNames: new Set<string>(),
});

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  getConfigMock.mockReset().mockResolvedValue({});
  saveConfigMock.mockReset().mockResolvedValue(undefined);
  persistSecretsMock.mockReset().mockResolvedValue(undefined);
  persistVariablesMock.mockReset().mockResolvedValue(undefined);
});

describe('runFinalizePhase', () => {
  it('persists this run’s secrets AND operator-set variables for the next install', async () => {
    const c = ctx();
    await runFinalizePhase(c);
    expect(persistSecretsMock).toHaveBeenCalledWith(c.input.variables, {});
    expect(persistVariablesMock).toHaveBeenCalledWith(c.input.variables, {});
  });

  it('clears stackSetupPending — a successful install proves the box has services', async () => {
    getConfigMock.mockResolvedValue({ stackSetupPending: true, other: 'keep' });

    await runFinalizePhase(ctx());

    expect(saveConfigMock).toHaveBeenCalledTimes(1);
    const saved = saveConfigMock.mock.calls[0][0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty('stackSetupPending');
    expect(saved.other).toBe('keep');
  });

  it('leaves config untouched when the onboarding flag was never armed', async () => {
    getConfigMock.mockResolvedValue({ other: 'keep' });
    await runFinalizePhase(ctx());
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('notes each failure and still runs the later steps', async () => {
    // The failure mode this guards: a locked config aborting the phase after
    // the secrets write, so the operator-set variables are silently dropped
    // and the next reinstall rebuilds them from variables.json defaults.
    persistSecretsMock.mockRejectedValue(new Error('config locked'));
    persistVariablesMock.mockRejectedValue(new Error('still locked'));
    getConfigMock.mockResolvedValue({ stackSetupPending: true });
    saveConfigMock.mockRejectedValue(new Error('read-only fs'));

    await expect(runFinalizePhase(ctx())).resolves.toBeUndefined();

    const lines = logMock.mock.calls.map(c => c[1]);
    expect(lines).toEqual([
      '(note) couldn\'t persist installed secrets: config locked',
      '(note) couldn\'t persist operator-set variables: still locked',
      '(note) couldn\'t clear stackSetupPending: read-only fs',
    ]);
  });
});
