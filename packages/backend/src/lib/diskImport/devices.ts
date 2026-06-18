// Disk-import — removable-device enumeration (#1953, slice of #1949).
//
// The control plane still owns DEVICE ENUMERATION (a thin host-side `lsblk`
// read), because the worker container can't see the raw USB bus — servicebay
// picks the partition, mounts it read-only, and bind-mounts that into the worker
// (launcher.ts). This is NOT the heavy path; it's a few-line listing the tile
// shows in its device picker.

import { listBlockDevices, type BlockDevice, type SafeExec } from '@servicebay/disk-import-worker';
import type { ImportDevice } from './launcher';

/** Human-friendly picker label (`SANDISK (28.7 GB, exfat)`). */
function describeDevice(d: BlockDevice): string {
  const name = d.label || d.name;
  return `${name} (${formatBytes(d.size)}, ${d.fstype})`;
}

/**
 * Enumerate removable partitions that carry a filesystem — the only things the
 * tile offers as an import source (a whole-disk node or a bare partition with no
 * fstype isn't importable).
 */
export async function listImportDevices(exec: SafeExec): Promise<ImportDevice[]> {
  const devices = await listBlockDevices(exec);
  return devices
    .filter(d => d.removable && d.fstype !== '')
    .map(d => ({ path: d.path, display: describeDevice(d) }));
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
