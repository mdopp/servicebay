/**
 * Deriving a mount's outcome from what actually happened (#2626).
 *
 * `POST /api/system/storage` mounts the data array the wizard detected and
 * then writes the systemd units that re-mount it on boot. Before this module
 * the route reported `{ mounted: true, persistent: true }` as an *intent*: the
 * `mount` exit code was checked, but nothing verified that the mountpoint was
 * afterwards actually backed by that device, and the three unit-writing steps'
 * exit codes were discarded entirely. A box that answered "success" could be
 * one where nothing was mounted and no unit was written — and every service
 * installed after it wrote its data to the boot disk.
 *
 * Same shape as `summariseIncompleteRun` in `lib/install/runner.ts`: the
 * verdict is computed from observed results, the report leads with the
 * denominator, and it names what did NOT happen.
 *
 * Direction of error, deliberately: an install that is refused is recoverable,
 * an install onto the wrong disk is not. So an *unverifiable* mount counts as
 * a failed mount — `findmnt` returning nothing is a stop, not a shrug.
 */

/** One `agent.sendCommand('exec', …)` result, reduced to what we judge on. */
export interface MountStep {
  /** Operator-facing name of the step, used verbatim in the report. */
  name: string;
  code: number;
  stderr?: string;
}

export type MountVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/** Strip a trailing `[/subvol]` suffix and surrounding whitespace from a
 *  `findmnt -o SOURCE` value (btrfs subvolumes render as `/dev/sda1[/@]`). */
const normalizeSource = (raw: string): string => raw.trim().split('\n')[0].trim().replace(/\[.*\]$/, '');

/**
 * Did the device really end up mounted at the mountpoint?
 *
 * `findmnt --target <path>` answers for the *effective* filesystem at that
 * path — when the mount silently did not take it reports the parent's device
 * (`/dev/nvme…p4` for `/var/mnt/data` on a CoreOS box), which is exactly the
 * wrong-disk case we must catch. An empty/failed `findmnt` is treated as
 * unverified, i.e. failed.
 */
export function mountVerdict(input: {
  mountCode: number;
  mountStderr?: string;
  findmntCode: number;
  findmntSource: string;
  device: string;
  label?: string;
}): MountVerdict {
  const { mountCode, mountStderr, findmntCode, findmntSource, device, label } = input;

  if (mountCode !== 0) {
    const detail = (mountStderr ?? '').trim();
    return { ok: false, reason: `mount exited ${mountCode}${detail ? `: ${detail}` : ''}` };
  }

  const source = normalizeSource(findmntSource ?? '');
  if (findmntCode !== 0 || source === '') {
    return {
      ok: false,
      reason:
        `mount reported success but the mount could not be verified — findmnt returned nothing for the mountpoint. ` +
        `Treating an unverifiable mount as a failed one: the alternative is installing onto an unknown disk.`,
    };
  }

  const accepted = [device, label ? `/dev/disk/by-label/${label}` : null].filter(Boolean) as string[];
  if (!accepted.includes(source)) {
    return {
      ok: false,
      reason:
        `mount reported success but the mountpoint is backed by ${source}, not ${device} — ` +
        `the mount did not take, so data written there would land on ${source}.`,
    };
  }

  return { ok: true };
}

export interface PersistenceOutcome {
  /** True only when every boot-persistence step actually succeeded. */
  persistent: boolean;
  /** Names of the steps that did NOT complete. Empty when persistent. */
  incomplete: string[];
  /** Denominator-first, names what did not happen. */
  summary: string;
}

/**
 * Was the mount made to survive a reboot? Derived from the steps' exit codes,
 * never assumed. A live mount with no boot unit is a real, named state — not
 * "done", and not a failure either (the data does land on the right disk now),
 * so the caller reports it and lets the operator decide.
 */
export function summarisePersistence(steps: ReadonlyArray<MountStep>): PersistenceOutcome {
  const incomplete = steps.filter(s => s.code !== 0);
  const total = steps.length;
  const done = total - incomplete.length;
  if (incomplete.length === 0) {
    return {
      persistent: true,
      incomplete: [],
      summary: `✅ ${done}/${total} boot-persistence step(s) completed — the mount is set up to come back after a reboot.`,
    };
  }
  const named = incomplete
    .map(s => `${s.name} (exit ${s.code}${(s.stderr ?? '').trim() ? `: ${(s.stderr ?? '').trim()}` : ''})`)
    .join('; ');
  return {
    persistent: false,
    incomplete: incomplete.map(s => s.name),
    summary:
      `⚠️ ${done}/${total} boot-persistence step(s) completed. NOT done: ${named}. ` +
      `The array is mounted right now, but it is not guaranteed to be mounted after a reboot.`,
  };
}
