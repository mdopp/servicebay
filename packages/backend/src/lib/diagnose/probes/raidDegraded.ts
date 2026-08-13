/**
 * `raid` probe (#2526) — is the /mnt/data software-RAID array actually
 * running with every member it declares?
 *
 * Nothing on the box surfaced this before. `mdmonitor` only fires on a
 * *failure event*, so an array that was created without its second member
 * never triggers it; the weekly `raid-check` reports `mismatch_cnt=0` on a
 * degraded array and reads as "all fine"; and `df` (the `disk` probe) is
 * happy because the filesystem mounts and has space. A box can therefore
 * run with zero redundancy for months and look healthy from every angle.
 *
 * The added wrinkle is that ServiceBay *deliberately* creates the array
 * degraded on a single-data-disk box: first-boot `setup-raid.sh`
 * (`tools/sb/internal/build/assets/fedora-coreos.bu`) passes the literal
 * keyword `missing` as the second member so a mirror can be added later
 * without rebuilding. From outside, day-one-never-had-a-mirror and
 * a-disk-died-last-night both render as `[2/1] [U_]`. So the probe does
 * two things: it says the array has no redundancy, and it tells the
 * operator how to tell those two apart before attempting a "repair" that
 * can't work.
 *
 * Detection reads `/proc/mdstat` — the kernel's own view, no mdadm
 * invocation and no privileges needed. The parse + verdict are pure
 * functions so both shapes are unit-testable without a host.
 */

import type { ProbeItem } from '../actions';

export const PROBE_ID = 'raid';
export const PROBE_LABEL = 'RAID array';

/** One member device line-item of an md array, as `/proc/mdstat` lists it. */
export interface MdMember {
  /** Block device name, e.g. `nvme0n1p1`. */
  name: string;
  /** Slot index from the `[N]` suffix, or null when unparseable. */
  slot: number | null;
  /** Single-letter flags from the trailing parens: `F` failed, `S` spare,
   *  `W` write-mostly, `R` replacement. */
  flags: string[];
}

/** One array block of `/proc/mdstat`. */
export interface MdArray {
  /** Kernel device name, e.g. `md127`. */
  device: string;
  /** `active` / `inactive` — the word right after the colon. */
  state: string;
  /** RAID personality (`raid1`, `raid5`, …), or null on an inactive array
   *  that the kernel never assembled far enough to name one. */
  level: string | null;
  members: MdMember[];
  /** Declared member count, from `[total/active]`. Null when the array has
   *  no status line (inactive arrays often don't). */
  totalSlots: number | null;
  /** Members currently up, from `[total/active]`. */
  activeSlots: number | null;
  /** The `[U_]` map: `U` = slot up, `_` = slot down. Null when absent. */
  slotMap: string | null;
  /** A resync/recovery/reshape is in progress on this array. */
  rebuilding: boolean;
  /** The raw progress line when `rebuilding`, e.g.
   *  `recovery = 12.3% (240512/1953381440) finish=88.2min speed=369088K/sec`. */
  rebuildDetail: string | null;
}

/** `[total/active]` + `[UU_]` on the block-count line under an array header. */
const STATUS_LINE = /\[(\d+)\/(\d+)\]\s+\[([U_]+)\]/;
/** `recovery = 12.3% …` / `resync = …` / `reshape = …` / `check = …`. */
const REBUILD_LINE = /\b(recovery|resync|reshape|check|repair)\s*=/;
/** A member token: `nvme0n1p1[0]`, `sdb1[1](F)`, `sdc1[2](S)`. */
const MEMBER_TOKEN = /^(.+?)\[(\d+)\]((?:\([A-Z]\))*)$/;

function parseMember(token: string): MdMember | null {
  const m = MEMBER_TOKEN.exec(token);
  if (!m) return null;
  const flags = (m[3].match(/\(([A-Z])\)/g) ?? []).map(f => f.slice(1, -1));
  return { name: m[1], slot: Number.parseInt(m[2], 10), flags };
}

/**
 * Parse `/proc/mdstat` into its array blocks. Tolerant by design: an
 * unrecognised line is skipped rather than throwing, because this file's
 * exact layout varies with personality, bitmap presence and kernel
 * version, and a parse hiccup must never take down the diagnose run.
 */
export function parseMdstat(raw: string): MdArray[] {
  const arrays: MdArray[] = [];
  let current: MdArray | null = null;

  for (const line of (raw ?? '').split('\n')) {
    const header = /^(md\d+)\s*:\s*(.*)$/.exec(line.trim());
    if (header) {
      const tokens = header[2].split(/\s+/).filter(Boolean);
      const state = tokens.shift() ?? 'unknown';
      // `active (auto-read-only) raid1 …` — the parenthesised qualifier
      // sits between the state and the personality.
      if (tokens[0]?.startsWith('(')) tokens.shift();
      // An inactive array may list members with no personality at all, so
      // only treat the next token as the level when it isn't a member.
      const level = tokens[0] && !MEMBER_TOKEN.test(tokens[0]) ? tokens.shift() ?? null : null;
      current = {
        device: header[1],
        state,
        level,
        members: tokens.map(parseMember).filter((m): m is MdMember => m !== null),
        totalSlots: null,
        activeSlots: null,
        slotMap: null,
        rebuilding: false,
        rebuildDetail: null,
      };
      arrays.push(current);
      continue;
    }

    if (!current) continue;
    // A blank line closes the array block (`unused devices:` etc. follow).
    if (line.trim() === '') {
      current = null;
      continue;
    }
    const status = STATUS_LINE.exec(line);
    if (status) {
      current.totalSlots = Number.parseInt(status[1], 10);
      current.activeSlots = Number.parseInt(status[2], 10);
      current.slotMap = status[3];
      continue;
    }
    if (REBUILD_LINE.test(line)) {
      current.rebuilding = true;
      current.rebuildDetail = line.trim().replace(/^\[[=>.]+\]\s*/, '');
    }
  }

  return arrays;
}

/** Slot indices reported down by the `[U_]` map. */
function downSlots(array: MdArray): number[] {
  if (!array.slotMap) return [];
  return [...array.slotMap].flatMap((c, i) => (c === '_' ? [i] : []));
}

function describeArray(array: MdArray): string {
  const level = array.level ? ` (${array.level})` : '';
  const counts =
    array.totalSlots !== null && array.activeSlots !== null
      ? `${array.activeSlots} of ${array.totalSlots} members present`
      : 'member count unknown';
  const map = array.slotMap ? ` [${array.slotMap}]` : '';
  return `${array.device}${level}: ${counts}${map}`;
}

export type RaidProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface RaidProbeResult {
  status: RaidProbeStatus;
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

/**
 * How to tell "the mirror was never populated" from "a disk dropped out".
 * This is the whole reason the probe exists — `[U_]` alone reads as a dead
 * disk and invites an `mdadm --add` against hardware that isn't there.
 */
const DEGRADED_HINT =
  'An empty slot does NOT automatically mean a disk failed. ServiceBay\'s first-boot setup-raid.sh ' +
  'creates the data array as a RAID1 whose second member is the literal keyword `missing` ' +
  '(tools/sb/internal/build/assets/fedora-coreos.bu), so a box built with a single data disk has read ' +
  '[U_] since the day it was installed and mdmonitor will never fire — no failure event ever happened. ' +
  'Tell the two apart with `mdadm --detail /dev/<md>`: "Failed Devices: 0" plus a Creation Time matching ' +
  'your install date means the mirror was never populated; a non-zero failed count or a recent event ' +
  'means a disk really dropped out. The fix is the same either way — add a disk at least as large as the ' +
  'array\'s member size and run `mdadm --manage /dev/<md> --add /dev/<partition>` from a shell on the box. ' +
  'ServiceBay never changes array membership for you: that rewrites a disk and is an operator decision.';

/** Per-array verdict, worst-first: a member the kernel marked failed is a
 *  real fault; a simply-absent member is "no redundancy" (which may be
 *  by design), and a rebuild in progress is transient. */
function verdictForArray(array: MdArray): { status: RaidProbeStatus; detail: string } {
  if (array.state !== 'active') {
    return {
      status: 'fail',
      detail: `${array.device} is ${array.state} — the kernel has not assembled it, so anything mounted from it is unavailable.`,
    };
  }
  if (array.totalSlots === null || array.activeSlots === null) {
    return { status: 'info', detail: `${describeArray(array)} — no member counts reported.` };
  }
  const failed = array.members.filter(m => m.flags.includes('F'));
  if (failed.length > 0) {
    return {
      status: 'fail',
      detail:
        `${describeArray(array)} — the kernel marked ${failed.map(m => m.name).join(', ')} FAILED. ` +
        'A disk really dropped out of this array.',
    };
  }
  if (array.activeSlots < array.totalSlots) {
    const down = downSlots(array);
    const present = array.members.map(m => m.name).join(', ') || 'none';
    const slots = down.length > 0 ? `slot${down.length === 1 ? '' : 's'} ${down.join(', ')}` : 'a slot';
    if (array.rebuilding) {
      return {
        status: 'warn',
        detail:
          `${describeArray(array)} — rebuilding onto ${slots}: ${array.rebuildDetail ?? 'in progress'}. ` +
          'Redundancy returns when it finishes.',
      };
    }
    return {
      status: 'warn',
      detail:
        `${describeArray(array)} — running DEGRADED with no redundancy. Present: ${present}; ${slots} empty, ` +
        'with nothing marked failed. If the remaining disk dies, the data on it is gone.',
    };
  }
  return { status: 'ok', detail: `${describeArray(array)} — all members present.` };
}

const SEVERITY: Record<RaidProbeStatus, number> = { ok: 0, info: 1, warn: 2, fail: 3 };

/**
 * Pure verdict over a raw `/proc/mdstat` read. `execCode` is the exit code
 * of the read itself so an unreadable file is reported honestly instead of
 * being mistaken for "no arrays".
 */
export function evaluateRaidHealth(raw: string, execCode: number | undefined): RaidProbeResult {
  if (execCode !== 0) {
    return {
      status: 'info',
      detail: 'Could not read /proc/mdstat, so array health is unknown.',
    };
  }

  const arrays = parseMdstat(raw);
  if (arrays.length === 0) {
    // Not every box uses md — a single-disk install without setup-raid, or
    // storage on LVM/ZFS. Silence, not a warning.
    return {
      status: 'info',
      detail: 'No software RAID array on this box — /proc/mdstat lists none.',
    };
  }

  const verdicts = arrays.map(array => ({ array, ...verdictForArray(array) }));
  const worst = verdicts.reduce<RaidProbeStatus>(
    (acc, v) => (SEVERITY[v.status] > SEVERITY[acc] ? v.status : acc),
    'ok',
  );
  const unhealthy = verdicts.filter(v => v.status === 'warn' || v.status === 'fail');

  if (unhealthy.length === 0) {
    return {
      status: worst,
      detail: verdicts.map(v => v.detail).join('\n'),
    };
  }

  return {
    status: worst,
    // Lead with the arrays that need attention; a healthy sibling array
    // shouldn't push the problem below the fold.
    detail: [...unhealthy, ...verdicts.filter(v => !unhealthy.includes(v))].map(v => v.detail).join('\n'),
    hint: DEGRADED_HINT,
    items: unhealthy.map(v => ({
      id: v.array.device,
      label: `${v.array.device}${v.array.level ? ` (${v.array.level})` : ''}`,
      detail: v.detail,
      status: v.status === 'fail' ? ('fail' as const) : ('warn' as const),
      // Read-only row: adding a mirror rewrites a physical disk, so there
      // is deliberately no one-click repair here (see DEGRADED_HINT).
      actionIds: [],
    })),
  };
}
