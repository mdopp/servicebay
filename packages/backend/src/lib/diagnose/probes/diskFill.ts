/**
 * `disk` probe (#2527) — how full is every filesystem the box actually
 * depends on, not just the data array.
 *
 * Until now this probe read `df -h /mnt/data` and nothing else, so the two
 * filesystems whose exhaustion is *unrecoverable* were unwatched. `/boot`
 * filled to 91% (~33 MB free) on a live CoreOS box and nothing said a word:
 * a `/boot` too full to stage the next kernel leaves `rpm-ostree upgrade`
 * failing, and a failure partway through leaves the box without a bootable
 * entry. `/mnt/data` running out costs you writes; `/boot` running out can
 * cost you the box.
 *
 * ## Why the thresholds are not one number
 *
 * A percentage tuned for a multi-terabyte array is meaningless on a
 * fingernail-sized partition. On the reference box `/boot` is a **350 MiB**
 * usable ext4 partition (Fedora CoreOS lays down 384 MiB), so 91% there is
 * ~33-56 MiB — **less than a single kernel image**. "Warn at 90%" would have
 * fired only once the box was already past saving, while "warn at 80%" on a
 * 2 TB `/mnt/data` would page someone about 400 GB of free space.
 *
 * So each filesystem is measured against what it is *for*:
 *
 *   * `/boot` — **absolute headroom only.** What matters is whether one more
 *     kernel + initramfs pair fits, and that cost is a fixed ~100-150 MiB
 *     regardless of how big the partition is.
 *   * `/` — **absolute headroom, with a percentage backstop.** It carries the
 *     ostree repo, container images and journals; the things that fail are
 *     GB-scale, but the root partition size varies enough between installs
 *     that a percentage is still worth keeping as a slow-growth signal.
 *   * `/mnt/data` — **percentage.** It is a bulk store whose whole job is to
 *     be mostly full; the operator cares about the trend, not a byte count,
 *     and nothing is bricked by it filling.
 *
 * Detection is a plain `df` read (see `DISK_FILL_COMMAND`). The parse and the
 * verdict are pure functions so every shape — near-full, healthy, and a
 * partition that isn't there — is unit-testable without a host. **This probe
 * only reports; it never frees space.** Reclaiming `/boot` means deleting
 * kernels (`rpm-ostree cleanup -bm`), which is an operator decision, so the
 * rows here carry no one-click fix — the same call the `raid` probe makes.
 */

import type { ProbeItem } from '../actions';

export const PROBE_ID = 'disk';
export const PROBE_LABEL = 'Storage (/mnt/data, /boot, /)';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export type DiskProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

/**
 * One `df` invocation per watched path, each line prefixed with the path we
 * asked about. The prefix is what makes a *missing* partition legible: `df`
 * writes its complaint to stderr and prints no row, so the line comes back
 * as a bare `"/boot|"` rather than silently vanishing into a shorter list.
 * `-P` pins the POSIX one-line-per-filesystem layout and `-B1` gives exact
 * bytes, because the whole point on `/boot` is an absolute number that `-h`
 * would have already rounded away.
 */
export const DISK_FILL_COMMAND =
  'for p in /mnt/data /boot /; do echo "$p|$(df -P -B1 "$p" 2>/dev/null | tail -1)"; done';

/** What we watch, why, and the numbers — with the reasoning attached. */
export interface MonitoredFilesystem {
  /** Path handed to `df`. */
  path: string;
  /** One line: what lives here, for the operator who has never seen it. */
  purpose: string;
  /** Warn below this many free bytes; null = free space is not the signal. */
  warnFreeBytes: number | null;
  /** Fail below this many free bytes; null = no failing band. */
  failFreeBytes: number | null;
  /** Warn at or above this fill percentage; null = percentage is not the signal. */
  warnUsedPct: number | null;
  /** What actually breaks — stated as a consequence, not a metric. */
  consequence: string;
  /** What the operator does about it. */
  remedy: string;
  /** Probe actions offered on the row. Empty = deliberately read-only. */
  actionIds: string[];
  /** Status when the path is not a filesystem on this box at all. */
  absentStatus: DiskProbeStatus;
  /** Detail for that case. */
  absentDetail: string;
}

export const MONITORED_FILESYSTEMS: MonitoredFilesystem[] = [
  {
    path: '/mnt/data',
    purpose: 'the data array — every service\'s persistent data and the local backups',
    // Percentage, not bytes: this array is terabytes and is *meant* to run
    // mostly full, so an absolute floor would either never fire or fire
    // constantly depending on the box. 90% is the long-standing threshold
    // and is left untouched — the point of this change is to add coverage,
    // not to make the one filesystem that was already watched noisier.
    warnFreeBytes: null,
    failFreeBytes: null,
    warnUsedPct: 90,
    consequence: 'Services will start failing writes, and backups will stop completing, once it fills.',
    remedy:
      'Click "Show largest directories" below to find what to clean, or add a disk and extend the array.',
    // The only row with a fix button: `du` is read-only and the cleanup that
    // follows is ordinary file deletion the operator already does here.
    actionIds: ['show_largest_dirs'],
    absentStatus: 'warn',
    absentDetail:
      '/mnt/data is not mounted — first-boot RAID setup may still be running, or the array failed to assemble.',
  },
  {
    path: '/boot',
    purpose: 'the kernels and initramfs images the box boots from',
    // ABSOLUTE ONLY, and small. Fedora CoreOS gives /boot a 384 MiB partition
    // (~350 MiB usable) and keeps two deployments on it, so the numbers here
    // are in the tens of megabytes and a percentage says nothing useful:
    // the reference box sat at 91% with 56 MiB free, which is not "a bit
    // tight", it is less than one kernel image.
    //
    // The unit that matters is a single deployment's boot payload — a vmlinuz
    // (~15 MiB) plus its initramfs (~100-140 MiB), so call it ~150 MiB. That
    // is the amount `rpm-ostree` must be able to write before it can stage
    // the next update.
    //
    //   warn  < 128 MiB free — under roughly one kernel image. The next
    //     update has no room to stage, but the box is still running fine and
    //     the operator has time to reclaim space. This is deliberately the
    //     *early* warning: it has to arrive while acting is still possible,
    //     because by the time an update fails it is too late to have been
    //     warned about it.
    //   fail  < 64 MiB free — under half a kernel image. `rpm-ostree upgrade`
    //     cannot write a new boot entry from here, and an update that dies
    //     partway through is how a box ends up unbootable.
    warnFreeBytes: 128 * MiB,
    failFreeBytes: 64 * MiB,
    warnUsedPct: null,
    consequence:
      'There is not enough room to stage the next kernel, so the next OS update will fail — and an update that fails partway through can leave the box unable to boot.',
    remedy:
      'Reclaim /boot from a shell on the box: `rpm-ostree status` shows the retained deployments, `sudo rpm-ostree cleanup -bm` drops the pending and rollback ones, and any kernel left behind by a past failed update has to go too. ServiceBay will not delete kernels for you — getting that wrong is what makes a box unbootable.',
    // Read-only on purpose: the fix deletes boot entries.
    actionIds: [],
    absentStatus: 'info',
    absentDetail: '/boot is not a separate partition on this box, so there is nothing to run out.',
  },
  {
    path: '/',
    purpose: 'the OS root — the ostree repo, container images, and system logs',
    // Absolute floor first, percentage as a backstop. What fills / is
    // GB-scale (a container image pull, a staged ostree deployment, journald),
    // so the floor is expressed in GiB:
    //   warn  < 5 GiB free — an ostree deployment plus an image pull no longer
    //     comfortably fit; still plenty of time to act.
    //   fail  < 1 GiB free — podman pulls, journald writes and OS updates all
    //     start failing at around this point.
    // The 90% backstop catches slow growth on a small root, where 5 GiB free
    // would still be a large share of the disk.
    warnFreeBytes: 5 * GiB,
    failFreeBytes: 1 * GiB,
    warnUsedPct: 90,
    consequence:
      'Container image pulls, system logs and OS updates all fail once the root filesystem fills.',
    remedy:
      'Reclaim it from a shell on the box: `podman image prune -a` drops unused images, `journalctl --vacuum-size=200M` trims logs, and `sudo rpm-ostree cleanup -bm` drops staged deployments.',
    actionIds: [],
    // `/` always exists; an absent row here means the read itself failed.
    absentStatus: 'info',
    absentDetail: 'Could not read the root filesystem, so its fill level is unknown.',
  },
];

/** One filesystem as `df` reported it (or the fact that it did not). */
export interface DfRow {
  /** The path we asked `df` about — not necessarily the mountpoint. */
  path: string;
  /** False when `df` returned no row for this path. */
  present: boolean;
  /** The `Filesystem` column, e.g. `/dev/nvme1n1p3`. */
  device: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
  /** The `Mounted on` column — differs from `path` when the path is a
   *  symlink (`/mnt/data` → `/var/mnt/data` on CoreOS) or not its own
   *  filesystem at all. */
  mountpoint: string;
}

/** `<device> <total> <used> <avail> <pct>% <mountpoint>` — the `df -P` row. */
const DF_ROW = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/;

/**
 * Parse the `path|<df row>` lines produced by {@link DISK_FILL_COMMAND}.
 * Tolerant by design — an unparseable line becomes `present: false` rather
 * than throwing, because a parse hiccup must never take down the whole
 * diagnose run (same call as the `raid` probe).
 */
export function parseDiskFill(raw: string): DfRow[] {
  const rows: DfRow[] = [];
  for (const line of (raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('|');
    if (sep === -1) continue;
    const path = trimmed.slice(0, sep).trim();
    if (!path) continue;
    const absent: DfRow = {
      path,
      present: false,
      device: '',
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usedPct: 0,
      mountpoint: '',
    };
    const m = DF_ROW.exec(trimmed.slice(sep + 1).trim());
    if (!m) {
      rows.push(absent);
      continue;
    }
    rows.push({
      path,
      present: true,
      device: m[1],
      totalBytes: Number.parseInt(m[2], 10),
      usedBytes: Number.parseInt(m[3], 10),
      freeBytes: Number.parseInt(m[4], 10),
      usedPct: Number.parseInt(m[5], 10),
      mountpoint: m[6].trim(),
    });
  }
  return rows;
}

/** Sizes an operator reads at a glance; binary units, matching `df -h`. */
export function formatBytes(bytes: number): string {
  const units: [number, string][] = [
    [1024 * GiB, 'TiB'],
    [GiB, 'GiB'],
    [MiB, 'MiB'],
    [1024, 'KiB'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} B`;
}

export interface DiskFilesystemVerdict {
  spec: MonitoredFilesystem;
  row: DfRow | null;
  status: DiskProbeStatus;
  detail: string;
}

const SEVERITY: Record<DiskProbeStatus, number> = { ok: 0, info: 1, warn: 2, fail: 3 };

function worst(a: DiskProbeStatus, b: DiskProbeStatus): DiskProbeStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function verdictFor(spec: MonitoredFilesystem, row: DfRow | undefined): DiskFilesystemVerdict {
  if (!row || !row.present) {
    return { spec, row: null, status: spec.absentStatus, detail: spec.absentDetail };
  }

  const numbers =
    `${spec.path} — ${row.usedPct}% used, ${formatBytes(row.freeBytes)} free of ` +
    `${formatBytes(row.totalBytes)} (${row.device})`;

  let status: DiskProbeStatus = 'ok';
  const reasons: string[] = [];
  if (spec.failFreeBytes !== null && row.freeBytes < spec.failFreeBytes) {
    status = 'fail';
    reasons.push(`below the ${formatBytes(spec.failFreeBytes)} floor`);
  } else if (spec.warnFreeBytes !== null && row.freeBytes < spec.warnFreeBytes) {
    status = 'warn';
    reasons.push(`below the ${formatBytes(spec.warnFreeBytes)} headroom this filesystem needs`);
  }
  if (spec.warnUsedPct !== null && row.usedPct >= spec.warnUsedPct) {
    status = worst(status, 'warn');
    reasons.push(`at or above ${spec.warnUsedPct}% full`);
  }

  if (status === 'ok') return { spec, row, status, detail: `${numbers}.` };
  return { spec, row, status, detail: `${numbers} — ${reasons.join(' and ')}. ${spec.consequence}` };
}

export interface DiskFillResult {
  status: DiskProbeStatus;
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

/**
 * Pure verdict over the raw {@link DISK_FILL_COMMAND} output. `execCode` is
 * the exit code of the read itself, so an agent that could not run `df` is
 * reported honestly rather than read as "every filesystem is empty".
 */
export function evaluateDiskFill(raw: string, execCode: number | undefined): DiskFillResult {
  if (execCode !== 0) {
    return { status: 'info', detail: 'Could not read disk usage, so fill levels are unknown.' };
  }

  const rows = parseDiskFill(raw);
  if (rows.length === 0) {
    return { status: 'info', detail: 'No df output — disk fill levels are unknown.' };
  }

  const byPath = new Map(rows.map(r => [r.path, r]));
  const rootDevice = byPath.get('/')?.device;

  const verdicts = MONITORED_FILESYSTEMS.map(spec => {
    const row = byPath.get(spec.path);
    // A path that is not its own partition lives on the root filesystem, so
    // the root's thresholds are the ones that apply to it — measuring a
    // 350 MiB-sized `/boot` rule against a 250 GB root would either never
    // fire or fire on a box that is perfectly healthy. Report it as covered
    // and evaluate it once, under `/`.
    if (spec.path !== '/' && row?.present && rootDevice && row.device === rootDevice) {
      return {
        spec,
        row,
        status: 'info' as DiskProbeStatus,
        detail: `${spec.path} is not a separate partition — it lives on the root filesystem, counted under / below.`,
      };
    }
    return verdictFor(spec, row);
  });

  const overall = verdicts.reduce<DiskProbeStatus>((acc, v) => worst(acc, v.status), 'ok');
  const unhealthy = verdicts.filter(v => v.status === 'warn' || v.status === 'fail');

  if (unhealthy.length === 0) {
    return { status: overall, detail: verdicts.map(v => v.detail).join('\n') };
  }

  return {
    status: overall,
    // Lead with what needs attention; a healthy sibling filesystem must not
    // push the problem below the fold.
    detail: [...unhealthy, ...verdicts.filter(v => !unhealthy.includes(v))]
      .map(v => v.detail)
      .join('\n'),
    hint: unhealthy.map(v => `${v.spec.path}: ${v.spec.remedy}`).join('\n'),
    items: unhealthy.map(v => ({
      id: v.spec.path,
      label: `${v.spec.path} — ${v.spec.purpose}`,
      detail: v.detail,
      status: v.status === 'fail' ? ('fail' as const) : ('warn' as const),
      actionIds: v.spec.actionIds,
    })),
  };
}
