/**
 * `raid` probe (#2526).
 *
 * Every fixture below is verbatim-shaped `/proc/mdstat` output, not an
 * invented format — the DEGRADED one mirrors the owner's box (single
 * 1.8 TiB NVMe data disk, array created with `missing` in slot 1, running
 * `[2/1] [U_]` since install), and the healthy/failed/rebuilding ones are
 * the same layout with the member set the kernel would actually print.
 */
import { describe, it, expect } from 'vitest';
import { parseMdstat, evaluateRaidHealth } from './raidDegraded';

/** The real shape on a box whose RAID1 was created with `missing`. */
const MDSTAT_DEGRADED = `Personalities : [raid1]
md127 : active raid1 nvme0n1p1[0]
      1953381440 blocks super 1.2 [2/1] [U_]
      bitmap: 0/15 pages [0KB], 65536KB chunk

unused devices: <none>
`;

/** Same array once a second disk has been added and synced. */
const MDSTAT_HEALTHY = `Personalities : [raid1]
md127 : active raid1 nvme1n1p1[1] nvme0n1p1[0]
      1953381440 blocks super 1.2 [2/2] [UU]
      bitmap: 1/15 pages [4KB], 65536KB chunk

unused devices: <none>
`;

/** A member the kernel kicked out — the case that really is a dead disk. */
const MDSTAT_FAILED_MEMBER = `Personalities : [raid1]
md127 : active raid1 nvme1n1p1[1](F) nvme0n1p1[0]
      1953381440 blocks super 1.2 [2/1] [U_]
      bitmap: 3/15 pages [12KB], 65536KB chunk

unused devices: <none>
`;

/** A replacement disk syncing back in. */
const MDSTAT_REBUILDING = `Personalities : [raid1]
md127 : active raid1 nvme1n1p1[2] nvme0n1p1[0]
      1953381440 blocks super 1.2 [2/1] [U_]
      [==>..................]  recovery = 12.3% (240512/1953381440) finish=88.2min speed=369088K/sec
      bitmap: 5/15 pages [20KB], 65536KB chunk

unused devices: <none>
`;

/** A box with no md arrays at all (plain disk / LVM install). */
const MDSTAT_NO_ARRAYS = `Personalities : [raid1]
unused devices: <none>
`;

describe('parseMdstat', () => {
  it('parses the degraded single-member array', () => {
    const [array] = parseMdstat(MDSTAT_DEGRADED);
    expect(array.device).toBe('md127');
    expect(array.state).toBe('active');
    expect(array.level).toBe('raid1');
    expect(array.members).toEqual([{ name: 'nvme0n1p1', slot: 0, flags: [] }]);
    expect(array.totalSlots).toBe(2);
    expect(array.activeSlots).toBe(1);
    expect(array.slotMap).toBe('U_');
    expect(array.rebuilding).toBe(false);
  });

  it('parses the healthy two-member array', () => {
    const [array] = parseMdstat(MDSTAT_HEALTHY);
    expect(array.members.map(m => m.name)).toEqual(['nvme1n1p1', 'nvme0n1p1']);
    expect(array.totalSlots).toBe(2);
    expect(array.activeSlots).toBe(2);
    expect(array.slotMap).toBe('UU');
  });

  it('reads the (F) flag off a kicked-out member', () => {
    const [array] = parseMdstat(MDSTAT_FAILED_MEMBER);
    expect(array.members.find(m => m.name === 'nvme1n1p1')?.flags).toEqual(['F']);
  });

  it('detects an in-progress recovery and keeps its progress line', () => {
    const [array] = parseMdstat(MDSTAT_REBUILDING);
    expect(array.rebuilding).toBe(true);
    expect(array.rebuildDetail).toContain('recovery = 12.3%');
  });

  it('returns no arrays when the box has none', () => {
    expect(parseMdstat(MDSTAT_NO_ARRAYS)).toEqual([]);
  });

  it('parses an inactive array with no personality', () => {
    const [array] = parseMdstat('md0 : inactive nvme0n1p1[0](S)\n      1953381440 blocks super 1.2\n');
    expect(array.state).toBe('inactive');
    expect(array.level).toBeNull();
    expect(array.members[0]).toEqual({ name: 'nvme0n1p1', slot: 0, flags: ['S'] });
  });
});

describe('evaluateRaidHealth — degraded array', () => {
  const result = evaluateRaidHealth(MDSTAT_DEGRADED, 0);

  it('warns rather than staying silent', () => {
    expect(result.status).toBe('warn');
  });

  it('names the array, the missing slot and the loss of redundancy', () => {
    expect(result.detail).toContain('md127');
    expect(result.detail).toContain('1 of 2 members present');
    expect(result.detail).toContain('[U_]');
    expect(result.detail).toMatch(/DEGRADED/);
    expect(result.detail).toContain('slot 1 empty');
  });

  it('explains that the empty slot may be the deliberate `missing` member, not a dead disk', () => {
    expect(result.hint).toContain('setup-raid.sh');
    expect(result.hint).toContain('missing');
    expect(result.hint).toContain('mdadm --detail');
    expect(result.hint).toContain('Failed Devices: 0');
  });

  it('emits one row for the unhealthy array so the UI can list it', () => {
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0]).toMatchObject({ id: 'md127', status: 'warn', actionIds: [] });
  });
});

describe('evaluateRaidHealth — healthy array makes no noise', () => {
  const result = evaluateRaidHealth(MDSTAT_HEALTHY, 0);

  it('is ok', () => {
    expect(result.status).toBe('ok');
  });

  it('carries no hint and no findings', () => {
    expect(result.hint).toBeUndefined();
    expect(result.items).toBeUndefined();
  });

  it('still reports the array so the operator can see it was checked', () => {
    expect(result.detail).toContain('md127');
    expect(result.detail).toContain('all members present');
  });
});

describe('evaluateRaidHealth — other shapes', () => {
  it('escalates a kernel-marked failed member to fail', () => {
    const result = evaluateRaidHealth(MDSTAT_FAILED_MEMBER, 0);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('nvme1n1p1');
    expect(result.detail).toContain('FAILED');
  });

  it('reports a rebuild as a transient warn with its progress', () => {
    const result = evaluateRaidHealth(MDSTAT_REBUILDING, 0);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('rebuilding');
    expect(result.detail).toContain('12.3%');
  });

  it('stays info-only on a box with no md arrays', () => {
    const result = evaluateRaidHealth(MDSTAT_NO_ARRAYS, 0);
    expect(result.status).toBe('info');
    expect(result.hint).toBeUndefined();
  });

  it('says so honestly when /proc/mdstat could not be read', () => {
    const result = evaluateRaidHealth('', 1);
    expect(result.status).toBe('info');
    expect(result.detail).toContain('Could not read /proc/mdstat');
  });

  it('reports an unassembled array as a failure', () => {
    const result = evaluateRaidHealth('md0 : inactive nvme0n1p1[0](S)\n      1953381440 blocks super 1.2\n', 0);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('inactive');
  });

  it('leads with the unhealthy array when a healthy one is also present', () => {
    const both = `Personalities : [raid1]
md126 : active raid1 sdb1[1] sda1[0]
      488254464 blocks super 1.2 [2/2] [UU]

md127 : active raid1 nvme0n1p1[0]
      1953381440 blocks super 1.2 [2/1] [U_]

unused devices: <none>
`;
    const result = evaluateRaidHealth(both, 0);
    expect(result.status).toBe('warn');
    expect(result.detail.split('\n')[0]).toContain('md127');
    expect(result.items).toHaveLength(1);
  });
});
