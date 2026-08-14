/**
 * `disk` probe (#2527, corrected by #2564, narrowed by #2567).
 *
 * Every fixture is real `df -P -B1` + `/proc/self/mounts` output shape, and
 * the byte counts are the ones measured on the reference Fedora CoreOS box:
 * a read-only composefs `/` of 12.7 MiB at 100% (by construction, on every
 * healthy box) and `/var` on xfs with ~206 GiB free.
 *
 * `/boot` is no longer watched (#2567) — rpm-ostree keeps two deployments on
 * a ~350 MiB partition, so near-full is that partition's healthy steady state
 * and a threshold there fires on every box. What remains here about `/boot`
 * is the guard that keeps it removed, not a threshold.
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
  PROBE_LABEL,
} from './diskFill';

const MiB = 1024 * 1024;

/** Glue the two halves of the probe's output together, as the box does. */
function probeOutput(df: string, mounts: string): string {
  return `${df}${DISK_FILL_MOUNTS_MARKER}\n${mounts}`;
}

/**
 * The reference box's mount table, trimmed to the lines that matter. Note
 * `/sysroot` is `ro` while `/var` — the same filesystem — is `rw`, which is
 * why `/var` is the one watched.
 */
const FCOS_MOUNTS = `composefs / overlay ro,seclabel,relatime,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on 0 0
/dev/nvme1n1p4 /etc xfs rw,seclabel,relatime,inode64,logbufs=8,logbsize=32k,prjquota 0 0
/dev/nvme1n1p4 /sysroot xfs ro,seclabel,relatime,inode64,logbufs=8,logbsize=32k,prjquota 0 0
/dev/nvme1n1p4 /var xfs rw,seclabel,relatime,inode64,logbufs=8,logbsize=32k,prjquota 0 0
/dev/md127 /var/mnt/data xfs rw,seclabel,relatime,attr2,inode64,logbufs=8,logbsize=32k,prjquota 0 0
`;

/** A box with one ordinary writable root and no separate /var. */
const PLAIN_MOUNTS = `/dev/nvme1n1p4 / xfs rw,relatime,seclabel,inode64 0 0
/dev/md127 /var/mnt/data xfs rw,relatime,seclabel 0 0
`;

/** The reference box in its normal state: everything the probe watches is fine. */
const FCOS_HEALTHY = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** The writable filesystem genuinely full — 625 MiB left on /var. */
const FCOS_VAR_CRITICAL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/var|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /var
/|composefs 13340672 13340672 0 100% /
`,
  FCOS_MOUNTS,
);

/** A plain writable root, healthy: /var is not its own filesystem, so `df`
 *  answers for it with the root row. */
const PLAIN_HEALTHY = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

/** The array never assembled — the pre-existing "not mounted yet" case, and
 *  the shape `df` produces for a path it could not stat at all. */
const NO_DATA_MOUNT = probeOutput(
  `/mnt/data|
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

/** Writable root nearly gone on a plain box: /var folds into it. */
const PLAIN_ROOT_CRITICAL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1269934231552 729351667712 64% /var/mnt/data
/var|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /
/|/dev/nvme1n1p4 255455465472 254800000000 655465472 99% /
`,
  PLAIN_MOUNTS,
);

/** Data array full, everything else fine — the pre-#2527 behaviour, unchanged. */
const DATA_FULL = probeOutput(
  `/mnt/data|/dev/md127 1999285899264 1899321604300 99964294964 95% /var/mnt/data
/var|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
/|/dev/nvme1n1p4 255455465472 34382917632 221072547840 14% /
`,
  PLAIN_MOUNTS,
);

describe('DISK_FILL_COMMAND', () => {
  it('asks about the filesystems it watches, in exact bytes', () => {
    expect(DISK_FILL_COMMAND).toContain('/mnt/data');
    // /var is where the writable system state lives on an ostree box (#2564).
    expect(DISK_FILL_COMMAND).toContain('/var');
    // -B1 not -h: the GiB floors on /var are compared against a real number,
    // not one -h already rounded.
    expect(DISK_FILL_COMMAND).toContain('-B1');
    expect(DISK_FILL_COMMAND).toContain('-P');
  });

  it('also reads the mount table, because df does not print mount options', () => {
    expect(DISK_FILL_COMMAND).toContain('/proc/self/mounts');
    expect(DISK_FILL_COMMAND).toContain(DISK_FILL_MOUNTS_MARKER);
  });
});

describe('/boot is deliberately not watched (#2567)', () => {
  it('has no /boot row at all', () => {
    // Removed, not disabled: rpm-ostree keeps two deployments on a ~350 MiB
    // partition, so 91% used is the healthy steady state there and any
    // threshold on it fires on every box — the same false-alarm class #2564
    // removed from the composefs root.
    expect(MONITORED_FILESYSTEMS.map(f => f.path)).toEqual(['/mnt/data', '/var', '/']);
  });

  it('does not even ask df about /boot', () => {
    expect(DISK_FILL_COMMAND).not.toContain('/boot');
  });

  it('stays silent about a /boot at 91% — the measured healthy steady state', () => {
    // 32.6 MiB free of 350 MiB, two retained deployments (140.6 + 142.8 MiB).
    // Even handed the row, the probe neither reports nor judges it.
    const withBoot = probeOutput(
      `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
/boot|/dev/nvme1n1p3 366869504 308402176 34141184 91% /boot
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|composefs 13340672 13340672 0 100% /
`,
      `${FCOS_MOUNTS}/dev/nvme1n1p3 /boot ext4 ro,seclabel,nosuid,nodev,relatime 0 0\n`,
    );
    const result = evaluateDiskFill(withBoot, 0);
    expect(result.status).toBe('ok');
    expect(result.detail).not.toContain('/boot');
    expect(result.items).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it('does not advertise /boot in the probe label either', () => {
    expect(PROBE_LABEL).toBe('Storage (/mnt/data, /var, /)');
  });
});

describe('parseMountTable', () => {
  it('reads the filesystem type and whether the mount is read-only', () => {
    const mounts = parseMountTable(FCOS_MOUNTS);
    expect(mounts.get('/')).toEqual({ fstype: 'overlay', readOnly: true });
    expect(mounts.get('/var')).toEqual({ fstype: 'xfs', readOnly: false });
    // /sysroot is the same filesystem as /var but mounted ro, which is why
    // /var is the one we watch.
    expect(mounts.get('/sysroot')!.readOnly).toBe(true);
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
    const rows = parseDiskFill(FCOS_HEALTHY);
    expect(rows).toHaveLength(3);
    const varRow = rows.find(r => r.path === '/var')!;
    expect(varRow.present).toBe(true);
    expect(varRow.device).toBe('/dev/nvme1n1p4');
    expect(varRow.totalBytes).toBe(255455465472);
    expect(varRow.usedBytes).toBe(34435706880);
    expect(varRow.freeBytes).toBe(221019758592);
    expect(varRow.usedPct).toBe(14);
    expect(varRow.mountpoint).toBe('/var');
  });

  it('joins each row to the mount table by mountpoint', () => {
    const rows = parseDiskFill(FCOS_HEALTHY);
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
    const data = parseDiskFill(FCOS_HEALTHY).find(r => r.path === '/mnt/data')!;
    expect(data.mountpoint).toBe('/var/mnt/data');
    expect(data.present).toBe(true);
  });

  it('marks a path df returned nothing for as absent instead of dropping it', () => {
    const rows = parseDiskFill(NO_DATA_MOUNT);
    expect(rows.map(r => r.path)).toEqual(['/mnt/data', '/var', '/']);
    expect(rows.find(r => r.path === '/mnt/data')!.present).toBe(false);
  });

  it('survives garbage without throwing', () => {
    expect(() => parseDiskFill('nonsense\n|\n/var|not a df row')).not.toThrow();
    expect(parseDiskFill('/var|not a df row')[0].present).toBe(false);
  });
});

describe('isImmutableImage — the rule that keeps a read-only image out of the judgement', () => {
  const rowsOf = (raw: string) => new Map(parseDiskFill(raw).map(r => [r.path, r]));

  it('is true for a composefs root: read-only, nothing free, nothing to free', () => {
    expect(isImmutableImage(rowsOf(FCOS_HEALTHY).get('/')!)).toBe(true);
  });

  it('is false for a read-only mount that still has slack', () => {
    // The half that stops the rule from swallowing a filesystem that is only
    // ro *right now*: Fedora CoreOS mounts /sysroot and /boot ro and remounts
    // them rw to write, so their free space is a real, movable resource.
    const roWithSlack = parseDiskFill(
      probeOutput(
        '/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var\n',
        '/dev/nvme1n1p4 /var xfs ro,relatime 0 0\n',
      ),
    )[0];
    expect(roWithSlack.readOnly).toBe(true);
    expect(isImmutableImage(roWithSlack)).toBe(false);
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
    expect(isImmutableImage(parseDiskFill('/var|')[0])).toBe(false);
  });
});

describe('evaluateDiskFill — thresholds match what each filesystem is for', () => {
  it('the numbers are per-filesystem, not one global percentage', () => {
    const data = MONITORED_FILESYSTEMS.find(f => f.path === '/mnt/data')!;
    // /mnt/data is judged on percentage only — a byte floor on a 2 TB array
    // would either never fire or fire constantly.
    expect(data.warnFreeBytes).toBeNull();
    expect(data.failFreeBytes).toBeNull();
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
    // Reclaiming these means deleting container images and logs — operator
    // decisions.
    expect(byPath['/var']).toEqual([]);
    expect(byPath['/']).toEqual([]);
  });
});

/**
 * #2566. The shipped hint said `rpm-ostree cleanup -bm` "drops the pending
 * and rollback ones" — plausible prose, and wrong: `-b` clears leftovers from
 * interrupted operations and `-m` clears cached rpm metadata, while `-p` and
 * `-r` are what remove deployments. A test that asserted merely that *some*
 * hint existed waved it through review and into 5.12.0, so these pin each
 * flag against its documented effect instead.
 */
describe('the rpm-ostree cleanup hint describes the flags it recommends (#2566)', () => {
  /** `rpm-ostree cleanup(1)`, flag by flag — the text has to agree with this. */
  const DOCUMENTED_EFFECT: [string, RegExp][] = [
    ['-b', /clears leftovers from interrupted rpm-ostree operations \(-b\)/],
    ['-m', /the cached rpm metadata \(-m\)/],
    ['-p', /-p \(the pending one\)/],
    ['-r', /-r \(the rollback one\)/],
  ];

  const advised = MONITORED_FILESYSTEMS.filter(f => f.remedy.includes('rpm-ostree cleanup'));

  it('is offered exactly where -bm frees something — the filesystems holding that data', () => {
    expect(advised.map(f => f.path)).toEqual(['/var', '/']);
  });

  for (const fs of advised) {
    describe(fs.path, () => {
      it('recommends -bm', () => {
        expect(fs.remedy).toContain('sudo rpm-ostree cleanup -bm');
      });

      it.each(DOCUMENTED_EFFECT)('describes %s as what it actually does', (_flag, effect) => {
        expect(fs.remedy).toMatch(effect);
      });

      it('does not claim -bm removes deployments', () => {
        // The exact false sentence that shipped, and its near neighbours.
        expect(fs.remedy).not.toMatch(/-bm`? drops/i);
        expect(fs.remedy).not.toMatch(/drops (the pending|staged deployments)/i);
        expect(fs.remedy).toMatch(/-bm does not remove deployments/);
      });
    });
  }
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
/var|/dev/nvme1n1p4 255455465472 34435706880 221019758592 14% /var
/|/dev/loop0 4194304 4194304 0 100% /
`,
      `/dev/loop0 / squashfs ro,relatime 0 0
/dev/nvme1n1p4 /var xfs rw,relatime 0 0
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

  it('leads with the unhealthy filesystem so it is not below the fold', () => {
    expect(evaluateDiskFill(FCOS_VAR_CRITICAL, 0).detail.split('\n')[0]).toContain('/var');
  });

  it('does not drag the healthy filesystems into the warning', () => {
    const result = evaluateDiskFill(FCOS_VAR_CRITICAL, 0);
    expect(result.items!.map(i => i.id)).not.toContain('/mnt/data');
    expect(result.detail).toContain('/mnt/data — 64% used');
  });

  it('judges an ordinary writable root exactly as before', () => {
    const result = evaluateDiskFill(PLAIN_ROOT_CRITICAL, 0);
    expect(result.status).toBe('fail');
    expect(result.items!.map(i => i.id)).toEqual(['/']);
    // /var is not its own filesystem there, so it is counted once, under /.
    expect(result.detail).toContain('/var is not a separate partition');
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
    expect(result.detail).toContain('/ — 14% used');
  });
});

describe('evaluateDiskFill — missing partitions', () => {
  it('counts a /var that shares the root filesystem under / instead of twice', () => {
    const result = evaluateDiskFill(PLAIN_HEALTHY, 0);
    expect(['warn', 'fail']).not.toContain(result.status);
    expect(result.detail).toContain('/var is not a separate partition');
    expect(result.detail).toContain('counted under / below');
    expect(result.items).toBeUndefined();
  });

  it('does not fold a real filesystem into a root that is only an image', () => {
    // Contrived: a filesystem whose df device string collides with the image
    // root's. Folding it under `/` would stop measuring it entirely, because
    // `/` is never judged.
    const collide = probeOutput(
      `/mnt/data|/dev/md127 1999285899264 1276953501696 722332397568 64% /var/mnt/data
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
    expect(formatBytes(655465472)).toBe('625 MiB');
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
