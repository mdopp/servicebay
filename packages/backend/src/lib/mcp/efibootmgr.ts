/**
 * Pure parsing + readiness assessment for `efibootmgr -v` output (#1236).
 *
 * Extracted from the inline parsing in the `set_boot_next_usb` MCP tool so
 * both that tool's `list` action and the new `verify_usb_boot` readiness
 * check share one implementation — and so the (fiddly) parsing is unit
 * testable without an agent or a real UEFI box.
 */

export interface EfiBootEntry {
  bootNum: string;
  name: string;
  active: boolean;
  description: string;
  current: boolean;
}

export interface ParsedEfibootmgr {
  entries: EfiBootEntry[];
  candidates: EfiBootEntry[];
  bootNext: string | null;
  bootCurrent: string | null;
  bootOrder: string[];
}

/** A boot entry that looks like it boots from removable/USB media. */
export function isUsbBootEntry(description: string): boolean {
  const d = description.toLowerCase();
  return d.includes('usb') ||
    d.includes('removable') ||
    d.includes('disk') ||
    description.includes('\\EFI\\boot\\');
}

/** Tighter than `isUsbBootEntry` — removable media only, excluding the
 *  broad `disk`/`\EFI\boot\` heuristics — used for the reinstall-ready
 *  verdict so an internal disk entry doesn't read as "USB ready". */
export function isRemovableBootEntry(description: string): boolean {
  const d = description.toLowerCase();
  return d.includes('usb') || d.includes('removable');
}

export function parseEfibootmgr(stdout: string): ParsedEfibootmgr {
  const entries: EfiBootEntry[] = [];
  let bootNext: string | null = null;
  let bootCurrent: string | null = null;
  let bootOrder: string[] = [];

  for (const line of stdout.split('\n')) {
    if (line.startsWith('BootNext:')) {
      bootNext = line.replace('BootNext:', '').trim();
    } else if (line.startsWith('BootCurrent:')) {
      bootCurrent = line.replace('BootCurrent:', '').trim();
    } else if (line.startsWith('BootOrder:')) {
      bootOrder = line.replace('BootOrder:', '').trim().split(',').filter(Boolean);
    } else if (line.startsWith('Boot')) {
      const match = line.match(/^Boot([0-9A-Fa-f]+)(\*?)\s+(.+)$/);
      if (match) {
        const [, num, star, description] = match;
        entries.push({
          bootNum: num,
          name: description.split('\t')[0] || description,
          active: star === '*',
          description,
          current: bootCurrent === num,
        });
      }
    }
  }

  // `current` is resolved against bootCurrent, which may appear after the
  // Boot#### lines — re-stamp once we've seen the whole table.
  for (const e of entries) e.current = bootCurrent === e.bootNum;

  const candidates = entries.filter(e => isUsbBootEntry(e.description));
  return { entries, candidates, bootNext, bootCurrent, bootOrder };
}

export interface UsbBootReadiness {
  reinstallReady: boolean;
  activeUsbEntries: EfiBootEntry[];
  usbCandidates: EfiBootEntry[];
  hint?: string;
}

// ---------------------------------------------------------------------------
// #1674 — map the USB boot to the ACTUAL FCoS installer device.
//
// On a multi-slot card reader the firmware exposes one removable UEFI entry per
// (possibly empty) slot. The old auto-detect picked the FIRST removable/USB-ish
// entry, which on the operator's box was an EMPTY card-reader slot (Boot0000),
// not the real installer device — so BootNext armed a slot with no media and the
// box just booted the existing disk again. The reliable signal is the BLOCK
// DEVICE: the installer USB carries the Fedora CoreOS labels (`fedora-coreos`
// and an `EFI-SYSTEM` EFI partition). Find that device, then boot it directly
// via `\EFI\BOOT\BOOTX64.EFI` rather than trusting a slot description.

/** A block node from `lsblk --json -O` (subset of the fields we use). */
export interface LsblkNode {
  name: string;
  path?: string;
  type?: string; // disk | part | rom | …
  label?: string | null;
  partlabel?: string | null;
  parttypename?: string | null;
  pkname?: string | null; // parent kernel name (the disk a partition lives on)
  children?: LsblkNode[];
}

export interface InstallerBootDevice {
  /** The whole disk, e.g. /dev/sdb. */
  disk: string;
  /** The EFI System partition number on that disk, e.g. 2 (for -p). */
  efiPartNum: number;
  /** The EFI partition device, e.g. /dev/sdb2. */
  efiPart: string;
  /** Why this device was chosen (which label matched), for the operator log. */
  reason: string;
}

/** A partition looks like the installer's EFI System Partition. */
function isEfiSystemPart(n: LsblkNode): boolean {
  const label = (n.label ?? '').toUpperCase();
  const ptype = (n.parttypename ?? '').toLowerCase();
  const plabel = (n.partlabel ?? '').toLowerCase();
  return label === 'EFI-SYSTEM' || label === 'EFI' || ptype.includes('efi system') || plabel.includes('efi');
}

/** Any node on this device tree carries a fedora-coreos label. */
function carriesFcosLabel(n: LsblkNode): boolean {
  const fields = [n.label, n.partlabel].map(s => (s ?? '').toLowerCase());
  return fields.some(f => f.includes('fedora-coreos') || f.includes('coreos') || f === 'efi-system');
}

function partNumFromName(name: string): number {
  const m = name.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function devPath(n: LsblkNode): string {
  return n.path ?? `/dev/${n.name}`;
}

/**
 * Find the real FCoS installer device from `lsblk --json -O` output: the disk
 * that carries the fedora-coreos / EFI-SYSTEM labels, plus its EFI System
 * Partition number (for `efibootmgr -d <disk> -p <num>`). Returns null when no
 * such device is present (no installer media inserted) — the caller then falls
 * back to the UEFI-entry heuristic and warns.
 */
export function selectInstallerBootDevice(lsblkJson: string): InstallerBootDevice | null {
  let parsed: { blockdevices?: LsblkNode[] };
  try {
    parsed = JSON.parse(lsblkJson) as { blockdevices?: LsblkNode[] };
  } catch {
    return null;
  }
  for (const disk of parsed.blockdevices ?? []) {
    if (disk.type && disk.type !== 'disk') continue;
    const children = disk.children ?? [];
    // The disk qualifies as the installer only if SOMETHING on it carries a
    // fedora-coreos label — so we don't grab an unrelated USB stick.
    const isInstaller = carriesFcosLabel(disk) || children.some(carriesFcosLabel);
    if (!isInstaller) continue;
    const efi = children.find(isEfiSystemPart);
    if (!efi) continue;
    return {
      disk: devPath(disk),
      efiPartNum: partNumFromName(efi.name),
      efiPart: devPath(efi),
      reason: `block device ${devPath(disk)} carries the Fedora CoreOS / EFI-SYSTEM label`,
    };
  }
  return null;
}

/**
 * The chosen boot target after #1674 mapping: either a direct device entry to
 * create (`create`), or a fallback to an existing UEFI entry number
 * (`existingEntry`). `warning` is set when the fallback landed on something that
 * looks like an empty card-reader slot, so the operator is told the auto-detect
 * is unreliable here and to insert the installer / pick the device explicitly.
 */
export interface UsbBootPlan {
  mode: 'create' | 'existingEntry' | 'none';
  device?: InstallerBootDevice;
  bootNum?: string;
  warning?: string;
}

/**
 * Decide how to arm the next USB boot. Prefers the real installer device (a
 * fresh `efibootmgr -c` entry straight to `\EFI\BOOT\BOOTX64.EFI`); only falls
 * back to picking an existing UEFI candidate entry when no installer block
 * device is found — and WARNS when that fallback entry is an inactive / empty
 * removable slot (the #1674 trap), since arming it won't boot anything.
 */
export function planUsbBoot(
  parsed: ParsedEfibootmgr,
  device: InstallerBootDevice | null,
): UsbBootPlan {
  if (device) {
    return { mode: 'create', device };
  }
  // No installer device located — fall back to the old UEFI-entry heuristic, but
  // surface that it's a guess. Prefer an ACTIVE removable entry; an inactive one
  // is very likely an empty slot.
  const removable = parsed.entries.filter(e => isUsbBootEntry(e.description));
  const active = removable.find(e => e.active);
  if (active) {
    return { mode: 'existingEntry', bootNum: active.bootNum };
  }
  if (removable.length > 0) {
    const nums = removable.map(e => e.bootNum).join(', ');
    return {
      mode: 'existingEntry',
      bootNum: removable[0].bootNum,
      warning:
        `No Fedora CoreOS installer block device was found, and the only removable UEFI entries (Boot${nums}) are inactive — ` +
        `this is usually an EMPTY card-reader slot, not the installer. Insert the install USB and retry, or pass an explicit bootNum.`,
    };
  }
  return {
    mode: 'none',
    warning:
      'No Fedora CoreOS installer device and no removable UEFI boot entry were found. ' +
      'Insert the install USB (the firmware only lists removable entries when media is present) and retry.',
  };
}

/**
 * Decide whether the firmware can actually boot from USB for a reinstall.
 * Ready means: at least one removable/USB UEFI entry exists AND is active
 * (the `*` flag) — an inactive entry won't be booted.
 */
export function assessUsbBootReadiness(parsed: ParsedEfibootmgr): UsbBootReadiness {
  const usbCandidates = parsed.entries.filter(e => isRemovableBootEntry(e.description));
  const activeUsbEntries = usbCandidates.filter(e => e.active);
  const reinstallReady = activeUsbEntries.length > 0;

  let hint: string | undefined;
  if (usbCandidates.length === 0) {
    hint = 'No USB/removable UEFI boot entry found. Insert the installation USB and re-check; the firmware only lists removable entries when media is present.';
  } else if (!reinstallReady) {
    const nums = usbCandidates.map(e => e.bootNum).join(', ');
    hint = `A USB boot entry exists (Boot${nums}) but is inactive. Activate it with \`efibootmgr -a -b <num>\` before relying on a reinstall, or use set_boot_next_usb which activates + sets BootNext.`;
  }

  return { reinstallReady, activeUsbEntries, usbCandidates, hint };
}
