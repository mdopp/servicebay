import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture every execFile invocation so we can assert ssh runs with NO shell
// (discrete argv entries), not a single interpolated command string.
const execCalls: { cmd: string; args: string[] }[] = [];
let nextError: NodeJS.ErrnoException | null = null;

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
  ) => {
    execCalls.push({ cmd, args: Array.isArray(args) ? [...args] : [] });
    if (nextError) {
      callback(nextError, '', '');
    } else {
      callback(null, '', '');
    }
  };
  return { execFile, default: { execFile } };
});

describe('verifySSHConnection', () => {
  beforeEach(() => {
    execCalls.length = 0;
    nextError = null;
    vi.resetModules();
  });

  it('runs ssh via execFile with discrete argv entries (no shell string)', async () => {
    const { verifySSHConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await verifySSHConnection('host.example', 22, 'core', '/keys/id_rsa');
    expect(ok).toBe(true);

    expect(execCalls).toHaveLength(1);
    const { cmd, args } = execCalls[0];
    // First argument is the bare binary, never a "ssh ..." shell line.
    expect(cmd).toBe('ssh');
    expect(cmd).not.toContain(' ');
    // host/user/identityFile/port live as their own argv entries.
    expect(args).toContain('-i');
    expect(args).toContain('/keys/id_rsa');
    expect(args).toContain('-p');
    expect(args).toContain('22');
    expect(args).toContain('core@host.example');
    expect(args).toContain('exit');
    // No single arg smuggles the whole command as a shell string.
    expect(args.some((a) => a.includes('ssh -i'))).toBe(false);
  });

  it('does not let a metacharacter host inject a separate command', async () => {
    const { verifySSHConnection } = await import('../../packages/backend/src/lib/ssh');
    const evil = 'h; rm -rf /';
    await verifySSHConnection(evil, 22, 'core', '/keys/id_rsa');
    // The malicious host is one opaque argv entry; ssh receives it verbatim,
    // the shell never sees it.
    expect(execCalls[0].args).toContain(`core@${evil}`);
    expect(execCalls[0].cmd).toBe('ssh');
  });

  it('returns false when ssh exits non-zero', async () => {
    nextError = Object.assign(new Error('exit 255'), { code: 255 });
    const { verifySSHConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await verifySSHConnection('host.example', 22, 'core', '/keys/id_rsa');
    expect(ok).toBe(false);
  });
});
