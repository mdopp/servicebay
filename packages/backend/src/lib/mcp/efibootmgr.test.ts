import { describe, it, expect } from 'vitest';
import {
  parseEfibootmgr,
  assessUsbBootReadiness,
  selectInstallerBootDevice,
  planUsbBoot,
} from './efibootmgr';

// Representative `efibootmgr -v` output: an OS entry, an active USB entry,
// and an inactive removable entry. BootCurrent appears after the Boot#### rows.
const WITH_ACTIVE_USB = `BootNext: 0003
BootOrder: 0000,0003
Boot0000* Fedora\tHD(1,GPT,abc)/File(\\EFI\\fedora\\shimx64.efi)
Boot0003* USB Device\tPciRoot(0x0)/Pci(0x14,0x0)/USB(0,0)
BootCurrent: 0000`;

const INACTIVE_USB = `BootOrder: 0000
Boot0000* Fedora\tHD(1,GPT,abc)/File(\\EFI\\fedora\\shimx64.efi)
Boot0007  Removable Media\tPciRoot(0x0)/USB(1,0)
BootCurrent: 0000`;

const NO_USB = `BootOrder: 0000
Boot0000* Fedora\tHD(1,GPT,abc)/File(\\EFI\\fedora\\shimx64.efi)
BootCurrent: 0000`;

describe('parseEfibootmgr', () => {
  it('parses entries, BootNext/Current/Order and stamps `current`', () => {
    const p = parseEfibootmgr(WITH_ACTIVE_USB);
    expect(p.bootNext).toBe('0003');
    expect(p.bootCurrent).toBe('0000');
    expect(p.bootOrder).toEqual(['0000', '0003']);
    expect(p.entries).toHaveLength(2);
    expect(p.entries.find(e => e.bootNum === '0000')?.current).toBe(true);
    expect(p.entries.find(e => e.bootNum === '0003')?.active).toBe(true);
  });

  it('flags USB-ish entries as candidates', () => {
    const p = parseEfibootmgr(WITH_ACTIVE_USB);
    expect(p.candidates.map(c => c.bootNum)).toContain('0003');
  });
});

describe('assessUsbBootReadiness', () => {
  it('ready when an active USB/removable entry exists', () => {
    const r = assessUsbBootReadiness(parseEfibootmgr(WITH_ACTIVE_USB));
    expect(r.reinstallReady).toBe(true);
    expect(r.activeUsbEntries.map(e => e.bootNum)).toEqual(['0003']);
    expect(r.hint).toBeUndefined();
  });

  it('not ready + hints to activate when a USB entry exists but is inactive', () => {
    const r = assessUsbBootReadiness(parseEfibootmgr(INACTIVE_USB));
    expect(r.reinstallReady).toBe(false);
    expect(r.usbCandidates.map(e => e.bootNum)).toEqual(['0007']);
    expect(r.hint).toMatch(/inactive/i);
  });

  it('not ready + hints to insert media when no USB entry exists', () => {
    const r = assessUsbBootReadiness(parseEfibootmgr(NO_USB));
    expect(r.reinstallReady).toBe(false);
    expect(r.usbCandidates).toHaveLength(0);
    expect(r.hint).toMatch(/insert the installation usb/i);
  });
});

// #1674 — a multi-slot card reader: /dev/sda is the internal disk, /dev/sdb is
// the real FCoS installer USB (fedora-coreos + EFI-SYSTEM labels), /dev/sdc..sde
// are empty card-reader slots. The mapping must pick /dev/sdb, not a slot.
const LSBLK_MULTISLOT = JSON.stringify({
  blockdevices: [
    {
      name: 'sda', path: '/dev/sda', type: 'disk', label: null,
      children: [
        { name: 'sda1', path: '/dev/sda1', type: 'part', label: 'boot' },
        { name: 'sda2', path: '/dev/sda2', type: 'part', label: 'root' },
      ],
    },
    {
      name: 'sdb', path: '/dev/sdb', type: 'disk', label: 'fedora-coreos-installer',
      children: [
        { name: 'sdb1', path: '/dev/sdb1', type: 'part', label: 'ISO' },
        { name: 'sdb2', path: '/dev/sdb2', type: 'part', label: 'EFI-SYSTEM' },
      ],
    },
    { name: 'sdc', path: '/dev/sdc', type: 'disk', label: null }, // empty slot
    { name: 'sdd', path: '/dev/sdd', type: 'disk', label: null }, // empty slot
  ],
});

describe('selectInstallerBootDevice (#1674)', () => {
  it('picks the disk carrying the fedora-coreos / EFI-SYSTEM labels, not an empty slot', () => {
    const d = selectInstallerBootDevice(LSBLK_MULTISLOT);
    expect(d?.disk).toBe('/dev/sdb');
    expect(d?.efiPartNum).toBe(2);
    expect(d?.efiPart).toBe('/dev/sdb2');
  });

  it('returns null when no installer device is present (no media inserted)', () => {
    const noInstaller = JSON.stringify({
      blockdevices: [
        { name: 'sda', path: '/dev/sda', type: 'disk', children: [{ name: 'sda1', type: 'part', label: 'root' }] },
        { name: 'sdc', path: '/dev/sdc', type: 'disk', label: null }, // empty slot only
      ],
    });
    expect(selectInstallerBootDevice(noInstaller)).toBeNull();
  });

  it('returns null on malformed lsblk output', () => {
    expect(selectInstallerBootDevice('not json')).toBeNull();
  });
});

describe('planUsbBoot (#1674)', () => {
  it('creates a direct device entry when the installer device is found', () => {
    const device = selectInstallerBootDevice(LSBLK_MULTISLOT);
    const plan = planUsbBoot(parseEfibootmgr(NO_USB), device);
    expect(plan.mode).toBe('create');
    expect(plan.device?.disk).toBe('/dev/sdb');
    expect(plan.warning).toBeUndefined();
  });

  it('falls back to an ACTIVE existing UEFI entry without warning when no device is found', () => {
    const plan = planUsbBoot(parseEfibootmgr(WITH_ACTIVE_USB), null);
    expect(plan.mode).toBe('existingEntry');
    expect(plan.bootNum).toBe('0003');
    expect(plan.warning).toBeUndefined();
  });

  it('WARNS about an empty slot when the only removable entry is inactive', () => {
    const plan = planUsbBoot(parseEfibootmgr(INACTIVE_USB), null);
    expect(plan.mode).toBe('existingEntry');
    expect(plan.bootNum).toBe('0007');
    expect(plan.warning).toMatch(/empty card-reader slot/i);
  });

  it('warns with no usable target when neither a device nor a removable entry exists', () => {
    const plan = planUsbBoot(parseEfibootmgr(NO_USB), null);
    expect(plan.mode).toBe('none');
    expect(plan.warning).toMatch(/insert the install usb/i);
  });
});
