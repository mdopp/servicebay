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

import { checkHaAutomationIntegrity, parseGuardRegression } from './haAutomationIntegrity';

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

const SNAPSHOT = `${HA_DIR}/.sb_include_snapshot.json`;

function guardSnapshot(files: string[], detectedAt = '2026-07-28T04:12:00Z'): string {
  return JSON.stringify({
    version: 1,
    updatedAt: detectedAt,
    files: {},
    lastRegression: { files, detectedAt, previous: {} },
  });
}

describe('checkHaAutomationIntegrity — post-deploy reset guard (#2444)', () => {
  it('warns when the guard flagged a reset and the file is still empty, even with no registry', async () => {
    // The variant hazard 1 is blind to: HA reset the entity registry too, so
    // there is nothing to mismatch against — only the guard's record remains.
    state.files[SNAPSHOT] = guardSnapshot(['automations.yaml']);
    state.files[`${HA_DIR}/automations.yaml`] = '[]';
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/automations\.yaml/);
    expect(r.detail).toMatch(/2026-07-28T04:12:00Z/);
    expect(r.hint).toMatch(/automatic backup/i);
  });

  it('does NOT warn once the flagged file has content again (self-clearing)', async () => {
    state.files[REGISTRY] = registry([{ platform: 'automation' }]);
    state.files[SNAPSHOT] = guardSnapshot(['automations.yaml']);
    state.files[`${HA_DIR}/automations.yaml`] = '- id: morning\n';
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('ok');
  });

  it('ignores a snapshot with no lastRegression stamp (normal redeploy)', async () => {
    state.files[REGISTRY] = registry([{ platform: 'automation' }]);
    state.files[SNAPSHOT] = JSON.stringify({ version: 1, updatedAt: 'x', files: { 'automations.yaml': { empty: false } } });
    state.files[`${HA_DIR}/automations.yaml`] = '- id: morning\n';
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('ok');
  });

  it('still reports "not installed" / "no registry" when nothing is flagged', async () => {
    const r = await checkHaAutomationIntegrity();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/no entity registry/);
  });
});

describe('parseGuardRegression', () => {
  it('returns null for a missing, unparseable or unstamped snapshot', () => {
    expect(parseGuardRegression('')).toBeNull();
    expect(parseGuardRegression('{ not json')).toBeNull();
    expect(parseGuardRegression(JSON.stringify({ files: {} }))).toBeNull();
    expect(parseGuardRegression(JSON.stringify({ lastRegression: { files: [] } }))).toBeNull();
  });

  it('drops filenames outside the three include targets', () => {
    const stamp = parseGuardRegression(
      JSON.stringify({ lastRegression: { files: ['automations.yaml', '../../etc/passwd'] } }),
    );
    expect(stamp?.files).toEqual(['automations.yaml']);
    expect(stamp?.detectedAt).toBeNull();
  });
});
