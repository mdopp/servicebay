/**
 * `disk` probe (#2527, corrected by #2564 and #2567) — how full is every
 * filesystem whose exhaustion the operator can actually do something about.
 *
 * Watched and judged: **`/mnt/data`** (the array) and **`/var`** (all
 * writable system state). `/` is read and reported, but judged only where
 * the root is an ordinary writable filesystem — see the next section.
 *
 * ## Why `/boot` is deliberately NOT watched (#2567)
 *
 * #2527 added a `/boot` row with an absolute free-space threshold. It was
 * taken back out, and this note exists so it does not come back next quarter:
 *
 *   * `rpm-ostree` manages `/boot` itself. It keeps two deployments by
 *     default and prunes the oldest when it stages a new one, so a nearly
 *     full partition is the *healthy steady state* rather than a symptom.
 *     Measured on the reference box: exactly two deployments, 140.6 MiB and
 *     142.8 MiB of a 350 MiB partition — 91% used, and nothing wrong with it.
 *   * A threshold on that fires on **every healthy box** at this partition
 *     size. That is the same false-alarm class #2564 had just removed from
 *     `/` (a composefs root is 100% used by construction), and a permanently
 *     red card is how an operator learns to ignore the card.
 *   * Whether a tight `/boot` actually blocks staging an update was never
 *     established — it turns on whether rpm-ostree prunes before or after it
 *     writes, which nobody measured. A threshold resting on an unproven
 *     assumption is noise, not monitoring.
 *
 * Not overstated, on purpose: "rpm-ostree keeps `/boot` tidy" is the design,
 * not a measurement of any particular box. On the reference box `/boot` fell
 * from 55.8 to 32.6 MiB free in ~15 hours with **no OS update in between**,
 * and a tidy steady state does not shrink. That observation is recorded and
 * still open as **#2568**. If it turns out to have a real mechanism, what
 * comes back is a rule about *that* mechanism — not a percentage threshold on
 * a partition that is supposed to be full.
 *
 * ## Free space is only a signal where free space can move (#2564)
 *
 * The first cut of this probe watched `/` and judged it by free space. On an
 * ostree box that is a **false alarm by construction**: Fedora CoreOS mounts
 * `/` as a read-only composefs image whose size *is* its content
 * (`composefs / overlay ro,...`, 12.7 MiB, 0 B free, 100% used on every
 * healthy box from first boot). Nothing can be written to it and nothing can
 * be freed from it, so "1.0 GiB free or it fails" fires forever and predicts
 * failures that never happen — while the writable state it *meant* to watch
 * sits on a different filesystem entirely.
 *
 * So a filesystem is judged by free space only when free space is a resource
 * on it. The rule is structural, not a name match on "composefs" (a squashfs,
 * an EROFS image, an ISO or a loopback mount would all be misjudged the same
 * way) — see {@link isImmutableImage}:
 *
 *   > **read-only mount + zero available + used == total ⇒ an image, not a
 *   > store.** Read-only means nothing on the box can consume the space;
 *   > used == total with nothing available means there is nothing to consume
 *   > and nothing to reclaim. Both directions are dead, so the number carries
 *   > no information about the box's health.
 *
 * Both halves are load-bearing. Read-only *alone* is not enough: a mount can
 * be `ro` at this instant and still be a store — Fedora CoreOS mounts both
 * `/sysroot` and `/boot` `ro` and remounts them rw to write, so their free
 * space is a real, movable resource. Zero-free *alone* is not enough either:
 * a genuinely full writable disk also reports 0 available, and that must
 * still fail loudly.
 *
 * Read-only detection needs the mount options, which `df` does not print, so
 * the read appends `/proc/self/mounts` and rows are matched to it by
 * mountpoint (see `DISK_FILL_COMMAND`).
 *
 * ## Which filesystems, and why the thresholds are not one number
 *
 * The writable system state on an ostree box lives on **`/var`** — verified
 * on the reference box, not assumed: `/var` is `/dev/nvme1n1p4 ... rw` with
 * ~206 GiB free, and it is where container images (`/var/lib/containers`),
 * the journal (`/var/log`) and every service's data (`/mnt/data` is a symlink
 * to `/var/mnt/data`) actually land. `/etc` and `/sysroot` are the same xfs
 * filesystem, so measuring `/var` measures all of it — and unlike them `/var`
 * is the one mounted `rw` (`/sysroot` is `ro`). On a box with no separate
 * `/var` the row folds into `/`, which there is an ordinary writable root.
 *
 * A percentage tuned for a multi-terabyte array is meaningless on a small
 * partition, and an absolute floor tuned for a small partition is meaningless
 * on a 2 TB array — "warn at 80%" there would page someone about 400 GB of
 * free space. So each filesystem is measured against what it is *for*:
 *
 *   * `/var` (or `/` where the root is writable) — **absolute headroom, with
 *     a percentage backstop.** It carries the ostree repo, container images
 *     and journals; the things that fail are GB-scale, but the partition size
 *     varies enough between installs that a percentage is still worth keeping
 *     as a slow-growth signal.
 *   * `/mnt/data` — **percentage.** It is a bulk store whose whole job is to
 *     be mostly full; the operator cares about the trend, not a byte count,
 *     and nothing is bricked by it filling.
 *
 * Detection is a plain `df` read (see `DISK_FILL_COMMAND`). The parse and the
 * verdict are pure functions so every shape — near-full, healthy, an image
 * root, and a partition that isn't there — is unit-testable without a host.
 * **This probe only reports; it never frees space** beyond the one read-only
 * `du` behind `/mnt/data`'s fix button — the same call the `raid` probe makes.
 */

import type { ProbeItem } from '../actions';

export const PROBE_ID = 'disk';
export const PROBE_LABEL = 'Storage (/mnt/data, /var, /)';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

type DiskProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

/** Separates the `df` rows from the mount table in the probe's output. */
export const DISK_FILL_MOUNTS_MARKER = '---mounts---';

/**
 * One `df` invocation per watched path, each line prefixed with the path we
 * asked about, then the kernel's mount table.
 *
 * The prefix is what makes a *missing* partition legible: `df` writes its
 * complaint to stderr and prints no row, so the line comes back as a bare
 * `"/mnt/data|"` rather than silently vanishing into a shorter list. `-P`
 * pins the POSIX one-line-per-filesystem layout and `-B1` gives exact bytes,
 * so the GiB floors on `/var` are compared against a real number rather than
 * one `-h` already rounded.
 *
 * `/boot` is deliberately absent from this list (#2567) — see the module
 * header: rpm-ostree keeps it near-full by design, so there is nothing here
 * to judge.
 *
 * `/proc/self/mounts` is appended because `df` does not print mount options,
 * and read-only is half of the "is this an image or a store?" test (#2564).
 * It is a kernel file, always present on Linux, and costs one `cat`.
 */
export const DISK_FILL_COMMAND =
  'for p in /mnt/data /var /; do echo "$p|$(df -P -B1 "$p" 2>/dev/null | tail -1)"; done; ' +
  `echo "${DISK_FILL_MOUNTS_MARKER}"; cat /proc/self/mounts 2>/dev/null`;

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
  // NOTE: there is deliberately no `/boot` entry (#2567). rpm-ostree keeps
  // two deployments on a ~350 MiB partition, so near-full IS the healthy
  // state and any threshold here fires on every box — see the module header,
  // including the still-open #2568 observation that keeps this honest.
  {
    path: '/var',
    purpose:
      'the writable system state — container images, the ostree repo, system logs and service data',
    // THIS is the filesystem the previous `/` entry was reaching for (#2564).
    // Absolute floor first, percentage as a backstop. What fills it is
    // GB-scale (a container image pull, a staged ostree deployment, journald),
    // so the floor is expressed in GiB:
    //   warn  < 5 GiB free — an ostree deployment plus an image pull no longer
    //     comfortably fit; still plenty of time to act.
    //   fail  < 1 GiB free — podman pulls, journald writes and OS updates all
    //     start failing at around this point.
    // The 90% backstop catches slow growth on a small disk, where 5 GiB free
    // would still be a large share of it.
    warnFreeBytes: 5 * GiB,
    failFreeBytes: 1 * GiB,
    warnUsedPct: 90,
    consequence:
      'Container image pulls, system logs and OS updates all fail once the writable filesystem fills.',
    remedy:
      'Reclaim it from a shell on the box: `podman image prune -a` drops unused images, `journalctl --vacuum-size=200M` trims logs, and `sudo rpm-ostree cleanup -bm` clears leftovers from interrupted rpm-ostree operations (-b) and the cached rpm metadata (-m), both of which live here. Note that -bm does not remove deployments — that is -p (the pending one) and -r (the rollback one), and what those free is /boot, not this filesystem.',
    actionIds: [],
    // /var exists on every Linux box; when it is not its own filesystem the
    // row folds into `/` below instead of landing here.
    absentStatus: 'info',
    absentDetail: 'Could not read /var, so the writable filesystem\'s fill level is unknown.',
  },
  {
    path: '/',
    purpose: 'the OS root',
    // Same numbers as /var, and for the same reason: on a box whose root is
    // an ordinary writable filesystem, this row IS the writable state (/var
    // folds into it). On an ostree box the root is a read-only image and is
    // reported but never judged — see isImmutableImage.
    warnFreeBytes: 5 * GiB,
    failFreeBytes: 1 * GiB,
    warnUsedPct: 90,
    consequence:
      'Container image pulls, system logs and OS updates all fail once the root filesystem fills.',
    remedy:
      'Reclaim it from a shell on the box: `podman image prune -a` drops unused images, `journalctl --vacuum-size=200M` trims logs, and `sudo rpm-ostree cleanup -bm` clears leftovers from interrupted rpm-ostree operations (-b) and the cached rpm metadata (-m), both of which live here. Note that -bm does not remove deployments — that is -p (the pending one) and -r (the rollback one), and what those free is /boot, not this filesystem.',
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
  /** Filesystem type from the mount table (`xfs`, `overlay`, …); '' if the
   *  mount table could not be read. */
  fstype: string;
  /** Mounted `ro`, per the mount table. Half of the image-vs-store test. */
  readOnly: boolean;
}

/** What the mount table says about one mountpoint. */
interface MountInfo {
  fstype: string;
  readOnly: boolean;
}

/** The kernel's mount table escapes these four characters in path fields. */
function unescapeMountPath(value: string): string {
  return value
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

/**
 * `<device> <mountpoint> <fstype> <options> <dump> <pass>` per line. Keyed by
 * mountpoint with **last one winning**, which is what the kernel does: a
 * later mount over the same point shadows the earlier one, and `df` reports
 * the shadowing mount.
 */
export function parseMountTable(raw: string): Map<string, MountInfo> {
  const mounts = new Map<string, MountInfo>();
  for (const line of (raw ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    mounts.set(unescapeMountPath(fields[1]), {
      fstype: fields[2],
      readOnly: fields[3].split(',').includes('ro'),
    });
  }
  return mounts;
}

/**
 * An **image, not a store**: free space on it is not a resource, so judging
 * it by free space says nothing about the box (#2564).
 *
 * Read-only means nothing on the box can consume the space; `used == total`
 * with nothing available means there is nothing to consume and nothing to
 * reclaim. Both conditions are required, and each rules out a case the other
 * would get wrong:
 *
 *   * read-only alone would excuse a mount that is `ro` right now but is
 *     still a store — Fedora CoreOS mounts `/sysroot` and `/boot` `ro` and
 *     remounts them rw to write, and both have real, movable slack;
 *   * zero-free alone would excuse a genuinely full writable disk, which must
 *     keep failing loudly.
 *
 * This is deliberately a structural test rather than a match on "composefs":
 * a squashfs, an EROFS image, an ISO or a read-only loopback mount are all
 * the same shape and would all be misjudged the same way.
 */
export function isImmutableImage(row: DfRow): boolean {
  return row.present && row.readOnly && row.freeBytes === 0 && row.usedBytes >= row.totalBytes;
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
  const [dfSection = '', mountSection = ''] = (raw ?? '').split(DISK_FILL_MOUNTS_MARKER);
  const mounts = parseMountTable(mountSection);
  const rows: DfRow[] = [];
  for (const line of dfSection.split('\n')) {
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
      fstype: '',
      readOnly: false,
    };
    const m = DF_ROW.exec(trimmed.slice(sep + 1).trim());
    if (!m) {
      rows.push(absent);
      continue;
    }
    const mountpoint = m[6].trim();
    // No mount-table entry (unreadable /proc, or a shape we did not parse) →
    // treated as a writable store, i.e. judged. Failing to judge is the worse
    // error: that is the regression #2564 fixed.
    const mount = mounts.get(mountpoint);
    rows.push({
      path,
      present: true,
      device: m[1],
      totalBytes: Number.parseInt(m[2], 10),
      usedBytes: Number.parseInt(m[3], 10),
      freeBytes: Number.parseInt(m[4], 10),
      usedPct: Number.parseInt(m[5], 10),
      mountpoint,
      fstype: mount?.fstype ?? '',
      readOnly: mount?.readOnly ?? false,
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

interface DiskFilesystemVerdict {
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

  // An image is reported, never judged — and `ok`, not `info`, because this
  // is the *healthy* state of an ostree root: it is 100% used by construction
  // on every box from first boot, and a permanently non-green card is the
  // same "train the operator to ignore it" failure in a quieter colour.
  if (isImmutableImage(row)) {
    const kind = [row.device, row.fstype].filter(Boolean).join(', ');
    return {
      spec,
      row,
      status: 'ok',
      detail:
        `${spec.path} — a read-only image of ${formatBytes(row.totalBytes)}, 100% used by ` +
        `construction (${kind}). Nothing can be written to it and nothing can be freed from ` +
        `it, so free space here is not a measure of anything.`,
    };
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
  // Only fold a path into `/` when `/` is itself judged. On an ostree box the
  // root is an image, so folding a real filesystem into it would silently
  // stop measuring it (#2564).
  const rootRow = byPath.get('/');
  const rootDevice = rootRow?.present && !isImmutableImage(rootRow) ? rootRow.device : undefined;

  const verdicts = MONITORED_FILESYSTEMS.map(spec => {
    const row = byPath.get(spec.path);
    // A path that is not its own partition lives on the root filesystem, so
    // the root's thresholds are the ones that apply to it — and counting it
    // twice would report one filling disk as two separate problems. Report it
    // as covered and evaluate it once, under `/`.
    if (spec.path !== '/' && row?.present && rootDevice && row.device === rootDevice) {
      return {
        spec,
        row,
        // `ok`, not `info`: the path is covered, just measured once under `/`.
        status: 'ok' as DiskProbeStatus,
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
