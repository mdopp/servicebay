/**
 * Mount-candidate enumeration for the Backup Sync "Local / USB" target
 * picker (#1613).
 *
 * Backup Sync runs inside the servicebay container, where `/mnt` block
 * devices and external USB disks aren't visible. So — like the install
 * wizard's storage detection (`api/system/storage`) — we enumerate the
 * host's block devices via the agent's `lsblk -J`, not from in-container
 * `df`. The result is a flat list of filesystem-bearing leaves the user
 * can pick as a backup target: each carries device, label, size, free
 * space, mountpoint, and whether it's currently mounted.
 *
 * Unmounted filesystems are still returned (flagged `mounted:false`) so
 * the UI can show a disabled "not mounted — mount a disk here first" row
 * instead of the user typing a path blind.
 */

import { agentManager } from '@/lib/agent/manager';
import { getDefaultNodeName } from '@/lib/nodes';
import { logger } from '@/lib/logger';

export interface MountCandidate {
  /** Block-device path, e.g. /dev/sda1 or /dev/md127. */
  device: string;
  /** Filesystem label, when present. */
  label?: string;
  /** Filesystem type, e.g. ext4 / xfs / vfat. */
  fstype?: string;
  /** Human-readable device/partition size, e.g. "3.6T". */
  size?: string;
  /** Current mountpoint, or null when not mounted. */
  mountpoint: string | null;
  /** Human-readable free space when mounted. */
  fsAvail?: string;
  /** Used-percentage string when mounted, e.g. "23%". */
  fsUsedPct?: string;
  /** True when the filesystem is currently mounted (selectable as a target). */
  mounted: boolean;
}

interface RawLsblkNode {
  name?: string;
  path?: string;
  type?: string;
  /** lsblk -b returns integers; lsblk without -b returns human strings. */
  size?: string | number;
  fstype?: string;
  label?: string;
  mountpoint?: string | null;
  /** lsblk -b returns integers; lsblk without -b returns human strings. */
  fsavail?: string | number | null;
  'fsuse%'?: string;
  children?: RawLsblkNode[];
}

const trim = (v: unknown): string | undefined => {
  if (typeof v === 'number') return isFinite(v) ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
};

const fmtBytes = (b: number): string => {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
};

// lsblk -b returns byte counts as JSON integers; without -b it returns human
// strings. Detect by sniffing whether any size leaf is a number or a bare
// decimal string (both indicate byte mode from -b or recent util-linux).
const looksLikeBytes = (nodes: RawLsblkNode[]): boolean => {
  for (const n of nodes) {
    if (typeof n.size === 'number') return true;
    if (typeof n.size === 'string' && /^\d+$/.test(n.size)) return true;
    if (n.children && looksLikeBytes(n.children)) return true;
  }
  return false;
};

const maybeHuman = (raw: string | number | null | undefined, bytes: boolean): string | undefined => {
  const v = trim(raw);
  if (!v) return undefined;
  if (bytes && /^\d+$/.test(v)) return fmtBytes(parseInt(v, 10));
  return v;
};

/**
 * Flatten `lsblk -J` JSON into the picker's mount candidates. Pure — the
 * agent round-trip lives in {@link listLocalMountCandidates}, so this is
 * unit-testable against captured lsblk output.
 *
 * A node is a candidate when it carries a filesystem type (`fstype`),
 * excluding RAID-member / LVM-member / swap pseudo-types that aren't
 * mountable as a backup target. Mounted candidates expose free space;
 * unmounted ones are still returned so the UI can disable them with a
 * "mount a disk here first" hint.
 */
export function parseMountCandidates(lsblkJson: string): MountCandidate[] {
  let parsed: { blockdevices?: RawLsblkNode[] };
  try {
    parsed = JSON.parse(lsblkJson || '{"blockdevices":[]}');
  } catch {
    return [];
  }
  const roots = Array.isArray(parsed.blockdevices) ? parsed.blockdevices : [];
  const bytes = looksLikeBytes(roots);

  // Pseudo-filesystem types that are containers for another layer, not a
  // mountable target. A real backup target is a plain filesystem.
  const NON_TARGET_FSTYPES = new Set([
    'linux_raid_member',
    'lvm2_member',
    'swap',
    'crypto_luks',
    'isw_raid_member',
  ]);

  const out: MountCandidate[] = [];
  const seen = new Set<string>();

  const walk = (node: RawLsblkNode) => {
    const name = (node.name ?? '').toString();
    const device = node.path ?? (name.startsWith('/') ? name : `/dev/${name}`);
    const fstype = trim(node.fstype);
    const mountpoint = node.mountpoint ?? null;

    // A leaf is a candidate if it holds a usable filesystem (or is already
    // mounted). Skip pseudo-member types — their child layer is the real fs.
    const isTargetable =
      (!!fstype && !NON_TARGET_FSTYPES.has(fstype.toLowerCase())) || mountpoint !== null;

    if (isTargetable && device && !seen.has(device)) {
      seen.add(device);
      out.push({
        device,
        label: trim(node.label),
        fstype,
        size: maybeHuman(node.size, bytes),
        mountpoint,
        fsAvail: mountpoint !== null ? maybeHuman(node.fsavail, bytes) : undefined,
        fsUsedPct: mountpoint !== null ? trim(node['fsuse%']) : undefined,
        mounted: mountpoint !== null,
      });
    }

    for (const child of node.children ?? []) {
      walk(child);
    }
  };

  for (const root of roots) walk(root);
  return out;
}

/**
 * Enumerate the host's filesystem mount candidates for the Backup Sync
 * Local/USB picker. Resolves the default node and queries it with the
 * same column set the install-wizard storage probe uses, falling back to
 * a leaner column set on older util-linux, then to an empty result so a
 * missing tool never crashes the picker.
 */
export async function listLocalMountCandidates(nodeName?: string): Promise<MountCandidate[]> {
  const node = nodeName ?? (await getDefaultNodeName());
  try {
    const agent = await agentManager.ensureAgent(node);
    const res = (await agent.sendCommand(
      'exec',
      {
        command:
          `lsblk -J -b -o NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,MOUNTPOINT,FSAVAIL,FSUSE% 2>/dev/null ` +
          `|| lsblk -J -o NAME,TYPE,FSTYPE,LABEL,SIZE,MOUNTPOINT 2>/dev/null ` +
          `|| echo '{"blockdevices":[]}'`,
      },
      { timeoutMs: 10_000 },
    )) as { code?: number; stdout?: string };
    return parseMountCandidates(res.stdout ?? '');
  } catch (e) {
    logger.warn('backup:mounts', `mount enumeration failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
