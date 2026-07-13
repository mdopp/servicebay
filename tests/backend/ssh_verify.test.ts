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

  it('rejects a metacharacter host before it reaches ssh (request-forgery barrier)', async () => {
    const { verifySSHConnection } = await import('../../packages/backend/src/lib/ssh');
    const evil = 'h; rm -rf /';
    const ok = await verifySSHConnection(evil, 22, 'core', '/keys/id_rsa');
    // The host fails the hostname/IP allowlist → ssh is never invoked.
    expect(ok).toBe(false);
    expect(execCalls).toHaveLength(0);
  });

  it('rejects a URL/SSRF-shaped host before it reaches ssh', async () => {
    const { verifySSHConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await verifySSHConnection('http://169.254.169.254/latest/', 22, 'core', '/keys/id_rsa');
    expect(ok).toBe(false);
    expect(execCalls).toHaveLength(0);
  });

  it('returns false when ssh exits non-zero', async () => {
    nextError = Object.assign(new Error('exit 255'), { code: 'EEXIT' });
    const { verifySSHConnection } = await import('../../packages/backend/src/lib/ssh');
    const ok = await verifySSHConnection('host.example', 22, 'core', '/keys/id_rsa');
    expect(ok).toBe(false);
  });
});
