// Disk-import — host-side mount + enumerate (issue #1694).
//
// The backend container does NOT see the raw USB partition, so block-device
// enumeration and mounting happen HOST-side via the agent's `safe_exec` path
// (structured argv, allow-listed binaries — see SAFE_EXEC_ALLOWLIST in
// agent/v4/agent.py). This module never touches the container filesystem and
// never runs a shell string.
//
// SECURITY: the source disk is ALWAYS mounted read-only (`mount -o ro`). The
// importer reads from it and never writes back, so a half-trusted USB stick can
// never be modified by the import — and a bug here can't corrupt the source.
// Every argv this module builds is validated before it leaves the process:
// device paths must be `/dev/...` with no shell metacharacters, and the
// mountpoint must sit under a single controlled base directory.

import type { SafeExec } from './hostExec';

/** One enumerated block device / partition from `lsblk -J`. */
export interface BlockDevice {
  /** Kernel name, e.g. `sda1`. */
  name: string;
  /** Absolute device node, e.g. `/dev/sda1`. */
  path: string;
  /** Size in bytes (lsblk `-b`). */
  size: number;
  /** Filesystem type, e.g. `ext4`, `exfat`; `''` if none/unknown. */
  fstype: string;
  /** Filesystem label, if any. */
  label: string;
  /** Current mountpoint, if mounted; `null` otherwise. */
  mountpoint: string | null;
  /** True for a removable device (lsblk `RM`/`HOTPLUG`) — the USB case. */
  removable: boolean;
}

/**
 * The single controlled base directory under which the importer is allowed to
 * mount a source disk. A mountpoint MUST resolve to a direct child of this base
 * (no `..`, no nesting that escapes it) — that's the whole of the device-side
 * write surface, and it's read-only anyway.
 */
export const MOUNT_BASE = '/run/servicebay/disk-import';

/** A `/dev` node with no shell metacharacters and no path traversal. */
const DEVICE_RE = /^\/dev\/[A-Za-z0-9_-]+$/;

/** A single mountpoint segment under MOUNT_BASE — alphanumerics, `-`, `_`. */
const MOUNT_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Throw if `device` is not a safe `/dev/...` node. */
export function assertSafeDevice(device: string): void {
  if (!DEVICE_RE.test(device)) {
    throw new Error(`disk-import: refusing unsafe device path: ${JSON.stringify(device)}`);
  }
}

/**
 * Resolve a mountpoint for `device` under MOUNT_BASE and assert it can't escape
 * the base. Returns the absolute mountpoint. `name` defaults to the device's
 * basename (already validated to be metacharacter-free).
 */
export function mountpointFor(device: string, name?: string): string {
  assertSafeDevice(device);
  const seg = name ?? device.slice('/dev/'.length);
  if (!MOUNT_NAME_RE.test(seg)) {
    throw new Error(`disk-import: refusing unsafe mountpoint name: ${JSON.stringify(seg)}`);
  }
  return `${MOUNT_BASE}/${seg}`;
}

interface LsblkNode {
  name?: string;
  path?: string;
  size?: number | string;
  fstype?: string | null;
  label?: string | null;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  rm?: boolean | string;
  hotplug?: boolean | string;
  type?: string;
  children?: LsblkNode[];
}

function asBool(v: boolean | string | undefined): boolean {
  return v === true || v === '1' || v === 'true';
}

function asNumber(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Map one lsblk node to a BlockDevice (no recursion). */
function nodeToDevice(node: LsblkNode, removable: boolean): BlockDevice {
  const name = node.name ?? '';
  return {
    name,
    path: node.path ?? `/dev/${name}`,
    size: asNumber(node.size),
    fstype: node.fstype ?? '',
    label: node.label ?? '',
    mountpoint: node.mountpoint ?? node.mountpoints?.find(m => m) ?? null,
    removable,
  };
}

/** Flatten the lsblk tree into a flat list, carrying removable down to children. */
function flatten(nodes: LsblkNode[], parentRemovable: boolean, out: BlockDevice[]): void {
  for (const node of nodes) {
    const removable = parentRemovable || asBool(node.rm) || asBool(node.hotplug);
    const hasPath = Boolean(node.path ?? node.name);
    if (hasPath && node.type !== 'loop') {
      out.push(nodeToDevice(node, removable));
    }
    if (node.children?.length) flatten(node.children, removable, out);
  }
}

/**
 * Enumerate block devices via `lsblk -J -b -o ...`. Returns a flat list
 * (partitions included), each tagged with whether it's on a removable bus —
 * the disk-import UI filters to `removable` partitions with a filesystem.
 */
export async function listBlockDevices(exec: SafeExec): Promise<BlockDevice[]> {
  const { stdout, code, stderr } = await exec([
    'lsblk', '-J', '-b', '-o', 'NAME,PATH,SIZE,FSTYPE,LABEL,MOUNTPOINT,RM,HOTPLUG,TYPE',
  ]);
  if (code !== 0) {
    throw new Error(`disk-import: lsblk failed (code ${code}): ${stderr}`);
  }
  let parsed: { blockdevices?: LsblkNode[] };
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`disk-import: could not parse lsblk JSON: ${(e as Error).message}`);
  }
  const out: BlockDevice[] = [];
  flatten(parsed.blockdevices ?? [], false, out);
  return out;
}

/**
 * Mount `device` READ-ONLY at a controlled mountpoint under MOUNT_BASE and
 * return that path. Creates the mountpoint first (`mkdir -p`). The `-o ro` flag
 * is non-negotiable — there is no read-write code path here by design, so the
 * source disk is never written.
 */
export async function mountReadOnly(
  exec: SafeExec,
  device: string,
  name?: string,
): Promise<string> {
  const mountpoint = mountpointFor(device, name);
  // Privileged: /run is root-owned, and only root can mount. We pass sudo:true
  // (see hostExec.SafeExec); the agent escalates via `sudo -n`. The argv guards
  // above (assertSafeDevice / mountpointFor) are unaffected by privilege.
  await runOk(exec, ['mkdir', '-p', mountpoint], 'mkdir mountpoint', { sudo: true });
  // `-o ro` only. We never pass a caller-supplied option string — the option
  // set is a fixed literal so no `rw`/`exec`/`dev` can be smuggled in.
  await runOk(exec, ['mount', '-o', 'ro', device, mountpoint], 'mount -o ro', { sudo: true });
  return mountpoint;
}

/** Unmount a mountpoint previously returned by {@link mountReadOnly}. */
export async function unmount(exec: SafeExec, mountpoint: string): Promise<void> {
  // Only ever unmount inside our controlled base — never an arbitrary path.
  if (mountpoint !== MOUNT_BASE && !mountpoint.startsWith(`${MOUNT_BASE}/`)) {
    throw new Error(`disk-import: refusing to umount path outside ${MOUNT_BASE}: ${mountpoint}`);
  }
  // Privileged: unmounting requires root, same as mount above.
  await runOk(exec, ['umount', mountpoint], 'umount', { sudo: true });
}

/** Run a safe_exec argv and throw with context on a non-zero exit. */
async function runOk(
  exec: SafeExec,
  argv: string[],
  what: string,
  options?: { sudo?: boolean },
): Promise<void> {
  const { code, stderr } = await exec(argv, options);
  if (code !== 0) {
    throw new Error(`disk-import: ${what} failed (code ${code}): ${stderr}`);
  }
}
