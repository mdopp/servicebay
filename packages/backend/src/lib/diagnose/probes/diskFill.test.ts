/**
 * `disk` probe (#2527, corrected by #2564).
 *
 * Every fixture is real `df -P -B1` + `/proc/self/mounts` output shape, and
 * the byte counts are the ones measured on the reference Fedora CoreOS box:
 * a read-only composefs `/` of 12.7 MiB at 100% (by construction, on every
 * healthy box), `/var` on xfs with ~206 GiB free, a 350 MiB `/boot` at 91%
 * with 32.6 MiB free — and `/boot` mounted `ro`, which is why "read-only" on
 * its own may never excuse a filesystem from being judged.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDiskFill,
  parseMountTable,
  isImmutableImage,
  evaluateDiskFill,
  formatBytes,
  MONITORED_FILESYSTEMS,
  DISK_FILL_COMMAND,
  DISK_FILL_MOUNTS_MARKER,
} from './diskFill';

const MiB = 1024 * 1024;

/** Glue the two halves of the probe's output together, as the box does. */
function probeOutput(df: string, mounts: string): string {
  return `${df}${DISK_FILL_MOUNTS_MARKER}\n${mounts}`;
}

/**
 * The reference box's mount table, trimmed to the lines that matter. Note
 * `/boot` is `ro` and `/sysroot` is `ro` — only `/var` and `/etc` are `rw`.
 */
const FCOS_MOUNTS = `composefs / overlay ro,seclabel,relatime,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on 0 0
/dev/nvme1n1p4 /etc xfs rw,seclabel,relatime,inode64,logbufs=8,logbsize=32k,prjquota 0 0
/dev/nvme1n1p4 /sysroot xfs ro,seclabel,relatime,inode64,logbufs=8,logbsize=32k,prjquota 0 0
/dev/nvme1n1p4 /var xfs rw,seclabel,relatime,inode64,logbufs=8,logbsize=32k,prjquota 0 0
/dev/nvme1n1p3 /boot ext4 ro,seclabel,nosuid,nodev,relatime 0 0
/dev/md127 /var/mnt/data xfs rw,seclabel,relatime,attr2,inode64,logbufs=8,logbsize=32k,prjquota 0 0
`;

/** A box with one ordinary writable root and no separate /var. */
const PLAIN_MOUNTS = `/dev/nvme1n1p4 / xfs rw,relatime,seclabel,inode64 0 0
/dev/nvme1n1p3 /boot ext4 rw,relatime,seclabel 0 0
/dev/md127 /var/mnt/data xfs rw,relatime,seclabel 0 0
`;

/** The reference box as it stands today: /boot critical, everything else fine. */
const FCOS_BOOT_CRITICAL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 308402176 34141184 91% /boot
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** The same box after `rpm-ostree cleanup -bm` reclaimed one deployment. */
const FCOS_HEALTHY = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 157154304 209715200 43% /boot
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** The writable filesystem genuinely full — 625 MiB left on /var. */
const FCOS_VAR_CRITICAL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 157154304 209715200 43% /boot
/var|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** /boot at 129 MiB free: one measured deployment (~143 MiB) no longer fits. */
const FCOS_BOOT_UNDER_ONE_PAYLOAD = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 231603200 135266304 63% /boot
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** /boot in the failing band: not even a vmlinuz plus a slice of initramfs. */
const FCOS_BOOT_TIGHT = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 261000000 105869504 71% /boot
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** A plain writable root, healthy: /var is not its own filesystem, so `df`
 *  answers for it with the root row. */
const PLAIN_HEALTHY = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

/** No /boot partition at all — a container/dev target. `df` prints nothing
 *  for it, so the line comes back with an empty right-hand side. */
const NO_BOOT_PARTITION = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

/** The array never assembled — the pre-existing "not mounted yet" case. */
const NO_DATA_MOUNT = probeOutput(
  `/mnt/data|
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

/** Writable root nearly gone on a plain box: /var folds into it. */
const PLAIN_ROOT_CRITICAL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/var|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /
/|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /
`,
  PLAIN_MOUNTS,
);

/** Data array full, boot and root fine — the pre-#2527 behaviour, unchanged. */
const DATA_FULL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1899321604300 99964294964 95% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 152043520 214825984 42% /boot
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

describe('DISK_FILL_COMMAND', () => {
  it('asks about all four filesystems, in exact bytes', () => {
    expect(DISK_FILL_COMMAND).toContain('/mnt/data');
    expect(DISK_FILL_COMMAND).toContain('/boot');
    // /var is where the writable system state lives on an ostree box (#2564).
    expect(DISK_FILL_COMMAND).toContain('/var');
    // -B1 not -h: on /boot the whole signal is an absolute byte count that
    // -h would have rounded away.
    expect(DISK_FILL_COMMAND).toContain('-B1');
    expect(DISK_FILL_COMMAND).toContain('-P');
  });

  it('also reads the mount table, because df does not print mount options', () => {
    expect(DISK_FILL_COMMAND).toContain('/proc/self/mounts');
    expect(DISK_FILL_COMMAND).toContain(DISK_FILL_MOUNTS_MARKER);
  });
});

describe('parseMountTable', () => {
  it('reads the filesystem type and whether the mount is read-only', () => {
    const mounts = parseMountTable(FCOS_MOUNTS);
    expect(mounts.get('/')).toEqual({ fstype: 'overlay', readOnly: true });
    expect(mounts.get('/var')).toEqual({ fstype: 'xfs', readOnly: false });
    // Both true on the reference box, and both matter: /sysroot is the same
    // filesystem as /var but mounted ro, which is why /var is what we watch.
    expect(mounts.get('/sysroot')!.readOnly).toBe(true);
    expect(mounts.get('/boot')!.readOnly).toBe(true);
  });

  it('does not mistake an option ending in "ro" for read-only', () => {
    const mounts = parseMountTable('/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0\n');
    expect(mounts.get('/')!.readOnly).toBe(false);
  });

  it('lets a later mount over the same point win, as the kernel does', () => {
    const mounts = parseMountTable(
      '/dev/sda1 /var ext4 ro,relatime 0 0\n/dev/sdb1 /var xfs rw,relatime 0 0\n',
    );
    expect(mounts.get('/var')).toEqual({ fstype: 'xfs', readOnly: false });
  });

  it('decodes the octal escapes /proc uses in mount paths', () => {
    const mounts = parseMountTable('/dev/sdb1 /mnt/my\\040disk xfs rw,relatime 0 0\n');
    expect(mounts.get('/mnt/my disk')!.fstype).toBe('xfs');
  });

  it('survives garbage without throwing', () => {
    expect(() => parseMountTable('nonsense\n\n   \n')).not.toThrow();
    expect(parseMountTable('nonsense').size).toBe(0);
  });
});

describe('parseDiskFill', () => {
  it('parses a df row into exact byte counts', () => {
    const rows = parseDiskFill(FCOS_BOOT_CRITICAL);
    expect(rows).toHaveLength(4);
    const boot = rows.find(r => r.path === '/boot')!;
    expect(boot.present).toBe(true);
    expect(boot.device).toBe('/dev/nvme1n1p3');
    expect(boot.totalBytes).toBe(366869504);
    expect(boot.usedBytes).toBe(308402176);
    expect(boot.freeBytes).toBe(34141184);
    expect(boot.usedPct).toBe(91);
    expect(boot.mountpoint).toBe('/boot');
  });

  it('joins each row to the mount table by mountpoint', () => {
    const rows = parseDiskFill(FCOS_BOOT_CRITICAL);
    const root = rows.find(r => r.path === '/')!;
    expect(root.device).toBe('composefs');
    expect(root.fstype).toBe('overlay');
    expect(root.readOnly).toBe(true);
    const varRow = rows.find(r => r.path === '/var')!;
    expect(varRow.fstype).toBe('xfs');
    expect(varRow.readOnly).toBe(false);
  });

  it('treats a row with no mount-table entry as writable, so it stays judged', () => {
    const rows = parseDiskFill('/|/dev/sda1 100 90 10 90% /');
    expect(rows[0].readOnly).toBe(false);
    expect(rows[0].fstype).toBe('');
  });

  it('keeps the requested path distinct from the mountpoint (CoreOS symlinks /mnt to /var/mnt)', () => {
    const data = parseDiskFill(FCOS_BOOT_CRITICAL).find(r => r.path === '/mnt/data')!;
    expect(data.mountpoint).toBe('/var/mnt/data');
    expect(data.present).toBe(true);
  });

  it('marks a path df returned nothing for as absent instead of dropping it', () => {
    const rows = parseDiskFill(NO_BOOT_PARTITION);
    expect(rows.map(r => r.path)).toEqual(['/mnt/data', '/boot', '/var', '/']);
    expect(rows.find(r => r.path === '/boot')!.present).toBe(false);
  });

  it('survives garbage without throwing', () => {
    expect(() => parseDiskFill('nonsense\n|\n/boot|not a df row')).not.toThrow();
    expect(parseDiskFill('/boot|not a df row')[0].present).toBe(false);
  });
});

describe('isImmutableImage — the rule that keeps a read-only image out of the judgement', () => {
  const rowsOf = (raw: string) => new Map(parseDiskFill(raw).map(r => [r.path, r]));

  it('is true for a composefs root: read-only, nothing free, nothing to free', () => {
    expect(isImmutableImage(rowsOf(FCOS_BOOT_CRITICAL).get('/')!)).toBe(true);
  });

  it('is false for /boot even though /boot is also mounted read-only', () => {
    // The half that stops the rule from swallowing the most dangerous
    // filesystem on the box: rpm-ostree remounts /boot rw to stage a kernel,
    // and it has slack, so its free space is a real resource.
    const boot = rowsOf(FCOS_BOOT_CRITICAL).get('/boot')!;
    expect(boot.readOnly).toBe(true);
    expect(isImmutableImage(boot)).toBe(false);
  });

  it('is false for a genuinely full writable filesystem', () => {
    // The other half: 0 B free alone must never excuse a filesystem.
    const full = parseDiskFill(
      probeOutput('/var|/dev/sda1 1000000 1000000 0 100% /var\n', '/dev/sda1 /var xfs rw 0 0\n'),
    )[0];
    expect(full.freeBytes).toBe(0);
    expect(isImmutableImage(full)).toBe(false);
  });

  it('is false for an absent row', () => {
    expect(isImmutableImage(parseDiskFill('/boot|')[0])).toBe(false);
  });
});

describe('evaluateDiskFill — thresholds match what each filesystem is for', () => {
  it('the numbers are per-filesystem, not one global percentage', () => {
    const boot = MONITORED_FILESYSTEMS.find(f => f.path === '/boot')!;
    const data = MONITORED_FILESYSTEMS.find(f => f.path === '/mnt/data')!;
    // /boot is judged on absolute headroom only — a percentage on a 350 MiB
    // partition is meaningless. 192 MiB (not the 128 MiB of #2527) because a
    // measured deployment payload on the reference box is ~143 MiB: the warn
    // has to sit ABOVE one payload, or it fires after staging already became
    // impossible (#2564).
    expect(boot.warnUsedPct).toBeNull();
    expect(boot.warnFreeBytes).toBe(192 * MiB);
    expect(boot.warnFreeBytes!).toBeGreaterThan(143 * MiB);
    // The failing band is unchanged from #2527 on purpose.
    expect(boot.failFreeBytes).toBe(64 * MiB);
    // /mnt/data is judged on percentage only — a byte floor on a 2 TB array
    // would either never fire or fire constantly.
    expect(data.warnFreeBytes).toBeNull();
    expect(data.warnUsedPct).toBe(90);
  });

  it('watches the writable system state, with a GiB floor and a percentage backstop', () => {
    const state = MONITORED_FILESYSTEMS.find(f => f.path === '/var')!;
    expect(state.warnFreeBytes).toBe(5 * 1024 * MiB);
    expect(state.failFreeBytes).toBe(1024 * MiB);
    expect(state.warnUsedPct).toBe(90);
    // Same numbers on `/`, which IS the writable state on a box whose root is
    // an ordinary filesystem.
    const root = MONITORED_FILESYSTEMS.find(f => f.path === '/')!;
    expect(root.warnFreeBytes).toBe(state.warnFreeBytes);
    expect(root.failFreeBytes).toBe(state.failFreeBytes);
  });

  it('offers a fix button only where ServiceBay may safely act', () => {
    const byPath = Object.fromEntries(MONITORED_FILESYSTEMS.map(f => [f.path, f.actionIds]));
    expect(byPath['/mnt/data']).toEqual(['show_largest_dirs']);
    // Reclaiming these means deleting kernels / images — operator decisions.
    expect(byPath['/boot']).toEqual([]);
    expect(byPath['/var']).toEqual([]);
    expect(byPath['/']).toEqual([]);
  });
});

describe('evaluateDiskFill — a composefs root is never judged by free space (#2564)', () => {
  it('leaves a healthy ostree box completely quiet', () => {
    const result = evaluateDiskFill(FCOS_HEALTHY, 0);
    expect(result.status).toBe('ok');
    expect(result.hint).toBeUndefined();
    expect(result.items).toBeUndefined();
  });

  it('reports the root as the image it is, instead of predicting failures that cannot happen', () => {
    const result = evaluateDiskFill(FCOS_HEALTHY, 0);
    expect(result.detail).toContain('/ — a read-only image of 12.7 MiB');
    expect(result.detail).toContain('100% used by construction');
    expect(result.detail).toContain('composefs');
    // The exact false alarm this issue is about.
    expect(result.detail).not.toContain('below the 1.0 GiB floor');
    expect(result.detail).not.toMatch(/Container image pulls, system logs and OS updates all fail/);
  });

  it('is a structural rule, not a match on the word "composefs"', () => {
    // Same shape, a squashfs image on a loop device, no ostree anywhere.
    const squashfs = probeOutput(
      `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 157154304 209715200 43% /boot
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|/dev/loop0 4194304 4194304 0 100% /
`,
      `/dev/loop0 / squashfs ro,relatime 0 0
/dev/nvme1n1p4 /var xfs rw,relatime 0 0
/dev/nvme1n1p3 /boot ext4 ro,relatime 0 0
/dev/md127 /var/mnt/data xfs rw,relatime 0 0
`,
    );
    const result = evaluateDiskFill(squashfs, 0);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('a read-only image of 4.0 MiB');
  });

  it('still fails the box when the writable filesystem is the one running out', () => {
    const result = evaluateDiskFill(FCOS_VAR_CRITICAL, 0);
    expect(result.status).toBe('fail');
    expect(result.items!.map(i => i.id)).toEqual(['/var']);
    expect(result.detail).toContain('/var — 99% used, 625 MiB free');
    expect(result.detail).toMatch(/Container image pulls, system logs and OS updates all fail/);
    expect(result.hint).toContain('podman image prune');
  });

  it('judges an ordinary writable root exactly as before', () => {
    const result = evaluateDiskFill(PLAIN_ROOT_CRITICAL, 0);
    expect(result.status).toBe('fail');
    expect(result.items!.map(i => i.id)).toEqual(['/']);
    // /var is not its own filesystem there, so it is counted once, under /.
    expect(result.detail).toContain('/var is not a separate partition');
  });
});

describe('evaluateDiskFill — /boot keeps absolute headroom, warned earlier', () => {
  it('fails the reference box, and blames only /boot', () => {
    const result = evaluateDiskFill(FCOS_BOOT_CRITICAL, 0);
    expect(result.status).toBe('fail');
    // The whole point of #2564: one honest finding, not one honest and one false.
    expect(result.items!.map(i => i.id)).toEqual(['/boot']);
    expect(result.detail).toContain('32.6 MiB free');
    expect(result.detail).toMatch(/next OS update will fail/);
    expect(result.detail).toMatch(/unable to boot/);
  });

  it('judges /boot on free space even though it is mounted read-only', () => {
    // Regression guard for the obvious over-correction: excusing every ro
    // mount would have silenced the one real finding on this box.
    const boot = parseDiskFill(FCOS_BOOT_CRITICAL).find(r => r.path === '/boot')!;
    expect(boot.readOnly).toBe(true);
    expect(evaluateDiskFill(FCOS_BOOT_CRITICAL, 0).items!.map(i => i.id)).toContain('/boot');
  });

  it('warns once one deployment no longer fits — where 128 MiB said nothing', () => {
    // 129 MiB free. A measured payload is ~143 MiB, so an upgrade can no
    // longer be staged here; the old 128 MiB threshold called this ok.
    const result = evaluateDiskFill(FCOS_BOOT_UNDER_ONE_PAYLOAD, 0);
    expect(result.status).toBe('warn');
    expect(result.items!.map(i => i.id)).toEqual(['/boot']);
    expect(result.hint).toContain('rpm-ostree cleanup -bm');
  });

  it('stays quiet at 200 MiB free, where a deployment still fits with room', () => {
    expect(evaluateDiskFill(FCOS_HEALTHY, 0).status).toBe('ok');
  });

  it('warns between one payload and the failing floor, and says ServiceBay will not delete kernels', () => {
    const result = evaluateDiskFill(FCOS_BOOT_TIGHT, 0);
    expect(result.status).toBe('warn');
    expect(result.hint).toContain('rpm-ostree cleanup -bm');
    expect(result.hint).toMatch(/ServiceBay will not delete kernels/);
    expect(result.items!.map(i => i.status)).toEqual(['warn']);
    expect(result.items![0].actionIds).toEqual([]);
  });

  it('leads with the unhealthy filesystem so it is not below the fold', () => {
    expect(evaluateDiskFill(FCOS_BOOT_CRITICAL, 0).detail.split('\n')[0]).toContain('/boot');
  });

  it('does not drag the healthy filesystems into the warning', () => {
    const result = evaluateDiskFill(FCOS_BOOT_CRITICAL, 0);
    expect(result.items!.map(i => i.id)).not.toContain('/mnt/data');
    expect(result.detail).toContain('/mnt/data — 64% used');
    expect(result.detail).toContain('/var — 14% used');
  });
});

describe('evaluateDiskFill — healthy partitions produce no noise', () => {
  const result = evaluateDiskFill(PLAIN_HEALTHY, 0);

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
    // agree at 63% (FCOS_BOOT_UNDER_ONE_PAYLOAD), where it does not.
    expect(evaluateDiskFill(FCOS_BOOT_UNDER_ONE_PAYLOAD, 0).status).not.toBe('ok');
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
    const bootOnRoot = probeOutput(
      `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/boot|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
      '/dev/nvme1n1p4 / xfs rw,relatime 0 0\n/dev/md127 /var/mnt/data xfs rw,relatime 0 0\n',
    );
    const result = evaluateDiskFill(bootOnRoot, 0);
    expect(['warn', 'fail']).not.toContain(result.status);
    expect(result.detail).toContain('/boot is not a separate partition');
    expect(result.detail).toContain('counted under / below');
    // The root's own 14%/206 GiB row is what gets judged, and it is healthy.
    expect(result.items).toBeUndefined();
  });

  it('does not fold a real filesystem into a root that is only an image', () => {
    // Contrived: a filesystem whose df device string collides with the image
    // root's. Folding it under `/` would stop measuring it entirely, because
    // `/` is never judged.
    const collide = probeOutput(
      `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 157154304 209715200 43% /boot
/var|composefs 255455465472 254800000000 655465472 99% /var
/|composefs 13340672 13340672 0 100% /
`,
      FCOS_MOUNTS,
    );
    const result = evaluateDiskFill(collide, 0);
    expect(result.status).toBe('fail');
    expect(result.items!.map(i => i.id)).toEqual(['/var']);
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

describe('formatBytes', () => {
  it('renders the sizes an operator has to compare', () => {
    expect(formatBytes(34141184)).toBe('32.6 MiB');
    expect(formatBytes(192 * MiB)).toBe('192 MiB');
    expect(formatBytes(221072547840)).toBe('206 GiB');
    expect(formatBytes(1999285899264)).toBe('1.8 TiB');
  });
});

describe('evaluateDiskFill — the data array', () => {
  it('keeps the /mnt/data 90% behaviour it had before, with its fix button', () => {
    const result = evaluateDiskFill(DATA_FULL, 0);
    expect(result.status).toBe('warn');
    expect(result.items).toHaveLength(1);
    expect(result.items![0].id).toBe('/mnt/data');
    expect(result.items![0].actionIds).toEqual(['show_largest_dirs']);
    expect(result.hint).toContain('Show largest directories');
  });
});
