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
