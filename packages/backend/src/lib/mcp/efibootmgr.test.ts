import { describe, it, expect } from 'vitest';
import { parseEfibootmgr, assessUsbBootReadiness } from './efibootmgr';

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
