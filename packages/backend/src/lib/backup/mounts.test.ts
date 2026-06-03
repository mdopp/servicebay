import { describe, it, expect } from 'vitest';
import { parseMountCandidates } from './mounts';

describe('parseMountCandidates', () => {
  it('returns mounted filesystems with size/free/mountpoint (byte sizes humanized)', () => {
    const json = JSON.stringify({
      blockdevices: [
        {
          name: 'sda',
          path: '/dev/sda',
          type: 'disk',
          size: '4000787030016',
          children: [
            {
              name: 'sda1',
              path: '/dev/sda1',
              type: 'part',
              size: '4000785981440',
              fstype: 'ext4',
              label: 'backup',
              mountpoint: '/mnt/backup',
              fsavail: '3865470566400',
              'fsuse%': '3%',
            },
          ],
        },
      ],
    });
    const out = parseMountCandidates(json);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.device).toBe('/dev/sda1');
    expect(m.label).toBe('backup');
    expect(m.fstype).toBe('ext4');
    expect(m.mountpoint).toBe('/mnt/backup');
    expect(m.mounted).toBe(true);
    // -b byte counts get humanized
    expect(m.size).toBe('3.6T');
    expect(m.fsAvail).toBe('3.5T');
    expect(m.fsUsedPct).toBe('3%');
  });

  it('includes unmounted filesystems flagged mounted:false with no free-space fields', () => {
    const json = JSON.stringify({
      blockdevices: [
        {
          name: 'sdb1',
          path: '/dev/sdb1',
          type: 'part',
          size: '64000000000',
          fstype: 'vfat',
          label: 'USB',
          mountpoint: null,
          fsavail: null,
          'fsuse%': null,
        },
      ],
    });
    const [m] = parseMountCandidates(json);
    expect(m.device).toBe('/dev/sdb1');
    expect(m.mounted).toBe(false);
    expect(m.mountpoint).toBeNull();
    expect(m.fsAvail).toBeUndefined();
    expect(m.fsUsedPct).toBeUndefined();
    expect(m.fstype).toBe('vfat');
  });

  it('skips RAID/LVM member pseudo-filesystems but keeps the mounted md device', () => {
    const json = JSON.stringify({
      blockdevices: [
        {
          name: 'sdc',
          path: '/dev/sdc',
          type: 'disk',
          size: '4000787030016',
          fstype: 'linux_raid_member', // member — not a target
          mountpoint: null,
          children: [
            {
              name: 'md127',
              path: '/dev/md127',
              type: 'raid1',
              size: '4000000000000',
              fstype: 'xfs',
              label: 'data',
              mountpoint: '/mnt/data',
              fsavail: '1000000000000',
              'fsuse%': '75%',
            },
          ],
        },
      ],
    });
    const out = parseMountCandidates(json);
    expect(out.map(m => m.device)).toEqual(['/dev/md127']);
    expect(out[0].mounted).toBe(true);
    expect(out[0].mountpoint).toBe('/mnt/data');
  });

  it('handles human-readable lsblk output (no -b) without re-humanizing', () => {
    const json = JSON.stringify({
      blockdevices: [
        {
          name: 'sda1',
          type: 'part',
          size: '3.6T',
          fstype: 'ext4',
          mountpoint: '/mnt/backup',
        },
      ],
    });
    const [m] = parseMountCandidates(json);
    expect(m.device).toBe('/dev/sda1');
    expect(m.size).toBe('3.6T');
  });

  it('returns [] for empty, malformed, or device-only (no filesystem) output', () => {
    expect(parseMountCandidates('{"blockdevices":[]}')).toEqual([]);
    expect(parseMountCandidates('not json')).toEqual([]);
    expect(parseMountCandidates('')).toEqual([]);
    // a bare disk with no fstype and no mountpoint is not a target
    const noFs = JSON.stringify({
      blockdevices: [{ name: 'sde', type: 'disk', size: '1000', mountpoint: null }],
    });
    expect(parseMountCandidates(noFs)).toEqual([]);
  });

  it('dedupes a device that appears more than once', () => {
    const json = JSON.stringify({
      blockdevices: [
        { name: 'sda1', path: '/dev/sda1', type: 'part', fstype: 'ext4', mountpoint: '/mnt/backup' },
        { name: 'sda1', path: '/dev/sda1', type: 'part', fstype: 'ext4', mountpoint: '/mnt/backup' },
      ],
    });
    expect(parseMountCandidates(json)).toHaveLength(1);
  });

  it('humanizes integer byte counts from lsblk -b (real-world JSON integers, not strings)', () => {
    // lsblk -b returns actual JSON integers for size/fsavail, not decimal strings.
    // Regression: looksLikeBytes missed integer sizes; trim() returned undefined for numbers.
    const json = JSON.stringify({
      blockdevices: [
        {
          name: 'nvme0n1',
          path: '/dev/nvme0n1',
          type: 'disk',
          size: 2000398934016,       // integer — real lsblk -b output
          fstype: null,
          mountpoint: null,
          children: [
            {
              name: 'md127',
              path: '/dev/md127',
              type: 'raid1',
              size: 2000262594560,   // integer
              fstype: 'xfs',
              label: 'data',
              mountpoint: '/var/mnt/data',
              fsavail: 1892842528768, // integer — was always undefined before fix
              'fsuse%': '5%',
            },
          ],
        },
      ],
    });
    const out = parseMountCandidates(json);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.device).toBe('/dev/md127');
    expect(m.mounted).toBe(true);
    // Both size and fsAvail must be humanized from integer bytes
    expect(m.size).toBe('1.8T');
    expect(m.fsAvail).toBe('1.7T');
    expect(m.fsUsedPct).toBe('5%');
  });
});
