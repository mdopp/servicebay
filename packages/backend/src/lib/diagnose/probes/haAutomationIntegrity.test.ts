import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock hoists above top-level consts — expose mutable state via a closure.
const state = {
  files: {} as Record<string, string>,
  dirExists: true,
  backupTarget: { transport: 'ftp' } as unknown as object | null,
};

const HA_DIR = '/mnt/data/stacks/home-assistant/homeassistant';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve({ templateSettings: {} })),
}));

vi.mock('@/lib/externalBackup/nasClient', () => ({
  resolveBackupTarget: vi.fn(() => Promise.resolve(state.backupTarget)),
}));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: {
    ensureAgent: vi.fn(() =>
      Promise.resolve({
        sendCommand: vi.fn(async (_action: string, params?: { command?: string }) => {
          const cmd = params?.command ?? '';
          let m = cmd.match(/^test -d (\S+) && echo yes \|\| echo no$/);
          if (m) return { code: 0, stdout: state.dirExists ? 'yes' : 'no' };
          m = cmd.match(/^cat (\S+) 2>\/dev\/null \|\| echo MISSING$/);
          if (m) {
            const body = state.files[m[1]];
            return { code: 0, stdout: body !== undefined ? body : 'MISSING' };
          }
          return { code: 0, stdout: '' };
        }),
      }),
    ),
  },
}));

import { checkHaAutomationIntegrity } from './haAutomationIntegrity';

const REGISTRY = `${HA_DIR}/.storage/core.entity_registry`;

function registry(entities: { platform: string }[]): string {
  return JSON.stringify({ data: { entities } });
}

beforeEach(() => {
  state.files = {};
  state.dirExists = true;
  state.backupTarget = { transport: 'ftp' };
});

describe('checkHaAutomationIntegrity (#1864)', () => {
  it('returns info when HA is not installed', async () => {
    state.dirExists = false;
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/not installed/);
  });

  it('returns info when there is no entity registry yet', async () => {
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/no entity registry/);
  });

  it('warns on the registry/config mismatch (registry has N, file empty)', async () => {
    state.files[REGISTRY] = registry([
      { platform: 'automation' },
      { platform: 'automation' },
      { platform: 'script' },
    ]);
    state.files[`${HA_DIR}/automations.yaml`] = '[]';
    state.files[`${HA_DIR}/scripts.yaml`] = '- alias: real'; // script file populated
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/automations\.yaml/);
    expect(r.detail).toMatch(/registry lists 2 automation/);
    expect(r.detail).not.toMatch(/scripts\.yaml/); // script matched, not flagged
    expect(r.hint).toMatch(/Do NOT restart/i);
  });

  it('warns when a registered config file is missing entirely', async () => {
    state.files[REGISTRY] = registry([{ platform: 'scene' }]);
    // scenes.yaml absent → MISSING → treated as 0 entries
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/scenes\.yaml/);
  });

  it('warns when HA owns entities but no effective backup target resolves', async () => {
    state.files[REGISTRY] = registry([{ platform: 'automation' }]);
    state.files[`${HA_DIR}/automations.yaml`] = '- id: morning\n';
    state.backupTarget = null; // neither gateway nor externalBackup resolves
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no external backup is configured/);
    expect(r.hint).toMatch(/FritzBox gateway/);
  });

  it('does NOT warn about backup when the effective (gateway-derived) target resolves', async () => {
    // externalBackup unset, but resolveBackupTarget returns the gateway-derived
    // FritzBox target → no false "no backup" warning.
    state.files[REGISTRY] = registry([{ platform: 'automation' }]);
    state.files[`${HA_DIR}/automations.yaml`] = '- id: morning\n';
    state.backupTarget = { transport: 'ftp' };
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/match their config files/);
  });

  it('returns ok with no entities registered (nothing at risk)', async () => {
    state.files[REGISTRY] = registry([{ platform: 'sun' }]);
    state.backupTarget = null; // no backup, but nothing to back up either
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/nothing at risk/);
  });
});
