import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSendCommand, mockEnsureAgent, mockListLldapUsers } = vi.hoisted(() => ({
  mockSendCommand: vi.fn(),
  mockEnsureAgent: vi.fn(),
  mockListLldapUsers: vi.fn(),
}));

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: mockEnsureAgent },
}));
vi.mock('@/lib/lldap/client', () => ({
  listLldapUsers: () => mockListLldapUsers(),
}));

import { ensureSambaPosixUser, setSambaPassword, parsePdbeditList, syncSambaWithLldap } from './sambaSync';

/**
 * Dispatch sendCommand by the `command` string. Each entry is a substring
 * matcher → the result the agent returns. First match wins; unmatched
 * commands default to a clean exit so unrelated steps don't blow up.
 */
function wireExec(rules: Array<{ match: string; code?: number; stdout?: string; stderr?: string }>) {
  mockEnsureAgent.mockResolvedValue({ sendCommand: mockSendCommand });
  mockSendCommand.mockImplementation(async (_action: string, args: { command: string }) => {
    for (const r of rules) {
      if (args.command.includes(r.match)) {
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  mockSendCommand.mockReset();
  mockEnsureAgent.mockReset();
  mockListLldapUsers.mockReset();
});

describe('ensureSambaPosixUser', () => {
  it('is a no-op when the POSIX user already exists (idempotent)', async () => {
    wireExec([{ match: 'getent passwd alice', code: 0, stdout: 'alice:x:1001:1001::/home/alice:/bin/sh' }]);
    const res = await ensureSambaPosixUser('Local', 'alice');
    expect(res.ok).toBe(true);
    // useradd must NOT have been issued.
    const calls = mockSendCommand.mock.calls.map(c => c[1].command);
    expect(calls.some(c => c.includes('useradd'))).toBe(false);
  });

  it('creates the user with the share gid as primary group when absent', async () => {
    wireExec([
      { match: 'getent passwd bob', code: 2, stdout: '' }, // absent
      { match: 'stat -c %g /data', code: 0, stdout: '1000\n' },
      { match: 'useradd', code: 0 },
    ]);
    const res = await ensureSambaPosixUser('Local', 'bob');
    expect(res.ok).toBe(true);
    const useradd = mockSendCommand.mock.calls.map(c => c[1].command).find(c => c.includes('useradd'));
    expect(useradd).toContain('-M');
    expect(useradd).toContain('-s /usr/sbin/nologin');
    expect(useradd).toContain('-g 1000');
    expect(useradd).toContain('bob');
  });

  it('still creates the user (no -g) when the share gid cannot be resolved', async () => {
    wireExec([
      { match: 'getent passwd carol', code: 2 },
      { match: 'stat -c %g /data', code: 1, stderr: 'stat: cannot stat' },
      { match: 'useradd', code: 0 },
    ]);
    const res = await ensureSambaPosixUser('Local', 'carol');
    expect(res.ok).toBe(true);
    const useradd = mockSendCommand.mock.calls.map(c => c[1].command).find(c => c.includes('useradd'));
    expect(useradd).not.toContain('-g ');
    expect(useradd).toContain('carol');
  });

  it('returns an actionable error when useradd fails', async () => {
    wireExec([
      { match: 'getent passwd dave', code: 2 },
      { match: 'stat -c %g /data', code: 0, stdout: '1000' },
      { match: 'useradd', code: 1, stderr: 'useradd: permission denied' },
    ]);
    const res = await ensureSambaPosixUser('Local', 'dave');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain('Could not create POSIX user');
      expect(res.message).toContain('useradd: permission denied');
    }
  });
});

describe('setSambaPassword', () => {
  it('provisions the POSIX user before smbpasswd -a', async () => {
    mockListLldapUsers.mockResolvedValue({ ok: true, users: [{ id: 'erin' }] });
    wireExec([
      { match: 'getent passwd erin', code: 2 }, // absent → triggers useradd
      { match: 'stat -c %g /data', code: 0, stdout: '1000' },
      { match: 'useradd', code: 0 },
      { match: 'smbpasswd', code: 0 },
    ]);
    const res = await setSambaPassword('erin', { node: 'Local', password: 'hunter22' });
    expect(res.ok).toBe(true);
    const commands = mockSendCommand.mock.calls.map(c => c[1].command);
    const useraddIdx = commands.findIndex(c => c.includes('useradd'));
    const smbpasswdIdx = commands.findIndex(c => c.includes('smbpasswd'));
    expect(useraddIdx).toBeGreaterThanOrEqual(0);
    expect(smbpasswdIdx).toBeGreaterThan(useraddIdx); // ordering: useradd before smbpasswd
  });

  it('does not attempt smbpasswd if POSIX user creation fails', async () => {
    mockListLldapUsers.mockResolvedValue({ ok: true, users: [{ id: 'frank' }] });
    wireExec([
      { match: 'getent passwd frank', code: 2 },
      { match: 'stat -c %g /data', code: 0, stdout: '1000' },
      { match: 'useradd', code: 1, stderr: 'denied' },
    ]);
    const res = await setSambaPassword('frank', { node: 'Local', password: 'pw' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('exec_failed');
    const commands = mockSendCommand.mock.calls.map(c => c[1].command);
    expect(commands.some(c => c.includes('smbpasswd'))).toBe(false);
  });

  it('rejects a user not in LLDAP without touching the container', async () => {
    mockListLldapUsers.mockResolvedValue({ ok: true, users: [{ id: 'someoneelse' }] });
    const res = await setSambaPassword('ghost', { node: 'Local', password: 'pw' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_in_lldap');
    expect(mockSendCommand).not.toHaveBeenCalled();
  });
});

describe('parsePdbeditList', () => {
  it('extracts usernames and drops malformed lines', () => {
    const out = 'alice:1001:Alice\nbob:1002:Bob\n\n  \nbad name:1:x';
    expect(parsePdbeditList(out)).toEqual(['alice', 'bob']);
  });
});

describe('syncSambaWithLldap — persisted-passdb POSIX reconcile (#1946)', () => {
  it('re-creates the ephemeral POSIX account for a user already in the persisted passdb', async () => {
    // After a reboot the smbpasswd entry survives (passdb persisted) but the
    // /etc/passwd account is gone → getent reports absent, so the sync must
    // still `useradd` even though the user is NOT in `toAdd`.
    mockListLldapUsers.mockResolvedValue({ ok: true, users: [{ id: 'alice' }] });
    wireExec([
      { match: 'pdbedit -L', code: 0, stdout: 'alice:1001:Alice\n' }, // already in passdb
      { match: 'getent passwd alice', code: 2, stdout: '' },           // POSIX account wiped
      { match: 'stat -c %g /data', code: 0, stdout: '1000\n' },
      { match: 'useradd', code: 0 },
    ]);
    const res = await syncSambaWithLldap('Local');
    expect(res.ok).toBe(true);
    const commands = mockSendCommand.mock.calls.map(c => c[1].command);
    // POSIX account re-created for the existing passdb user...
    expect(commands.some(c => c.includes('useradd') && c.includes('alice'))).toBe(true);
    // ...without re-running smbpasswd (no password overwrite for existing users).
    expect(commands.some(c => c.includes('smbpasswd'))).toBe(false);
    if (res.ok) {
      expect(res.added).toEqual([]);
      expect(res.users.find(u => u.id === 'alice')?.presentInSamba).toBe(true);
    }
  });

  it('does not useradd when the POSIX account already exists (idempotent reconcile)', async () => {
    mockListLldapUsers.mockResolvedValue({ ok: true, users: [{ id: 'bob' }] });
    wireExec([
      { match: 'pdbedit -L', code: 0, stdout: 'bob:1002:Bob\n' },
      { match: 'getent passwd bob', code: 0, stdout: 'bob:x:1002:1000::/home/bob:/usr/sbin/nologin' },
    ]);
    const res = await syncSambaWithLldap('Local');
    expect(res.ok).toBe(true);
    const commands = mockSendCommand.mock.calls.map(c => c[1].command);
    expect(commands.some(c => c.includes('useradd'))).toBe(false);
  });
});
