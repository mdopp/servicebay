/**
 * `disk` probe (#2527).
 *
 * Every fixture is real `df -P -B1` output shape, and the byte counts in the
 * NEAR_FULL one are the numbers measured on the box that filed the issue:
 * a 350 MiB usable /boot at 91% with ~56 MiB free, a 2 TB data array at 64%,
 * and a 238 GiB root at 14%. That combination is the whole point of the
 * change — the only filesystem that was watched before is the only one that
 * is fine.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDiskFill,
  evaluateDiskFill,
  formatBytes,
  MONITORED_FILESYSTEMS,
  DISK_FILL_COMMAND,
} from './diskFill';

/** The reference box: /boot critically low, everything else healthy. */
const NEAR_FULL_BOOT = `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 308402176 58467328 91% /boot
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

/** The same box after `rpm-ostree cleanup -bm` reclaimed one deployment. */
const HEALTHY = `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

/** /boot in the early-warning band: one kernel image no longer fits. */
const BOOT_TIGHT = `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 261000000 105869504 71% /boot
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

/** No /boot partition at all — a container/dev target. `df` prints nothing
 *  for it, so the line comes back with an empty right-hand side. */
const NO_BOOT_PARTITION = `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

/** /boot exists as a plain directory on the root filesystem — `df` answers
 *  with the root row, same device. */
const BOOT_ON_ROOT = `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

/** The array never assembled — the pre-existing "not mounted yet" case. */
const NO_DATA_MOUNT = `/mnt/data|
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

/** Root nearly gone: image pulls and journald are about to fail. */
const ROOT_CRITICAL = `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /
`;

/** Data array full, boot and root fine — the pre-#2527 behaviour, unchanged. */
const DATA_FULL = `/mnt/data|/dev/md127 1999285899264 1899321604300 99964294964 95% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`;

describe('DISK_FILL_COMMAND', () => {
  it('asks about all three filesystems, in exact bytes', () => {
    expect(DISK_FILL_COMMAND).toContain('/mnt/data');
    expect(DISK_FILL_COMMAND).toContain('/boot');
    // -B1 not -h: on /boot the whole signal is an absolute byte count that
    // -h would have rounded away.
    expect(DISK_FILL_COMMAND).toContain('-B1');
    expect(DISK_FILL_COMMAND).toContain('-P');
  });
});

describe('parseDiskFill', () => {
  it('parses a df row into exact byte counts', () => {
    const rows = parseDiskFill(NEAR_FULL_BOOT);
    expect(rows).toHaveLength(3);
    const boot = rows.find(r => r.path === '/boot')!;
    expect(boot.present).toBe(true);
    expect(boot.device).toBe('/dev/nvme1n1p3');
    expect(boot.totalBytes).toBe(366869504);
    expect(boot.usedBytes).toBe(308402176);
    expect(boot.freeBytes).toBe(58467328);
    expect(boot.usedPct).toBe(91);
    expect(boot.mountpoint).toBe('/boot');
  });

  it('keeps the requested path distinct from the mountpoint (CoreOS symlinks /mnt to /var/mnt)', () => {
    const data = parseDiskFill(NEAR_FULL_BOOT).find(r => r.path === '/mnt/data')!;
    expect(data.mountpoint).toBe('/var/mnt/data');
    expect(data.present).toBe(true);
  });

  it('marks a path df returned nothing for as absent instead of dropping it', () => {
    const rows = parseDiskFill(NO_BOOT_PARTITION);
    expect(rows.map(r => r.path)).toEqual(['/mnt/data', '/boot', '/']);
    expect(rows.find(r => r.path === '/boot')!.present).toBe(false);
  });

  it('survives garbage without throwing', () => {
    expect(() => parseDiskFill('nonsense\n|\n/boot|not a df row')).not.toThrow();
    expect(parseDiskFill('/boot|not a df row')[0].present).toBe(false);
  });
});

describe('formatBytes', () => {
  it('renders the sizes an operator has to compare', () => {
    expect(formatBytes(58467328)).toBe('55.8 MiB');
    expect(formatBytes(128 * 1024 * 1024)).toBe('128 MiB');
    expect(formatBytes(221072547840)).toBe('206 GiB');
    expect(formatBytes(1999285899264)).toBe('1.8 TiB');
  });
});

describe('evaluateDiskFill — thresholds match what each filesystem is for', () => {
  it('the numbers are per-filesystem, not one global percentage', () => {
    const boot = MONITORED_FILESYSTEMS.find(f => f.path === '/boot')!;
    const data = MONITORED_FILESYSTEMS.find(f => f.path === '/mnt/data')!;
    // /boot is judged on absolute headroom only — a percentage on a 350 MiB
    // partition is meaningless.
    expect(boot.warnUsedPct).toBeNull();
    expect(boot.warnFreeBytes).toBe(128 * 1024 * 1024);
    expect(boot.failFreeBytes).toBe(64 * 1024 * 1024);
    // /mnt/data is judged on percentage only — a byte floor on a 2 TB array
    // would either never fire or fire constantly.
    expect(data.warnFreeBytes).toBeNull();
    expect(data.warnUsedPct).toBe(90);
  });

  it('offers a fix button only where ServiceBay may safely act', () => {
    const byPath = Object.fromEntries(MONITORED_FILESYSTEMS.map(f => [f.path, f.actionIds]));
    expect(byPath['/mnt/data']).toEqual(['show_largest_dirs']);
    // Reclaiming these means deleting kernels / images — operator decisions.
    expect(byPath['/boot']).toEqual([]);
    expect(byPath['/']).toEqual([]);
  });
});

describe('evaluateDiskFill — near-full /boot', () => {
  const result = evaluateDiskFill(NEAR_FULL_BOOT, 0);

  it('fails rather than staying silent on the box that filed the issue', () => {
    // 55.8 MiB free is under half a kernel image: the next rpm-ostree
    // upgrade cannot stage a boot entry from here.
    expect(result.status).toBe('fail');
  });

  it('names the consequence, not just the number', () => {
    expect(result.detail).toContain('/boot');
    expect(result.detail).toContain('91% used');
    expect(result.detail).toContain('55.8 MiB free');
    expect(result.detail).toMatch(/next OS update will fail/);
    expect(result.detail).toMatch(/unable to boot/);
  });

  it('tells the operator what to do, and that ServiceBay will not do it', () => {
    expect(result.hint).toContain('rpm-ostree cleanup -bm');
    expect(result.hint).toMatch(/ServiceBay will not delete kernels/);
  });

  it('surfaces /boot as its own row with no one-click fix', () => {
    expect(result.items).toHaveLength(1);
    const [item] = result.items!;
    expect(item.id).toBe('/boot');
    expect(item.status).toBe('fail');
    expect(item.actionIds).toEqual([]);
  });

  it('leads with the unhealthy filesystem so it is not below the fold', () => {
    expect(result.detail.split('\n')[0]).toContain('/boot');
  });

  it('does not drag the healthy filesystems into the warning', () => {
    expect(result.items!.map(i => i.id)).not.toContain('/mnt/data');
    expect(result.detail).toContain('/mnt/data — 64% used');
    expect(result.detail).toContain('/ — 14% used');
  });
});

describe('evaluateDiskFill — the early-warning band', () => {
  it('warns while the operator can still act, before the failing band', () => {
    // ~101 MiB free: under one kernel image (warn) but above the 64 MiB
    // floor (fail). This is the window the issue says has to exist.
    const result = evaluateDiskFill(BOOT_TIGHT, 0);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/boot');
    expect(result.hint).toContain('rpm-ostree cleanup -bm');
    expect(result.items!.map(i => i.status)).toEqual(['warn']);
  });
});

describe('evaluateDiskFill — healthy partitions produce no noise', () => {
  const result = evaluateDiskFill(HEALTHY, 0);

  it('is ok with no hint and no items', () => {
    expect(result.status).toBe('ok');
    expect(result.hint).toBeUndefined();
    expect(result.items).toBeUndefined();
  });

  it('still reports every filesystem it looked at', () => {
    expect(result.detail).toContain('/mnt/data — 64% used');
    expect(result.detail).toContain('/boot — 42% used');
    expect(result.detail).toContain('/ — 14% used');
  });

  it('does not warn about a 91%-shaped /mnt/data threshold applied to /boot', () => {
    // 42% on /boot is 204 MiB free — above the headroom floor. A naive
    // percentage rule would agree here; the point is that it also has to
    // agree at 71% (BOOT_TIGHT), where it does not.
    expect(evaluateDiskFill(BOOT_TIGHT, 0).status).not.toBe('ok');
  });
});

describe('evaluateDiskFill — missing partitions', () => {
  it('treats an absent /boot as information, not a problem', () => {
    const result = evaluateDiskFill(NO_BOOT_PARTITION, 0);
    // `info`, not `warn`/`fail` — diagnoseStatusToCheckStatus collapses it to
    // a passing check, so a box with no /boot never nags. Same call the raid
    // probe makes for a box with no md array.
    expect(result.status).toBe('info');
    expect(['warn', 'fail']).not.toContain(result.status);
    expect(result.detail).toContain('/boot is not a separate partition');
    expect(result.items).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it('counts a /boot that shares the root filesystem under / instead of judging it by kernel-sized rules', () => {
    const result = evaluateDiskFill(BOOT_ON_ROOT, 0);
    expect(['warn', 'fail']).not.toContain(result.status);
    expect(result.detail).toContain('/boot is not a separate partition');
    expect(result.detail).toContain('counted under / below');
    // The root's own 14%/206 GiB row is what gets judged, and it is healthy.
    expect(result.items).toBeUndefined();
  });

  it('keeps the pre-existing "data array not mounted" warning', () => {
    const result = evaluateDiskFill(NO_DATA_MOUNT, 0);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/mnt/data is not mounted');
    expect(result.detail).toContain('first-boot RAID setup');
  });

  it('reports an unreadable df honestly rather than as empty filesystems', () => {
    const result = evaluateDiskFill('', 1);
    expect(result.status).toBe('info');
    expect(result.detail).toContain('unknown');
    expect(evaluateDiskFill('', 0).status).toBe('info');
  });
});

describe('evaluateDiskFill — the other two filesystems', () => {
  it('fails a root filesystem with under a GiB left', () => {
    const result = evaluateDiskFill(ROOT_CRITICAL, 0);
    expect(result.status).toBe('fail');
    expect(result.items!.map(i => i.id)).toEqual(['/']);
    expect(result.detail).toMatch(/Container image pulls, system logs and OS updates all fail/);
    expect(result.hint).toContain('podman image prune');
  });

  it('keeps the /mnt/data 90% behaviour it had before, with its fix button', () => {
    const result = evaluateDiskFill(DATA_FULL, 0);
    expect(result.status).toBe('warn');
    expect(result.items).toHaveLength(1);
    expect(result.items![0].id).toBe('/mnt/data');
    expect(result.items![0].actionIds).toEqual(['show_largest_dirs']);
    expect(result.hint).toContain('Show largest directories');
  });
});
