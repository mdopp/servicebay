import { describe, it, expect, vi } from 'vitest';
import {
  listBlockDevices,
  mountReadOnly,
  unmount,
  mountpointFor,
  assertSafeDevice,
  MOUNT_BASE,
} from './mounter';
import type { SafeExec, SafeExecResult } from './hostExec';

const ok = (stdout = ''): SafeExecResult => ({ stdout, stderr: '', code: 0 });

/**
 * A SafeExec mock that records argv and dispatches by binary. It mirrors the
 * real agent.sendCommand contract: an "error reply" is a THROW, not a returned
 * `{error}` (project memory `agent.sendCommand rejects on error replies`).
 */
function mockExec(
  byBinary: Record<string, SafeExecResult | ((argv: string[]) => SafeExecResult)> = {},
): { exec: SafeExec; calls: string[][]; opts: ({ timeoutMs?: number; sudo?: boolean } | undefined)[] } {
  const calls: string[][] = [];
  const opts: ({ timeoutMs?: number; sudo?: boolean } | undefined)[] = [];
  const exec: SafeExec = vi.fn(async (argv: string[], options?) => {
    calls.push(argv);
    opts.push(options);
    const handler = byBinary[argv[0]];
    if (handler === undefined) return ok();
    return typeof handler === 'function' ? handler(argv) : handler;
  });
  return { exec, calls, opts };
}

/** The sudo flag passed alongside the first call whose argv[0] === binary. */
function sudoFor(calls: string[][], opts: ({ sudo?: boolean } | undefined)[], binary: string): boolean | undefined {
  const i = calls.findIndex(c => c[0] === binary);
  return i === -1 ? undefined : opts[i]?.sudo;
}

describe('listBlockDevices', () => {
  it('flattens the lsblk tree, carries removable to children, and skips loop devices', async () => {
    const tree = {
      blockdevices: [
        {
          name: 'sda', path: '/dev/sda', size: 16000000000, type: 'disk', rm: true,
          children: [
            { name: 'sda1', path: '/dev/sda1', size: 15000000000, fstype: 'exfat', label: 'USB', mountpoint: null, type: 'part' },
          ],
        },
        { name: 'loop0', path: '/dev/loop0', size: 1000, type: 'loop' },
        { name: 'nvme0n1', path: '/dev/nvme0n1', size: 500000000000, fstype: 'ext4', mountpoint: '/', type: 'disk', rm: false },
      ],
    };
    const { exec, calls, opts } = mockExec({ lsblk: ok(JSON.stringify(tree)) });

    const devices = await listBlockDevices(exec);

    // lsblk called with -J -b and read-only fields.
    expect(calls[0][0]).toBe('lsblk');
    expect(calls[0]).toContain('-J');
    expect(calls[0]).toContain('-b');

    // lsblk is a READ-ONLY enumeration — it must NOT run privileged (#1713).
    expect(sudoFor(calls, opts, 'lsblk')).not.toBe(true);

    const sda1 = devices.find(d => d.path === '/dev/sda1')!;
    expect(sda1.removable).toBe(true); // inherited from parent sda
    expect(sda1.fstype).toBe('exfat');
    expect(sda1.size).toBe(15000000000);

    const root = devices.find(d => d.path === '/dev/nvme0n1')!;
    expect(root.removable).toBe(false);
    expect(root.mountpoint).toBe('/');

    // loop device dropped.
    expect(devices.some(d => d.path === '/dev/loop0')).toBe(false);
  });

  it('throws on a non-zero lsblk exit (does not swallow the error)', async () => {
    const { exec } = mockExec({ lsblk: { stdout: '', stderr: 'boom', code: 1 } });
    await expect(listBlockDevices(exec)).rejects.toThrow(/lsblk failed/);
  });
});

describe('mountReadOnly', () => {
  it('mkdirs the mountpoint then mounts -o ro (never rw) at a controlled path', async () => {
    const { exec, calls, opts } = mockExec();
    const mp = await mountReadOnly(exec, '/dev/sda1');

    expect(mp).toBe(`${MOUNT_BASE}/sda1`);
    const mkdir = calls.find(c => c[0] === 'mkdir')!;
    expect(mkdir).toEqual(['mkdir', '-p', mp]);

    const mount = calls.find(c => c[0] === 'mount')!;
    expect(mount).toEqual(['mount', '-o', 'ro', '/dev/sda1', mp]);
    // Absolutely no read-write mount.
    expect(mount).not.toContain('rw');
    expect(mount.join(' ')).not.toMatch(/\brw\b/);

    // mkdir (under root-owned /run) and mount BOTH run privileged (#1713).
    expect(sudoFor(calls, opts, 'mkdir')).toBe(true);
    expect(sudoFor(calls, opts, 'mount')).toBe(true);
  });

  it('does NOT stack on a stale mount: sweeps existing layer(s) first, then mounts once (#1941)', async () => {
    // The box failure: prior crashed scans left read-only mounts STACKED on the
    // device at the same mountpoint. findmnt reports the device/target mounted
    // until enough umounts have peeled the stack; then the fresh `mount` runs.
    const mp = `${MOUNT_BASE}/sda1`;
    let layers = 3; // three stale layers to drain
    const { exec, calls, opts } = mockExec({
      // findmnt --source <dev> / --mountpoint <mp>: "mounted" while layers remain.
      findmnt: () => (layers > 0 ? ok(mp) : ok('')),
      umount: () => {
        if (layers > 0) layers -= 1;
        return ok();
      },
    });

    const result = await mountReadOnly(exec, '/dev/sda1');
    expect(result).toBe(mp);

    // Exactly ONE `mount -o ro`, and it runs AFTER every stale umount (no stack).
    const mounts = calls.filter(c => c[0] === 'mount');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual(['mount', '-o', 'ro', '/dev/sda1', mp]);

    // The three stale layers were peeled before the fresh mount.
    const umounts = calls.filter(c => c[0] === 'umount');
    expect(umounts).toHaveLength(3);
    const lastUmountIdx = calls.map(c => c[0]).lastIndexOf('umount');
    const mountIdx = calls.findIndex(c => c[0] === 'mount');
    expect(lastUmountIdx).toBeLessThan(mountIdx); // unmount-then-mount sequence

    // The sweep umounts run privileged, same as the mount.
    expect(sudoFor(calls, opts, 'umount')).toBe(true);
  });

  it('does not unmount anything when nothing is already mounted (clean device)', async () => {
    // findmnt reports "not mounted" (empty stdout) → no sweep, just mkdir+mount.
    const { exec, calls } = mockExec({ findmnt: ok('') });
    await mountReadOnly(exec, '/dev/sda1');
    expect(calls.some(c => c[0] === 'umount')).toBe(false);
    expect(calls.filter(c => c[0] === 'mount')).toHaveLength(1);
  });

  it('throws (no mount) on an unsafe device path — shell metacharacters', async () => {
    const { exec, calls } = mockExec();
    await expect(mountReadOnly(exec, '/dev/sda1; rm -rf /')).rejects.toThrow(/unsafe device/);
    await expect(mountReadOnly(exec, '/dev/../etc/shadow')).rejects.toThrow(/unsafe device/);
    expect(calls).toHaveLength(0); // nothing reached the host
  });

  it('surfaces a failed mount as a thrown error', async () => {
    const { exec } = mockExec({ mount: { stdout: '', stderr: 'wrong fs', code: 32 } });
    await expect(mountReadOnly(exec, '/dev/sda1')).rejects.toThrow(/mount -o ro failed/);
  });
});

describe('unmount', () => {
  it('umounts a path inside MOUNT_BASE', async () => {
    const { exec, calls, opts } = mockExec();
    await unmount(exec, `${MOUNT_BASE}/sda1`);
    expect(calls[0]).toEqual(['umount', `${MOUNT_BASE}/sda1`]);
    // umount needs root too (#1713).
    expect(sudoFor(calls, opts, 'umount')).toBe(true);
  });

  it('refuses to umount a path outside MOUNT_BASE', async () => {
    const { exec, calls } = mockExec();
    await expect(unmount(exec, '/')).rejects.toThrow(/outside/);
    await expect(unmount(exec, '/mnt/data/stacks')).rejects.toThrow(/outside/);
    expect(calls).toHaveLength(0);
  });
});

describe('path guards', () => {
  it('assertSafeDevice accepts /dev nodes and rejects traversal/metacharacters', () => {
    expect(() => assertSafeDevice('/dev/sda1')).not.toThrow();
    expect(() => assertSafeDevice('/dev/nvme0n1p3')).not.toThrow();
    expect(() => assertSafeDevice('/etc/passwd')).toThrow();
    expect(() => assertSafeDevice('/dev/sda1 --bind')).toThrow();
    expect(() => assertSafeDevice('/dev/$(whoami)')).toThrow();
  });

  it('mountpointFor refuses an unsafe explicit name', () => {
    expect(mountpointFor('/dev/sda1', 'usb0')).toBe(`${MOUNT_BASE}/usb0`);
    expect(() => mountpointFor('/dev/sda1', '../escape')).toThrow(/unsafe mountpoint/);
    expect(() => mountpointFor('/dev/sda1', 'a/b')).toThrow(/unsafe mountpoint/);
  });
});
