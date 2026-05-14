import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn() },
}));
vi.mock('@/lib/lldap/client', () => ({
  listLldapUsers: vi.fn(),
}));

import { agentManager } from '@/lib/agent/manager';
import { listLldapUsers } from '@/lib/lldap/client';
import {
  parsePdbeditList,
  setSambaPassword,
  syncSambaWithLldap,
} from '@/lib/fileShare/sambaSync';

/**
 * Unit coverage for the LLDAP → Samba tdbsam sync (#494). Mocks the
 * agent so `pdbedit -L` / `smbpasswd -a` calls are captured in-process,
 * plus the LLDAP client so the test rig drives both sides.
 */

interface ExecCall {
  command: string;
  stdin?: string;
}

function makeAgent() {
  const calls: ExecCall[] = [];
  const sambaState = new Set<string>();
  const passwords = new Map<string, string>();

  const sendCommand = vi.fn(async (kind: string, payload: { command: string; stdin?: string }) => {
    if (kind !== 'exec') throw new Error(`unexpected agent command: ${kind}`);
    calls.push({ command: payload.command, stdin: payload.stdin });
    if (payload.command.includes('pdbedit -L')) {
      const lines = [...sambaState].map(u => `${u}:1000:${u}`).join('\n');
      return { code: 0, stdout: lines, stderr: '' };
    }
    if (payload.command.includes('smbpasswd -s -a')) {
      const match = payload.command.match(/smbpasswd -s -a ([\w.-]+)/);
      if (!match) return { code: 1, stdout: '', stderr: 'parse failed' };
      const user = match[1];
      sambaState.add(user);
      // smbpasswd stdin is `pw\npw\n`. Persist the first line.
      const pw = payload.stdin?.split('\n')[0] ?? '';
      passwords.set(user, pw);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (payload.command.includes('pdbedit -x -u')) {
      const match = payload.command.match(/pdbedit -x -u ([\w.-]+)/);
      if (!match) return { code: 1, stdout: '', stderr: 'parse failed' };
      sambaState.delete(match[1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unmocked: ${payload.command}` };
  });

  vi.mocked(agentManager.ensureAgent).mockResolvedValue({ sendCommand } as never);
  return { calls, sambaState, passwords };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parsePdbeditList', () => {
  it('extracts usernames from real pdbedit output', () => {
    const stdout = 'alice:1001:Alice Example\nbob:1002:Bob Example\n';
    expect(parsePdbeditList(stdout)).toEqual(['alice', 'bob']);
  });

  it('drops blank lines and lines with unsafe usernames', () => {
    const stdout = '\nvalid:1001:OK\n!evil:1002:nope\n   \ndots.ok:1003:OK\n';
    expect(parsePdbeditList(stdout)).toEqual(['valid', 'dots.ok']);
  });
});

describe('syncSambaWithLldap', () => {
  it('adds LLDAP users missing from Samba and surfaces them in the result', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [
        { id: 'alice', displayName: 'Alice' },
        { id: 'bob', displayName: 'Bob' },
      ],
    });
    const { calls, passwords } = makeAgent();
    const res = await syncSambaWithLldap('Local');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.added.sort()).toEqual(['alice', 'bob']);
    expect(res.removed).toEqual([]);
    expect(res.users.every(u => u.presentInSamba)).toBe(true);

    // smbpasswd was called twice with non-empty stdin.
    const smbCalls = calls.filter(c => c.command.includes('smbpasswd'));
    expect(smbCalls).toHaveLength(2);
    for (const c of smbCalls) {
      expect(c.stdin).toMatch(/^[A-Za-z0-9]+\n[A-Za-z0-9]+\n$/);
    }
    // The two stdin passwords must match the same value duplicated on
    // both lines (smbpasswd contract).
    for (const c of smbCalls) {
      const [a, b] = (c.stdin ?? '').split('\n');
      expect(a).toBe(b);
    }
    // Different users get different random passwords.
    expect(new Set(passwords.values()).size).toBe(2);
  });

  it('removes Samba accounts that no longer exist in LLDAP', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'alice' }],
    });
    const { calls, sambaState } = makeAgent();
    sambaState.add('alice');
    sambaState.add('orphan');

    const res = await syncSambaWithLldap('Local');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.removed).toEqual(['orphan']);
    expect(res.added).toEqual([]);

    const removeCalls = calls.filter(c => c.command.includes('pdbedit -x'));
    expect(removeCalls.map(c => c.command)).toContain('podman exec file-share-samba pdbedit -x -u orphan');
  });

  it('is idempotent — second sync with the same inputs adds + removes nothing', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'alice' }, { id: 'bob' }],
    });
    const env = makeAgent();
    env.sambaState.add('alice');
    env.sambaState.add('bob');

    const res = await syncSambaWithLldap('Local');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);
  });

  it('returns lldap_unavailable when the LLDAP client fails', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: false,
      reason: 'unreachable',
      message: 'cannot reach LLDAP',
    });
    makeAgent();
    const res = await syncSambaWithLldap('Local');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('lldap_unavailable');
  });
});

describe('setSambaPassword', () => {
  it('sets the requested password via smbpasswd and reports back', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'alice' }],
    });
    const { calls } = makeAgent();
    const res = await setSambaPassword('alice', { password: 'hunter2x' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.password).toBe('hunter2x');

    const smb = calls.find(c => c.command.includes('smbpasswd'));
    expect(smb?.command).toBe('podman exec -i file-share-samba smbpasswd -s -a alice');
    expect(smb?.stdin).toBe('hunter2x\nhunter2x\n');
  });

  it('generates a random password when none is provided', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'alice' }],
    });
    makeAgent();
    const r1 = await setSambaPassword('alice');
    const r2 = await setSambaPassword('alice');
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.password).not.toBe(r2.password);
    expect(r1.password.length).toBeGreaterThanOrEqual(12);
  });

  it('rejects unknown LLDAP users with not_in_lldap', async () => {
    vi.mocked(listLldapUsers).mockResolvedValue({
      ok: true,
      users: [{ id: 'alice' }],
    });
    makeAgent();
    const res = await setSambaPassword('stranger');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('not_in_lldap');
  });

  it('rejects unsafe usernames before reaching LLDAP or the agent', async () => {
    const res = await setSambaPassword('alice; rm -rf /');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('not_in_lldap');
    // listLldapUsers must NOT have been consulted for invalid input.
    expect(vi.mocked(listLldapUsers)).not.toHaveBeenCalled();
  });
});
